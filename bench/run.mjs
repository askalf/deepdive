#!/usr/bin/env node
// Quality bench harness. Runs the golden questions in bench/questions.json
// through the built CLI (`npm run build` first) against a LIVE LLM endpoint
// and live search/web — this is a manual dev tool, deliberately not wired
// into CI. Purpose: a structural quality baseline before prompt changes and
// a regression check after; planner/synth prompts are the highest-leverage
// knobs in the project and can't be tuned blind.
//
//   DEEPDIVE_SEARXNG_URL=http://localhost:8081 node bench/run.mjs   # all questions
//   DEEPDIVE_SEARXNG_URL=… node bench/run.mjs --only=academic       # one question
//   node bench/run.mjs --list           # list questions, run nothing
//   DEEPDIVE_SEARXNG_URL=… node bench/run.mjs --out=bench/results/2026-06-11.md
//   DEEPDIVE_SEARXNG_URL=… node bench/run.mjs --authority-compare   # off vs prefer
//
// SOURCE AUTHORITY (#111 P3) — every scoreboard carries an `authority` column
// (the kept-source mix the CLI reports in --json: NP/NR/NU/NL · trust) plus an
// aggregate primary/reputable share. It's REPORTED, never gated — `unknown` is
// neutral and a niche topic legitimately has no primary sources. `--authority-
// compare` runs each question twice (--source-authority=off vs =prefer, the
// default) and prints the before/after shift: does preferring authority move
// sources from low/unknown toward primary/reputable? (Doubles the run count.)
//
// SEARCH BACKEND — the bench routes its general-web searches through SearXNG,
// not the CLI's default DuckDuckGo HTML adapter. DDG rate-limits the test box's
// IP and silently degrades to the wikipedia fallback, which makes prompt deltas
// unmeasurable (issue #97: stock factual-lookup scored 1/3 on DDG vs 3/3 on
// SearXNG, same prompt). The PRODUCT default stays DuckDuckGo — this override is
// bench-only. An explicit DEEPDIVE_SEARCH wins (set it to "duckduckgo" to
// reproduce the old behavior); otherwise SearXNG, which needs DEEPDIVE_SEARXNG_URL.
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
  const backend = meta.searchBackend ? ` · search: \`${meta.searchBackend}\`` : "";
  lines.push(`model: \`${meta.model}\` · base-url: \`${meta.baseUrl}\`${backend} · deepdive v${meta.version}`);
  lines.push("");
  const header = ["question", ...GATES.map(([, label]) => label), "authority", "verdict", "time"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const row of rows) {
    const cells = [row.id];
    for (const [name] of GATES) {
      const g = row.score.gates[name];
      cells.push(`${g.pass ? "✅" : "❌"} ${g.detail}`);
    }
    cells.push(fmtAuthority(row.authority));
    cells.push(row.score.pass ? "**PASS**" : "**FAIL**");
    cells.push(`${(row.durationMs / 1000).toFixed(0)}s`);
    lines.push(`| ${cells.join(" | ")} |`);
  }
  const passed = rows.filter((r) => r.score.pass).length;
  lines.push("");
  lines.push(`**${passed}/${rows.length} passed.** Structural gates only — read the answers before trusting a comparison.`);
  const dists = rows.map((r) => r.authority).filter(Boolean);
  if (dists.length) {
    const agg = aggregateAuthority(dists);
    const pct = Math.round(trustedShare(agg) * 100);
    lines.push("");
    lines.push(
      `**Source authority:** ${pct}% primary/reputable ` +
        `(${agg.primary + agg.reputable}/${agg.total} kept sources · ` +
        `${agg.primary}P ${agg.reputable}R ${agg.unknown}U ${agg.low}L). ` +
        `Reported, not gated — \`--authority-compare\` shows the off→prefer delta.`,
    );
  }
  return lines.join("\n") + "\n";
}

// ── source-authority distribution (P3 of #111) ───────────────────────────────
// The authority axis is REPORTED, never gated: `unknown` is neutral and a niche
// topic legitimately surfaces no primary sources, so failing a run on its source
// mix would punish exactly the long-tail deepdive exists to serve. We read the
// distribution the CLI already emits in `--json` (the `sourceTrust` summary and
// per-source `authority` tags from #111/#114), so the bench measures the real
// shipped signal and keeps its zero-dep promise.

const AUTH_TIERS = ["primary", "reputable", "unknown", "low"];

