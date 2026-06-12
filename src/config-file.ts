// Config file + profile support. A user can persist their defaults in
// ~/.deepdive/config.json (override the path with DEEPDIVE_CONFIG) so they
// don't retype --base-url / --model / --search every run, and can define named
// profiles for common modes.
//
// The trick that keeps this from touching the stable resolveConfig() at all:
// the file's friendly keys are translated to the DEEPDIVE_* env var strings
// resolveConfig already understands, then layered UNDER the real process.env
// (real env wins). So the effective precedence becomes:
//
//   CLI flags  >  env vars  >  selected profile  >  config-file base  >  defaults
//
// Pure mapping (`fileConfigToEnv`) is separated from the file read
// (`loadConfigFile`) so the mapping is unit-testable without disk.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// A config object — the file's top level, or one profile. Friendly keys
// (see KEY_MAP); unknown keys are ignored by fileConfigToEnv.
export type FileConfig = Record<string, unknown>;

export interface ParsedConfigFile {
  base: FileConfig;
  profiles: Record<string, FileConfig>;
  defaultProfile?: string;
  path?: string;
  // Set when the file existed but couldn't be parsed; callers warn + ignore.
  error?: string;
}

type Kind = "string" | "number" | "list" | "bool" | "boolInverted";

// Friendly config key → the DEEPDIVE_* env var resolveConfig reads, plus how
// to serialize the JSON value into the string env form.
const KEY_MAP: Record<string, { env: string; kind: Kind }> = {
  baseUrl: { env: "DEEPDIVE_BASE_URL", kind: "string" },
  apiKey: { env: "DEEPDIVE_API_KEY", kind: "string" },
  model: { env: "DEEPDIVE_MODEL", kind: "string" },
  planModel: { env: "DEEPDIVE_PLAN_MODEL", kind: "string" },
  synthModel: { env: "DEEPDIVE_SYNTH_MODEL", kind: "string" },
  criticModel: { env: "DEEPDIVE_CRITIC_MODEL", kind: "string" },
  maxTokens: { env: "DEEPDIVE_MAX_TOKENS", kind: "number" },
  search: { env: "DEEPDIVE_SEARCH", kind: "string" },
  searchFallback: { env: "DEEPDIVE_SEARCH_FALLBACK", kind: "string" },
  resultsPerQuery: { env: "DEEPDIVE_RESULTS_PER_QUERY", kind: "number" },
  maxSources: { env: "DEEPDIVE_MAX_SOURCES", kind: "number" },
  maxWordsPerSource: { env: "DEEPDIVE_MAX_WORDS_PER_SOURCE", kind: "number" },
  timeoutMs: { env: "DEEPDIVE_FETCH_TIMEOUT_MS", kind: "number" },
  llmTimeoutMs: { env: "DEEPDIVE_LLM_TIMEOUT_MS", kind: "number" },
  llmAttempts: { env: "DEEPDIVE_LLM_ATTEMPTS", kind: "number" },
  deep: { env: "DEEPDIVE_DEEP_ROUNDS", kind: "number" },
  concurrency: { env: "DEEPDIVE_CONCURRENCY", kind: "number" },
  cacheTtlMs: { env: "DEEPDIVE_CACHE_TTL_MS", kind: "number" },
  citeMinRecall: { env: "DEEPDIVE_CITE_MIN_RECALL", kind: "number" },
  pdfMaxPages: { env: "DEEPDIVE_PDF_MAX_PAGES", kind: "number" },
  maxCost: { env: "DEEPDIVE_MAX_COST", kind: "string" }, // string: "$0.50" allowed
  maxRuntime: { env: "DEEPDIVE_MAX_RUNTIME", kind: "string" }, // "10m", "1h"
  apiFormat: { env: "DEEPDIVE_API_FORMAT", kind: "string" },
  browserCdpEndpoint: { env: "DEEPDIVE_BROWSER_CDP_ENDPOINT", kind: "string" },
  wikipediaLang: { env: "DEEPDIVE_WIKIPEDIA_LANG", kind: "string" },
  githubToken: { env: "DEEPDIVE_GITHUB_TOKEN", kind: "string" },
  braveKey: { env: "DEEPDIVE_BRAVE_KEY", kind: "string" },
  tavilyKey: { env: "DEEPDIVE_TAVILY_KEY", kind: "string" },
  exaKey: { env: "DEEPDIVE_EXA_KEY", kind: "string" },
  searxngUrl: { env: "DEEPDIVE_SEARXNG_URL", kind: "string" },
  cacheDir: { env: "DEEPDIVE_CACHE_DIR", kind: "string" },
  sessionsDir: { env: "DEEPDIVE_SESSIONS_DIR", kind: "string" },
  allowDomain: { env: "DEEPDIVE_ALLOW_DOMAIN", kind: "list" },
  denyDomain: { env: "DEEPDIVE_DENY_DOMAIN", kind: "list" },
  since: { env: "DEEPDIVE_SINCE", kind: "string" },
  dedupeThreshold: { env: "DEEPDIVE_DEDUPE_THRESHOLD", kind: "number" },
  include: { env: "DEEPDIVE_INCLUDE", kind: "list" },
  tags: { env: "DEEPDIVE_TAGS", kind: "list" },
  tldr: { env: "DEEPDIVE_TLDR", kind: "bool" },
  strictCites: { env: "DEEPDIVE_STRICT_CITES", kind: "bool" },
  verbose: { env: "DEEPDIVE_VERBOSE", kind: "bool" },
  headed: { env: "DEEPDIVE_HEADED", kind: "bool" },
  // Inverted toggles: the friendly key is the positive feature, set false to
  // disable. e.g. {"cache": false} → DEEPDIVE_NO_CACHE=1.
  cache: { env: "DEEPDIVE_NO_CACHE", kind: "boolInverted" },
  dedupe: { env: "DEEPDIVE_NO_DEDUPE", kind: "boolInverted" },
  verifyCites: { env: "DEEPDIVE_NO_VERIFY_CITES", kind: "boolInverted" },
  cost: { env: "DEEPDIVE_NO_COST", kind: "boolInverted" },
  sessions: { env: "DEEPDIVE_NO_SESSIONS", kind: "boolInverted" },
  stream: { env: "DEEPDIVE_NO_STREAM", kind: "boolInverted" },
  robots: { env: "DEEPDIVE_IGNORE_ROBOTS", kind: "boolInverted" },
};

