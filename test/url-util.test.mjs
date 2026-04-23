import test from "node:test";
import assert from "node:assert/strict";
import {
  trimTrailingSlashes,
  stripHashFragment,
  dedupeKey,
} from "../dist/url-util.js";

test("trimTrailingSlashes: drops one trailing /", () => {
  assert.equal(trimTrailingSlashes("https://ex.com/"), "https://ex.com");
});

test("trimTrailingSlashes: drops many trailing /", () => {
  assert.equal(trimTrailingSlashes("https://ex.com////"), "https://ex.com");
});

test("trimTrailingSlashes: preserves non-trailing /", () => {
  assert.equal(
    trimTrailingSlashes("https://ex.com/a/b/c"),
    "https://ex.com/a/b/c",
  );
});

test("trimTrailingSlashes: empty string stays empty", () => {
  assert.equal(trimTrailingSlashes(""), "");
});

test("trimTrailingSlashes: linear on pathological input (no catastrophic backtracking)", () => {
  // This would be a ReDoS concern for /\/+$/ in adversarial regex engines;
  // the while-loop version is provably O(N).
  const pathological = "https://ex.com/" + "/".repeat(100_000);
  const start = Date.now();
  const out = trimTrailingSlashes(pathological);
  const elapsed = Date.now() - start;
  assert.equal(out, "https://ex.com");
  assert.ok(elapsed < 100, `expected <100ms, got ${elapsed}ms`);
});

test("stripHashFragment: drops #fragment", () => {
  assert.equal(stripHashFragment("https://ex.com/a#frag"), "https://ex.com/a");
});

test("stripHashFragment: no fragment is no-op", () => {
  assert.equal(stripHashFragment("https://ex.com/a"), "https://ex.com/a");
});

test("stripHashFragment: trailing # drops to empty fragment", () => {
  assert.equal(stripHashFragment("https://ex.com/a#"), "https://ex.com/a");
});

test("dedupeKey: combines both — /# + trailing slashes collapse", () => {
  assert.equal(
    dedupeKey("https://ex.com/a/#section/"),
    "https://ex.com/a",
  );
});

test("dedupeKey: two distinct URLs stay distinct", () => {
  assert.notEqual(dedupeKey("https://a.com/"), dedupeKey("https://b.com/"));
});
