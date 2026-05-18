import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../dist/cli.js";

test("parseArgs: plain question", () => {
  const p = parseArgs(["what is X"]);
  assert.equal(p.question, "what is X");
  assert.equal(p.help, false);
  assert.equal(p.outPath, undefined);
});

test("parseArgs: --help recognized", () => {
  assert.equal(parseArgs(["--help"]).help, true);
  assert.equal(parseArgs(["-h"]).help, true);
});

test("parseArgs: --verbose and -v set flags.verbose", () => {
  assert.equal(parseArgs(["q", "--verbose"]).flags.verbose, true);
  assert.equal(parseArgs(["q", "-v"]).flags.verbose, true);
});

test("parseArgs: --model=... assigns", () => {
  const p = parseArgs(["q", "--model=claude-opus-4-7"]);
  assert.equal(p.flags.model, "claude-opus-4-7");
});

test("parseArgs: --max-sources=N parses positive int", () => {
  const p = parseArgs(["q", "--max-sources=20"]);
  assert.equal(p.flags.maxSources, 20);
});

test("parseArgs: --max-sources=bad results in undefined, not crash", () => {
  const p = parseArgs(["q", "--max-sources=abc"]);
  assert.equal(p.flags.maxSources, undefined);
});

test("parseArgs: --out=path captured outside flags", () => {
  const p = parseArgs(["q", "--out=report.md"]);
  assert.equal(p.outPath, "report.md");
});

test("parseArgs: --search=NAME is lowercased", () => {
  const p = parseArgs(["q", "--search=BRAVE"]);
  assert.equal(p.flags.search, "brave");
});

test("parseArgs: unknown --flag throws", () => {
  assert.throws(() => parseArgs(["q", "--what=no"]), /unknown flag/);
});

test("parseArgs: bare --flag (no =) throws with helpful message", () => {
  assert.throws(() => parseArgs(["q", "--model"]), /must be in --key=value/);
});

test("parseArgs: second positional argument rejected (question must be quoted)", () => {
  assert.throws(
    () => parseArgs(["how", "does", "it", "work"]),
    /unexpected positional/,
  );
});

test("parseArgs: flags + question in any order", () => {
  const p = parseArgs(["--model=opus", "what is it", "--verbose"]);
  assert.equal(p.question, "what is it");
  assert.equal(p.flags.model, "opus");
  assert.equal(p.flags.verbose, true);
});

test("parseArgs: bare --deep sets deepRounds=2", () => {
  const p = parseArgs(["q", "--deep"]);
  assert.equal(p.flags.deepRounds, 2);
});

test("parseArgs: --deep=5 overrides default", () => {
  const p = parseArgs(["q", "--deep=5"]);
  assert.equal(p.flags.deepRounds, 5);
});

test("parseArgs: --deep=0 is valid (disables deep, explicit)", () => {
  const p = parseArgs(["q", "--deep=0"]);
  assert.equal(p.flags.deepRounds, 0);
});

test("parseArgs: --deep=bogus yields undefined (falls back to default)", () => {
  const p = parseArgs(["q", "--deep=abc"]);
  assert.equal(p.flags.deepRounds, undefined);
});

test("parseArgs: --concurrency=6 parses", () => {
  const p = parseArgs(["q", "--concurrency=6"]);
  assert.equal(p.flags.concurrency, 6);
});

test("parseArgs: --no-cache flag", () => {
  const p = parseArgs(["q", "--no-cache"]);
  assert.equal(p.flags.noCache, true);
});

test("parseArgs: --ignore-robots flag", () => {
  const p = parseArgs(["q", "--ignore-robots"]);
  assert.equal(p.flags.ignoreRobots, true);
});

test("parseArgs: --json flag", () => {
  const p = parseArgs(["q", "--json"]);
  assert.equal(p.flags.json, true);
});

test("parseArgs: --cache-ttl-ms=300000", () => {
  const p = parseArgs(["q", "--cache-ttl-ms=300000"]);
  assert.equal(p.flags.cacheTtlMs, 300000);
});

test("parseArgs: --llm-timeout-ms=60000", () => {
  const p = parseArgs(["q", "--llm-timeout-ms=60000"]);
  assert.equal(p.flags.llmTimeoutMs, 60_000);
});

test("parseArgs: --llm-attempts=5", () => {
  const p = parseArgs(["q", "--llm-attempts=5"]);
  assert.equal(p.flags.llmAttempts, 5);
});

test("parseArgs: --no-stream", () => {
  const p = parseArgs(["q", "--no-stream"]);
  assert.equal(p.flags.noStream, true);
});

test("parseArgs: --no-verify-cites flag", () => {
  const p = parseArgs(["q", "--no-verify-cites"]);
  assert.equal(p.flags.noVerifyCites, true);
});

test("parseArgs: --strict-cites flag", () => {
  const p = parseArgs(["q", "--strict-cites"]);
  assert.equal(p.flags.strictCites, true);
});

test("parseArgs: --cite-min-recall=0.6 parses", () => {
  const p = parseArgs(["q", "--cite-min-recall=0.6"]);
  assert.equal(p.flags.citeMinRecall, 0.6);
});

test("parseArgs: --cite-min-recall=2 (out of range) yields undefined", () => {
  const p = parseArgs(["q", "--cite-min-recall=2"]);
  assert.equal(p.flags.citeMinRecall, undefined);
});

test("parseArgs: --no-cost flag", () => {
  const p = parseArgs(["q", "--no-cost"]);
  assert.equal(p.flags.noCost, true);
});

