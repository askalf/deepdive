// Config file: pure env mapping + load/parse.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fileConfigToEnv,
  loadConfigFile,
  defaultConfigPath,
  knownConfigKeys,
} from "../dist/config-file.js";

// ── fileConfigToEnv ──────────────────────────────────────────────────────────

test("fileConfigToEnv: strings + numbers map to DEEPDIVE_* env strings", () => {
  const env = fileConfigToEnv({ model: "opus", deep: 3, maxSources: 20 });
  assert.equal(env.DEEPDIVE_MODEL, "opus");
  assert.equal(env.DEEPDIVE_DEEP_ROUNDS, "3");
  assert.equal(env.DEEPDIVE_MAX_SOURCES, "20");
});

test("fileConfigToEnv: lists join with commas (array or string)", () => {
  assert.equal(
    fileConfigToEnv({ denyDomain: ["pinterest.com", "quora.com"] }).DEEPDIVE_DENY_DOMAIN,
    "pinterest.com,quora.com",
  );
  assert.equal(
    fileConfigToEnv({ allowDomain: "github.com" }).DEEPDIVE_ALLOW_DOMAIN,
    "github.com",
  );
});

test("fileConfigToEnv: positive booleans only emit when true", () => {
  assert.equal(fileConfigToEnv({ tldr: true }).DEEPDIVE_TLDR, "1");
  assert.equal("DEEPDIVE_TLDR" in fileConfigToEnv({ tldr: false }), false);
});

test("fileConfigToEnv: inverted toggles emit the NO_ var only when disabled", () => {
  assert.equal(fileConfigToEnv({ cache: false }).DEEPDIVE_NO_CACHE, "1");
  assert.equal("DEEPDIVE_NO_CACHE" in fileConfigToEnv({ cache: true }), false);
  assert.equal(fileConfigToEnv({ verifyCites: false }).DEEPDIVE_NO_VERIFY_CITES, "1");
});

test("fileConfigToEnv: unknown keys are ignored", () => {
  assert.deepEqual(fileConfigToEnv({ bogus: "x", nope: 1 }), {});
});

test("knownConfigKeys: includes the headline settings", () => {
  const keys = knownConfigKeys();
  for (const k of ["model", "search", "deep", "concurrency", "tldr", "cache"]) {
    assert.ok(keys.includes(k), `missing ${k}`);
  }
});

// ── loadConfigFile ───────────────────────────────────────────────────────────

test("defaultConfigPath: respects DEEPDIVE_CONFIG", () => {
  assert.equal(defaultConfigPath({ DEEPDIVE_CONFIG: "/x/y.json" }), "/x/y.json");
  assert.match(defaultConfigPath({}), /\.deepdive[/\\]config\.json$/);
});

test("loadConfigFile: missing file is not an error", () => {
  const r = loadConfigFile({ DEEPDIVE_CONFIG: join(tmpdir(), "definitely-not-here-12345.json") });
  assert.deepEqual(r.base, {});
  assert.deepEqual(r.profiles, {});
  assert.equal(r.error, undefined);
});

test("loadConfigFile: splits base / profiles / defaultProfile", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-cfg-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(
      path,
      JSON.stringify({
        model: "claude-opus-4-7",
        search: "brave",
        defaultProfile: "deep",
        profiles: { mine: { deep: 5, maxSources: 30 } },
      }),
    );
    const r = loadConfigFile({ DEEPDIVE_CONFIG: path });
    assert.equal(r.base.model, "claude-opus-4-7");
    assert.equal(r.base.search, "brave");
    assert.equal(r.defaultProfile, "deep");
    assert.deepEqual(r.profiles.mine, { deep: 5, maxSources: 30 });
    // profiles/defaultProfile are not left in base
    assert.equal("profiles" in r.base, false);
    assert.equal("defaultProfile" in r.base, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigFile: malformed JSON returns an error, not a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-cfg-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, "{ not valid json");
    const r = loadConfigFile({ DEEPDIVE_CONFIG: path });
    assert.match(r.error, /invalid JSON/);
    assert.deepEqual(r.base, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfigFile: a non-object top level is rejected", () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-cfg-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, "[1,2,3]");
    const r = loadConfigFile({ DEEPDIVE_CONFIG: path });
    assert.match(r.error, /must be a JSON object/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