// Pull the kept-source authority distribution out of a `--json` envelope.
// Prefers the top-level `sourceTrust` summary; falls back to counting
// `sources[].authority.tier`; returns an all-zero dist (label null) when the
// run produced no envelope or predates the source-authority feature.
export function authorityOf(json) {
  const empty = { primary: 0, reputable: 0, unknown: 0, low: 0, total: 0, label: null };
  if (!json) return empty;
  if (json.sourceTrust?.counts) {
    const c = json.sourceTrust.counts;
    return {
      primary: c.primary ?? 0,
      reputable: c.reputable ?? 0,
      unknown: c.unknown ?? 0,
      low: c.low ?? 0,
      total: c.total ?? 0,
      label: json.sourceTrust.label ?? null,
    };
  }
  if (Array.isArray(json.sources)) {
    const dist = { ...empty };
    for (const s of json.sources) {
      const t = s?.authority?.tier;
      if (AUTH_TIERS.includes(t)) {
        dist[t]++;
        dist.total++;
      }
    }
    return dist;
  }
  return empty;
}

// Fraction of sources that are primary or reputable (the "trusted" share),
// 0..1; 0 when there are no sources.
export function trustedShare(dist) {
  return dist.total > 0 ? (dist.primary + dist.reputable) / dist.total : 0;
}

// Compact board cell: "3P 0R 1U 0L · high", or "—" when there's nothing to show.
export function fmtAuthority(dist) {
  if (!dist || dist.total === 0) return "—";
  const tiers = `${dist.primary}P ${dist.reputable}R ${dist.unknown}U ${dist.low}L`;
  return dist.label ? `${tiers} · ${dist.label}` : tiers;
}

// Sum a list of distributions into one aggregate (no label).
export function aggregateAuthority(dists) {
  const agg = { primary: 0, reputable: 0, unknown: 0, low: 0, total: 0 };
  for (const d of dists) {
    for (const t of AUTH_TIERS) agg[t] += d[t] ?? 0;
    agg.total += d.total ?? 0;
  }
  return agg;
}

// Before/after scoreboard for `--authority-compare`: each question run under
// --source-authority=off (raw search order) and =prefer (the default, which
// lets authoritative sources win the limited fetch slots). Reports the shift in
// the kept-source mix — the measurable claim behind the source-authority work:
// does preferring authority actually move sources from low/unknown toward
// primary/reputable? Informational only; no PASS/FAIL.
export function renderComparison(pairs, meta) {
  const lines = [];
  lines.push(`# deepdive bench — source authority (before/after) — ${meta.date}`);
  lines.push("");
  const backend = meta.searchBackend ? ` · search: \`${meta.searchBackend}\`` : "";
  lines.push(`model: \`${meta.model}\` · base-url: \`${meta.baseUrl}\`${backend} · deepdive v${meta.version}`);
  lines.push("");
  lines.push(
    "`--source-authority`: **off** (raw search order) → **prefer** " +
      "(default — authoritative sources win the limited fetch slots). " +
      "Cells: primary/reputable/unknown/low · trust. Informational, not gated.",
  );
  lines.push("");
  const header = ["question", "off", "prefer", "Δ prim+rep"];
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`|${header.map(() => "---").join("|")}|`);
  for (const p of pairs) {
    const delta = p.prefer.primary + p.prefer.reputable - (p.off.primary + p.off.reputable);
    const sign = delta > 0 ? `+${delta}` : `${delta}`;
    lines.push(`| ${p.id} | ${fmtAuthority(p.off)} | ${fmtAuthority(p.prefer)} | ${sign} |`);
  }
  const offAgg = aggregateAuthority(pairs.map((p) => p.off));
  const prefAgg = aggregateAuthority(pairs.map((p) => p.prefer));
  const offPct = Math.round(trustedShare(offAgg) * 100);
  const prefPct = Math.round(trustedShare(prefAgg) * 100);
  lines.push("");
  lines.push(
    `**Aggregate:** primary/reputable share **${offPct}% → ${prefPct}%** ` +
      `(off: ${offAgg.primary + offAgg.reputable}/${offAgg.total} · ` +
      `prefer: ${prefAgg.primary + prefAgg.reputable}/${prefAgg.total} kept sources). ` +
      `Δ counts sources that moved into the limited fetch slots; on a question where ` +
      `search returns no more candidates than slots, off and prefer match by design.`,
  );
  return lines.join("\n") + "\n";
}

// ── runner ───────────────────────────────────────────────────────────────────

// Resolve the bench's general-web search backend. An explicit DEEPDIVE_SEARCH
// wins (use "duckduckgo" to reproduce the pre-SearXNG behavior); otherwise
// SearXNG, which the CLI's searxng adapter reaches via DEEPDIVE_SEARXNG_URL.
// Returns null when neither is available — main() then errors with guidance.
export function resolveBackend(env) {
  if (env.DEEPDIVE_SEARCH) return env.DEEPDIVE_SEARCH;
  if (!env.DEEPDIVE_SEARXNG_URL) return null;
  return "searxng";
}