test("parseArgs: --pdf-max-pages=N parses positive int", () => {
  const p = parseArgs(["q", "--pdf-max-pages=20"]);
  assert.equal(p.flags.pdfMaxPages, 20);
});

test("parseArgs: --include splits on comma and trims", () => {
  const p = parseArgs(["q", "--include=/a/b.md, /c/d.txt , /e"]);
  assert.deepEqual(p.flags.include, ["/a/b.md", "/c/d.txt", "/e"]);
});

test("parseArgs: --include= with empty parts drops them", () => {
  const p = parseArgs(["q", "--include=/a,,/b,"]);
  assert.deepEqual(p.flags.include, ["/a", "/b"]);
});

test("parseArgs: --allow-domain splits on comma", () => {
  const p = parseArgs(["q", "--allow-domain=github.com, docs.anthropic.com"]);
  assert.deepEqual(p.flags.allowDomain, ["github.com", "docs.anthropic.com"]);
});

test("parseArgs: --deny-domain splits on comma", () => {
  const p = parseArgs(["q", "--deny-domain=pinterest.com,quora.com"]);
  assert.deepEqual(p.flags.denyDomain, ["pinterest.com", "quora.com"]);
});

test("parseArgs: --api-format accepts anthropic and openai", () => {
  assert.equal(parseArgs(["q", "--api-format=openai"]).flags.apiFormat, "openai");
  assert.equal(
    parseArgs(["q", "--api-format=anthropic"]).flags.apiFormat,
    "anthropic",
  );
});

test("parseArgs: --api-format=other throws", () => {
  assert.throws(() => parseArgs(["q", "--api-format=mistral"]), /must be 'anthropic' or 'openai'/);
});

test("parseArgs: --no-sessions flag", () => {
  const p = parseArgs(["q", "--no-sessions"]);
  assert.equal(p.flags.noSessions, true);
});

test("parseArgs: 'sessions ls' captures the sub-verb in extras", () => {
  const p = parseArgs(["sessions", "ls"]);
  assert.equal(p.question, "sessions");
  assert.deepEqual(p.extras, ["ls"]);
});

test("parseArgs: 'show <id>' captures the id in extras", () => {
  const p = parseArgs(["show", "2026-05-07_120000_aabbccdd"]);
  assert.equal(p.question, "show");
  assert.deepEqual(p.extras, ["2026-05-07_120000_aabbccdd"]);
});

test("parseArgs: 'resume <id> <question>' captures both in extras", () => {
  const p = parseArgs(["resume", "abc", "what about Y"]);
  assert.equal(p.question, "resume");
  assert.deepEqual(p.extras, ["abc", "what about Y"]);
});

test("parseArgs: 'doctor' takes no extras (still rejects unexpected positional now-allowed)", () => {
  // doctor accepts extras (for forward-compat) but typically has none.
  // The point: extras is empty in the simple call.
  const p = parseArgs(["doctor"]);
  assert.equal(p.question, "doctor");
  assert.deepEqual(p.extras, []);
});

test("parseArgs: still rejects an unquoted multi-word question", () => {
  // Sanity check that the verb-allowlist didn't accidentally let
  // bare unquoted questions through.
  assert.throws(
    () => parseArgs(["how", "does", "X"]),
    /unexpected positional/,
  );
});

// v0.10.0 — per-stage model flags
test("parseArgs: --plan-model captured into flags.planModel", () => {
  const p = parseArgs(["--plan-model=claude-haiku-4-5", "q"]);
  assert.equal(p.flags.planModel, "claude-haiku-4-5");
  assert.equal(p.question, "q");
});

test("parseArgs: --synth-model captured into flags.synthModel", () => {
  const p = parseArgs(["--synth-model=claude-opus-4-7", "q"]);
  assert.equal(p.flags.synthModel, "claude-opus-4-7");
});

test("parseArgs: --critic-model captured into flags.criticModel", () => {
  const p = parseArgs(["--critic-model=claude-haiku-4-5", "q"]);
  assert.equal(p.flags.criticModel, "claude-haiku-4-5");
});

test("parseArgs: all three per-stage model flags can coexist with --model", () => {
  const p = parseArgs([
    "--model=claude-sonnet-4-6",
    "--plan-model=claude-haiku-4-5",
    "--synth-model=claude-opus-4-7",
    "--critic-model=claude-haiku-4-5",
    "q",
  ]);
  assert.equal(p.flags.model, "claude-sonnet-4-6");
  assert.equal(p.flags.planModel, "claude-haiku-4-5");
  assert.equal(p.flags.synthModel, "claude-opus-4-7");
  assert.equal(p.flags.criticModel, "claude-haiku-4-5");
});

// v0.11.0 — budget cap flag
test("parseArgs: --max-cost=$0.50 parses to 0.5", () => {
  const p = parseArgs(["--max-cost=$0.50", "q"]);
  assert.equal(p.flags.maxCostUsd, 0.5);
});

test("parseArgs: --max-cost=5 (bare) parses to 5", () => {
  const p = parseArgs(["--max-cost=5", "q"]);
  assert.equal(p.flags.maxCostUsd, 5);
});

test("parseArgs: --max-cost=abc throws", () => {
  assert.throws(
    () => parseArgs(["--max-cost=abc", "q"]),
    /--max-cost must be a positive dollar amount/,
  );
});

test("parseArgs: --max-cost=-1 throws (negatives rejected)", () => {
  assert.throws(
    () => parseArgs(["--max-cost=-1", "q"]),
    /--max-cost must be a positive dollar amount/,
  );
});
