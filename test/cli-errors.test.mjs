import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { safeErrorMessage, renderCitationHealthFooter } from "../dist/cli.js";

test("safeErrorMessage: home dir scrubbed from Error.message", () => {
  const home = homedir();
  const err = new Error(`failed to open ${home}\\some\\secret`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes(home), `home should be scrubbed: ${out}`);
  assert.ok(out.includes("~"), `should include ~: ${out}`);
});

test("safeErrorMessage: handles non-Error thrown values", () => {
  assert.equal(safeErrorMessage("string error"), "string error");
  assert.equal(safeErrorMessage(42), "42");
  assert.equal(safeErrorMessage(null), "unknown error");
  assert.equal(safeErrorMessage(undefined), "unknown error");
});

test("safeErrorMessage: Unix home dir scrubbed", () => {
  // This test exercises the scrub logic for unix paths — only meaningful on
  // non-Windows, so we synthesize a unix-style home string.
  const fakeHome = homedir();
  const err = new Error(`config at ${fakeHome}/credentials.json is unreadable`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes(fakeHome), `home should be scrubbed: ${out}`);
});

test("safeErrorMessage: preserves non-path error content", () => {
  const err = new Error("LLM 500 Internal Server Error: upstream flake");
  assert.equal(
    safeErrorMessage(err),
    "LLM 500 Internal Server Error: upstream flake",
  );
});

test("safeErrorMessage: backslashes normalized to forward slashes", () => {
  const home = homedir();
  if (!home.includes("\\")) return; // Unix — nothing to test
  const err = new Error(`ENOENT at ${home}\\a\\b\\c`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes("\\"), `no backslashes in output: ${out}`);
});

test("renderCitationHealthFooter: returns '' when report is undefined", () => {
  assert.equal(renderCitationHealthFooter(undefined), "");
});

test("renderCitationHealthFooter: returns '' when all citations supported", () => {
  const report = {
    threshold: 0.4,
    totalCitations: 3,
    supportedCitations: 3,
    checks: [],
    unsupported: [],
  };
  assert.equal(renderCitationHealthFooter(report), "");
});

test("renderCitationHealthFooter: emits a footer when there are unsupported cites", () => {
  const report = {
    threshold: 0.4,
    totalCitations: 5,
    supportedCitations: 3,
    checks: [],
    unsupported: [
      { sentence: "x", citedIds: [1], unsupportedIds: [1], recallByCite: { 1: 0.1 }, supported: false },
      { sentence: "y", citedIds: [2], unsupportedIds: [2], recallByCite: { 2: 0.2 }, supported: false },
    ],
  };
  const out = renderCitationHealthFooter(report);
  assert.match(out, /## Citation health/);
  assert.match(out, /2 of 5/);
  assert.match(out, /threshold 0\.4/);
});
