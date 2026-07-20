// XDG path resolution (#179). The legacy check is injected in every test
// so results don't depend on whether the machine running the suite has a
// real ~/.deepdive.
import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  legacyDeepdiveDir,
  xdgConfigFilePath,
  xdgCacheDir,
  xdgSessionsDir,
} from "../dist/xdg.js";

const LEGACY = { legacyDirExists: () => true };
const FRESH = { legacyDirExists: () => false };

test("legacyDeepdiveDir: ~/.deepdive", () => {
  assert.equal(legacyDeepdiveDir(), join(homedir(), ".deepdive"));
});

test("legacy ~/.deepdive wins for all three paths when it exists", () => {
  const legacy = legacyDeepdiveDir();
  assert.equal(xdgConfigFilePath({}, LEGACY), join(legacy, "config.json"));
  assert.equal(xdgCacheDir({}, LEGACY), join(legacy, "cache"));
  assert.equal(xdgSessionsDir({}, LEGACY), join(legacy, "sessions"));
  // ...even when XDG vars are set — no silent migration of a working setup.
  const env = { XDG_CONFIG_HOME: "/xdg/cfg", XDG_CACHE_HOME: "/xdg/cache" };
  assert.equal(xdgConfigFilePath(env, LEGACY), join(legacy, "config.json"));
  assert.equal(xdgCacheDir(env, LEGACY), join(legacy, "cache"));
});

test("fresh install: spec default bases", () => {
  const home = homedir();
  assert.equal(
    xdgConfigFilePath({}, FRESH),
    join(home, ".config", "deepdive", "config.json"),
  );
  assert.equal(xdgCacheDir({}, FRESH), join(home, ".cache", "deepdive"));
  assert.equal(
    xdgSessionsDir({}, FRESH),
    join(home, ".local", "state", "deepdive", "sessions"),
  );
});

test("fresh install: absolute XDG_* env vars are respected", () => {
  const env = {
    XDG_CONFIG_HOME: join(homedir(), "custom-cfg"),
    XDG_CACHE_HOME: join(homedir(), "custom-cache"),
    XDG_STATE_HOME: join(homedir(), "custom-state"),
  };
  assert.equal(
    xdgConfigFilePath(env, FRESH),
    join(env.XDG_CONFIG_HOME, "deepdive", "config.json"),
  );
  assert.equal(xdgCacheDir(env, FRESH), join(env.XDG_CACHE_HOME, "deepdive"));
  assert.equal(
    xdgSessionsDir(env, FRESH),
    join(env.XDG_STATE_HOME, "deepdive", "sessions"),
  );
});

test("fresh install: relative or empty XDG_* values are ignored (spec)", () => {
  const home = homedir();
  for (const bad of ["relative/path", ""]) {
    assert.equal(
      xdgConfigFilePath({ XDG_CONFIG_HOME: bad }, FRESH),
      join(home, ".config", "deepdive", "config.json"),
    );
    assert.equal(
      xdgCacheDir({ XDG_CACHE_HOME: bad }, FRESH),
      join(home, ".cache", "deepdive"),
    );
    assert.equal(
      xdgSessionsDir({ XDG_STATE_HOME: bad }, FRESH),
      join(home, ".local", "state", "deepdive", "sessions"),
    );
  }
});

test("undefined env behaves like empty env", () => {
  assert.equal(
    xdgConfigFilePath(undefined, FRESH),
    join(homedir(), ".config", "deepdive", "config.json"),
  );
});
