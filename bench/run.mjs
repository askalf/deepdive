#!/usr/bin/env node
// Quality bench harness. Runs the golden questions in bench/questions.json
// through the built CLI (`npm run build` first) against a LIVE LLM endpoint
// and live search/web — this is a manual dev tool, deliberately not wired
// into CI. Purpose: a structural quality baseline before prompt changes and
// a regression check after; planner/synth prompts are the highest-leverage
// knobs in the project and can't be tuned blind.
//
//   node bench/run.mjs                  # all questions
//   node bench/run.mjs --only=academic  # one question
//   node bench/run.mjs --list           # list questions, run nothing
//   node bench/run.mjs --out=bench/results/2026-06-11.md
//
// Scoring is structural, not semantic: did the run complete, ground itself
// in enough sources, survive the lexical citation verifier, mention the
// topical keywords, and stay under the cost ceiling. A PASS here is a floor,
// not proof of a good answer — read the reports when comparing prompts.
//
// Zero deps (node built-ins only), zero LLM calls of its own.

import { spawn } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CLI = join(here, "..", "dist", "cli.js");

// ── pure scoring (imported by test/bench-score.test.mjs) ─────────────────────

// Gate names → human label. Order is the report's column order.
export const GATES = [
  ["completed", "run completed"],
  ["sources", "enough sources"],
  ["support", "citation support"],
  ["length", "answer length"],
  ["keywords", "topical keywords"],
  ["cost", "under cost ceiling"],
];

// Merge file-level defaults into one question's spec.
export function effectiveSpec(q, defaults) {
  return {
    minSources: q.minSources ?? defaults.minSources,
    minSupportRatio: q.minSupportRatio ?? defaults.minSupportRatio,
    minAnswerWords: q.minAnswerWords ?? defaults.minAnswerWords,
    maxCostUsd: q.maxCostUsd ?? defaults.maxCostUsd,
    expectKeywords: q.expectKeywords ?? [],
  };
}

// Score one run. `outcome` is { exitCode, json } where json is the parsed
// --json envelope (null when the run failed before emitting one). Returns
// { gates: {name: {pass, detail}}, pass } — pass is the AND of all gates.
export function scoreResult(outcome, spec) {
  const gates = {};
  const json = outcome.json;

  gates.completed = {
    pass: outcome.exitCode === 0 && json !== null,
    detail: outcome.exitCode === 0 ? "exit 0" : `exit ${outcome.exitCode}`,
  };

  const kept = json?.usage?.kept ?? 0;
  gates.sources = {
    pass: kept >= spec.minSources,
    detail: `${kept}/${spec.minSources}`,
  };

  const total = json?.usage?.citationsTotal ?? 0;
  const supported = json?.usage?.citationsSupported ?? 0;
  const ratio = total > 0 ? supported / total : 0;
  gates.support = {
    pass: total > 0 && ratio >= spec.minSupportRatio,
    detail: total > 0 ? `${supported}/${total} (${ratio.toFixed(2)})` : "no citations",
  };

  const words = json?.answer ? json.answer.split(/\s+/).filter(Boolean).length : 0;
  gates.length = {
    pass: words >= spec.minAnswerWords,
    detail: `${words} words`,
  };

  const answerLower = (json?.answer ?? "").toLowerCase();
  const missing = spec.expectKeywords.filter((k) => !answerLower.includes(k.toLowerCase()));
  gates.keywords = {
    pass: missing.length === 0,
    detail: missing.length === 0 ? "all present" : `missing: ${missing.join(", ")}`,
  };

  const cost = json?.usage?.estimatedCostUsd ?? 0;
  gates.cost = {
    pass: cost <= spec.maxCostUsd,
    detail: `$${cost.toFixed(3)} / $${spec.maxCostUsd.toFixed(2)}`,
  };

  return { gates, pass: Object.values(gates).every((g) => g.pass) };
}

