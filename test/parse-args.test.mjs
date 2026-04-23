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