// Build the CLI args for one question, routing its general-web leg through
// `web`. A question's own --search wins, but its `duckduckgo` token is swapped
// for `web` so multi-adapter questions (academic, niche-ops) ride the same
// backend; questions with no --search get --search=<web> injected. Domain
// adapters (arxiv/openalex/stackexchange) and --since are left untouched.
// `authorityMode` (optional) appends --source-authority=<mode> for the
// before/after compare run; omitted, the run uses the product default.
export function questionArgs(q, web, authorityMode) {
  const qArgs = (q.args ?? []).map((a) =>
    a.startsWith("--search=") ? a.replace(/\bduckduckgo\b/g, web) : a,
  );
  if (!qArgs.some((a) => a.startsWith("--search="))) qArgs.push(`--search=${web}`);
  if (authorityMode) qArgs.push(`--source-authority=${authorityMode}`);
  return [q.question, "--json", "--no-sessions", "--max-runtime=8m", ...qArgs];
}

function runOne(args) {
  return new Promise((resolveRun) => {
    // --max-runtime: a wedged stage must fail the gate, not hang the bench
    // (observed once in the wild before the deadline existed).
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { stdio: ["ignore", "pipe", "pipe"] });
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
  const authorityCompare = argv.includes("--authority-compare");

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

  const web = resolveBackend(process.env);
  if (!web) {
    console.error(
      "bench: no search backend. The bench runs through SearXNG for a stable search\n" +
        "  layer — DuckDuckGo rate-limits the box IP and silently falls back to wikipedia,\n" +
        "  which makes prompt deltas unmeasurable (issue #97). Point it at a SearXNG:\n" +
        "    DEEPDIVE_SEARXNG_URL=http://localhost:8081 node bench/run.mjs\n" +
        "  Or bench another backend explicitly: DEEPDIVE_SEARCH=duckduckgo node bench/run.mjs",
    );
    process.exit(2);
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
    searchBackend: web,
    version,
  };

  console.error(`bench: ${questions.length} question(s) · deepdive v${version}`);
  // URL to stderr only — never into committed scoreboards (it's a private endpoint).
  console.error(`bench: search backend = ${web}${web === "searxng" ? ` @ ${process.env.DEEPDIVE_SEARXNG_URL}` : ""}`);

  // --authority-compare: run each question twice (--source-authority off vs
  // prefer) and report the shift in the kept-source mix. A measurement, not a
  // pass/fail — always exits 0. Doubles the run count, so honor --only.
  if (authorityCompare) {
    console.error(`bench: source-authority compare (off → prefer) · ${questions.length} question(s) × 2 runs`);
    const pairs = [];
    for (const q of questions) {
      console.error(`bench: ${q.id} — off …`);
      const offRun = await runOne(questionArgs(q, web, "off"));
      console.error(`bench: ${q.id} — prefer …`);
      const preferRun = await runOne(questionArgs(q, web, "prefer"));
      const off = authorityOf(offRun.json);
      const prefer = authorityOf(preferRun.json);
      pairs.push({ id: q.id, off, prefer });
      console.error(`bench: ${q.id} → off ${fmtAuthority(off)} | prefer ${fmtAuthority(prefer)}`);
      // A failed run renders as "—" in the board; without this the log holds
      // no trace of WHY (a mid-board searxng/LLM degradation looks identical
      // to a question with no data). Mirror the standard path's stderr tail.
      for (const [mode, run] of [["off", offRun], ["prefer", preferRun]]) {
        if (run.exitCode !== 0) {
          console.error(`bench:   ${mode} run failed (exit ${run.exitCode}) — stderr tail: ${run.stderr.split("\n").filter(Boolean).slice(-3).join(" · ")}`);
        }
      }
    }
    const cmp = renderComparison(pairs, meta);
    if (outPath) {
      const p = resolve(outPath);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, cmp, "utf-8");
      console.error(`bench: wrote ${p}`);
    } else {
      console.log(cmp);
    }
    process.exit(0);
  }

  const rows = [];
  for (const q of questions) {
    console.error(`bench: running ${q.id} …`);
    const outcome = await runOne(questionArgs(q, web));
    const spec = effectiveSpec(q, file.defaults);
    const score = scoreResult(outcome, spec);
    rows.push({ id: q.id, score, durationMs: outcome.durationMs, authority: authorityOf(outcome.json) });
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
