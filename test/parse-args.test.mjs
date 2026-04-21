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
