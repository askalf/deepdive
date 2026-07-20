// XDG Base Directory resolution (#179). deepdive historically kept all
// state under a single ~/.deepdive/. Fresh installs now follow the XDG
// spec — config, cache, and sessions each land under their proper base
// dir — while an existing ~/.deepdive/ keeps winning, so a working setup
// never silently moves.
//
// Per-path precedence (the DEEPDIVE_CONFIG / DEEPDIVE_CACHE_DIR /
// DEEPDIVE_SESSIONS_DIR overrides are handled by the callers and always
// win over everything here):
//
//   1. legacy ~/.deepdive/ — used whenever that directory exists
//   2. $XDG_CONFIG_HOME / $XDG_CACHE_HOME / $XDG_STATE_HOME, when set to
//      an absolute path (the spec deems relative values invalid)
//   3. the spec defaults: ~/.config, ~/.cache, ~/.local/state
//
// The legacy check is injectable so tests can pin either world without
// depending on the machine's real home directory.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

type Env = Record<string, string | undefined>;

export interface XdgOptions {
  legacyDirExists?: (dir: string) => boolean;
}

// The pre-XDG layout root. Exported so callers and docs can name it.
export function legacyDeepdiveDir(): string {
  return join(homedir(), ".deepdive");
}

function useLegacy(opts?: XdgOptions): boolean {
  return (opts?.legacyDirExists ?? existsSync)(legacyDeepdiveDir());
}

function baseDir(env: Env | undefined, xdgVar: string, fallback: string[]): string {
  const v = env?.[xdgVar];
  if (v && isAbsolute(v)) return v;
  return join(homedir(), ...fallback);
}

// Config file: $XDG_CONFIG_HOME/deepdive/config.json (~/.config/deepdive/
// config.json), or legacy ~/.deepdive/config.json.
export function xdgConfigFilePath(env?: Env, opts?: XdgOptions): string {
  if (useLegacy(opts)) return join(legacyDeepdiveDir(), "config.json");
  return join(baseDir(env, "XDG_CONFIG_HOME", [".config"]), "deepdive", "config.json");
}

// Page cache: $XDG_CACHE_HOME/deepdive (~/.cache/deepdive), or legacy
// ~/.deepdive/cache. No extra "cache" segment on the XDG side — the base
// dir already means cache.
export function xdgCacheDir(env?: Env, opts?: XdgOptions): string {
  if (useLegacy(opts)) return join(legacyDeepdiveDir(), "cache");
  return join(baseDir(env, "XDG_CACHE_HOME", [".cache"]), "deepdive");
}

// Sessions: $XDG_STATE_HOME/deepdive/sessions (~/.local/state/deepdive/
// sessions), or legacy ~/.deepdive/sessions. State, not config — sessions
// are a machine-local record of past runs, which the spec files under
// "actions history".
export function xdgSessionsDir(env?: Env, opts?: XdgOptions): string {
  if (useLegacy(opts)) return join(legacyDeepdiveDir(), "sessions");
  return join(baseDir(env, "XDG_STATE_HOME", [".local", "state"]), "deepdive", "sessions");
}
