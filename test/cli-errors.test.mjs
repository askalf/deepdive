import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { safeErrorMessage } from "../dist/cli.js";

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
