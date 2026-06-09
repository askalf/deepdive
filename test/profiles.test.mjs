// Named profiles.

import { test } from "node:test";
import assert from "node:assert/strict";
import { BUILTIN_PROFILES, resolveProfile, listProfiles } from "../dist/profiles.js";

test("BUILTIN_PROFILES: the documented presets exist", () => {
  for (const name of ["deep", "thorough", "fast", "cheap", "strict"]) {
    assert.ok(name in BUILTIN_PROFILES, `missing built-in profile ${name}`);
  }
  assert.equal(BUILTIN_PROFILES.deep.deep, 3);
  assert.equal(BUILTIN_PROFILES.cheap.synthModel, "claude-sonnet-4-6");
});

test("resolveProfile: returns the built-in config", () => {
  assert.deepEqual(resolveProfile("fast"), { concurrency: 8, deep: 0 });
});

test("resolveProfile: a user profile of the same name overrides the built-in", () => {
  const merged = resolveProfile("deep", { deep: { deep: 9, maxSources: 40 } });
  assert.equal(merged.deep, 9); // user wins
  assert.equal(merged.maxSources, 40); // user-added key present
});

test("resolveProfile: a brand-new user profile resolves", () => {
  assert.deepEqual(resolveProfile("mine", { mine: { model: "x" } }), { model: "x" });
});

test("resolveProfile: unknown name throws with the available list", () => {
  assert.throws(() => resolveProfile("nope", { mine: {} }), /unknown profile: nope/);
  assert.throws(() => resolveProfile("nope"), /available:/);
});

test("listProfiles: merges built-ins with user profiles, sorted + unique", () => {
  const names = listProfiles({ mine: {}, deep: {} });
  assert.ok(names.includes("mine"));
  assert.ok(names.includes("fast"));
  // dedupes the user 'deep' against the built-in 'deep'
  assert.equal(names.filter((n) => n === "deep").length, 1);
});