// Render the scoreboard as github markdown.
export function renderScoreboard(rows, meta) {
  const lines = [];
  lines.push(`# deepdive bench — ${meta.date}`);
  lines.push("");
  lines.push(`model: \`${meta.model}\` · base-url: \`${meta.baseUrl}\` · deepdive v${meta.version}`);
  lines.push("");
  const header = ["question", ...GATES.map(([, label]) => label), "verdict", "time"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const row of rows) {
    const cells = [row.id];
    for (const [name] of GATES) {
      const g = row.score.gates[name];
      cells.push(`${g.pass ? "✅" : "❌"} ${g.detail}`);
    }
    cells.push(row.score.pass ? "**PASS**" : "**FAIL**");
    cells.push(`${(row.durationMs / 1000).toFixed(0)}s`);
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const passed = rows.filter((r) => r.score.pass).length;
  lines.push("");
  lines.push(`**${passed}/${rows.length} passed.** Structural gates only — read the answers before trusting a comparison.`);
  return lines.join("\n") + "\n";
}

// ── runner ───────────────────────────────────────────────────────────────────

function runOne(q, extraArgs) {
  return new Promise((resolveRun) => {
    const args = [CLI, q.question, "--json", "--no-sessions", ...(q.args ?? []), ...extraArgs];
    const started = Date.now();
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (exitCode) => {
      let json = null;
      try {
        json = JSON.parse(stdout);
      } catch {
        /* run died before the envelope — completed gate fails */
      }
      resolveRun({ exitCode: exitCode ?? 1, json, stderr, durationMs: Date.now() - started });
    });
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length);
  const outPath = argv.find((a) => a.startsWith("--out="))?.slice("--out=".length);
  const list = argv.includes("--list");

  const file = JSON.parse(readFileSync(join(here, "questions.json"), "utf-8"));
  let questions = file.questions;
  if (only) {
    questions = questions.filter((q) => q.id === only);
    if (questions.length === 0) {
      console.error(`bench: no question with id "${only}" (have: ${file.questions.map((q) => q.id).join(", ")})`);
      process.exit(2);
    }
  }

  if (list) {
    for (const q of questions) console.log(`${q.id.padEnd(16)} [${q.shape}] ${q.question}`);
    return;
  }

  const version = await new Promise((res) => {
    const c = spawn(process.execPath, [CLI, "--version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    c.stdout.on("data", (d) => (out += d));
    c.on("close", () => res(out.trim() || "unknown"));
  });

  const meta = {
    date: new Date().toISOString().slice(0, 10),
    model: process.env.DEEPDIVE_MODEL ?? "claude-sonnet-4-6 (default)",
    baseUrl: process.env.DEEPDIVE_BASE_URL ?? "http://localhost:3456 (default)",
    version,
  };

  console.error(`bench: ${questions.length} question(s) · deepdive v${version}`);
  const rows = [];
  for (const q of questions) {
    console.error(`bench: running ${q.id} …`);
    const outcome = await runOne(q, []);
    const spec = effectiveSpec(q, file.defaults);
    const score = scoreResult(outcome, spec);
    rows.push({ id: q.id, score, durationMs: outcome.durationMs });
    const verdict = score.pass ? "PASS" : "FAIL";
    console.error(`bench: ${q.id} → ${verdict} (${(outcome.durationMs / 1000).toFixed(0)}s)`);
    if (!score.pass) {
      for (const [name] of GATES) {
        const g = score.gates[name];
        if (!g.pass) console.error(`bench:   ✗ ${name}: ${g.detail}`);
      }
      if (outcome.exitCode !== 0) {
        console.error(`bench:   stderr tail: ${outcome.stderr.split("\n").filter(Boolean).slice(-3).join(" · ")}`);
      }
    }
  }

  const report = renderScoreboard(rows, meta);
  if (outPath) {
    const p = resolve(outPath);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, report, "utf-8");
    console.error(`bench: wrote ${p}`);
  } else {
    console.log(report);
  }
  process.exit(rows.every((r) => r.score.pass) ? 0 : 1);
}

// Only run when invoked directly (the test imports the pure functions).
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