// Exported for unit tests. Translate a FileConfig's friendly keys to the
// DEEPDIVE_* env-var string form. Unknown keys are skipped. Boolean toggles
// only emit an entry when they actually change behavior.
export function fileConfigToEnv(fc: FileConfig): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(fc)) {
    const spec = KEY_MAP[key];
    if (!spec || value === undefined || value === null) continue;
    switch (spec.kind) {
      case "string":
      case "number":
        out[spec.env] = String(value);
        break;
      case "list": {
        const joined = Array.isArray(value)
          ? value.map((v) => String(v).trim()).filter(Boolean).join(",")
          : String(value).trim();
        if (joined) out[spec.env] = joined;
        break;
      }
      case "bool":
        if (value === true) out[spec.env] = "1";
        break;
      case "boolInverted":
        if (value === false) out[spec.env] = "1";
        break;
    }
  }
  return out;
}

// Exported for unit tests. The friendly keys a config file / profile accepts.
export function knownConfigKeys(): string[] {
  return Object.keys(KEY_MAP);
}

// Default config path, override with DEEPDIVE_CONFIG.
export function defaultConfigPath(env: Record<string, string | undefined>): string {
  return env.DEEPDIVE_CONFIG ?? join(homedir(), ".deepdive", "config.json");
}

// Reads + parses the config file. A missing file is not an error (returns
// empty). A present-but-broken file returns `error` set so the caller can warn
// and proceed with no file config. Separates `profiles` and `defaultProfile`
// from the base settings.
export function loadConfigFile(env: Record<string, string | undefined>): ParsedConfigFile {
  const path = defaultConfigPath(env);
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return { base: {}, profiles: {} }; // no file → no config, not an error
  }
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { base: {}, profiles: {}, path, error: `invalid JSON in ${path}` };
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return { base: {}, profiles: {}, path, error: `config at ${path} must be a JSON object` };
  }
  const obj = json as Record<string, unknown>;
  const { profiles: rawProfiles, defaultProfile, ...base } = obj;
  const profiles: Record<string, FileConfig> = {};
  if (rawProfiles && typeof rawProfiles === "object" && !Array.isArray(rawProfiles)) {
    for (const [name, cfg] of Object.entries(rawProfiles as Record<string, unknown>)) {
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) {
        profiles[name] = cfg as FileConfig;
      }
    }
  }
  return {
    base,
    profiles,
    defaultProfile: typeof defaultProfile === "string" ? defaultProfile : undefined,
    path,
  };
}
