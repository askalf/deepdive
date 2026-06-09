// Config resolution — merges CLI flags, env vars, and defaults.
// Env vars are prefixed DEEPDIVE_* to avoid collisions in the user's shell.

import { homedir } from "node:os";
import { join } from "node:path";
import type { LLMConfig } from "./llm.js";
import type { BrowserOptions } from "./browser.js";
import { parseDomainList, type DomainFilter } from "./domain-filter.js";
import { detectApiFormat, type ApiFormat } from "./llm-format.js";
import { defaultSessionsDir } from "./sessions.js";
import { parseMaxCost } from "./budget.js";

export interface RuntimeConfig {
  llm: LLMConfig;
  // v0.10.0 — per-stage model overrides. `llm.model` is the base default;
  // any of these three may override for that specific phase. CLI / env
  // resolution is in resolveConfig below. When all three equal `llm.model`,
  // the run looks identical to a pre-v0.10.0 single-model run.
  models: { plan: string; synth: string; critique: string };
  browser: BrowserOptions;
  searchAdapter: string;
  resultsPerQuery: number;
  maxSources: number;
  maxWordsPerSource: number;
  deepRounds: number;
  concurrency: number;
  cache: { enabled: boolean; dir: string; ttlMs: number };
  respectRobots: boolean;
  verifyCitations: boolean;
  citeMinRecall: number;
  strictCitations: boolean;
  costEnabled: boolean;
  pdfMaxPages: number;
  include: string[];
  domainFilter: DomainFilter;
  sessions: { enabled: boolean; dir: string };
  jsonOutput: boolean;
  streamEnabled: boolean;
  verbose: boolean;
  // v0.11.0 — budget cap in USD. Undefined = no cap.
  maxCostUsd?: number;
}

export interface CLIFlags {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  // v0.10.0 — per-stage model overrides. Each falls back to `model`
  // (then env, then default).
  planModel?: string;
  synthModel?: string;
  criticModel?: string;
  maxTokens?: number;
  search?: string;
  resultsPerQuery?: number;
  maxSources?: number;
  maxWordsPerSource?: number;
  timeoutMs?: number;
  llmTimeoutMs?: number;
  llmAttempts?: number;
  deepRounds?: number;
  concurrency?: number;
  noCache?: boolean;
  cacheTtlMs?: number;
  ignoreRobots?: boolean;
  noVerifyCites?: boolean;
  strictCites?: boolean;
  citeMinRecall?: number;
  noCost?: boolean;
  pdfMaxPages?: number;
  include?: string[];
  allowDomain?: string[];
  denyDomain?: string[];
  apiFormat?: ApiFormat;
  noSessions?: boolean;
  json?: boolean;
  noStream?: boolean;
  verbose?: boolean;
  // v0.11.0 — already-parsed budget cap in USD. CLI parser converts
  // "--max-cost=$0.50" / "$5" / "0.25" into a number; resolveConfig
  // accepts the parsed value (parseMaxCost lives in budget.ts and the
  // CLI uses it before invoking resolveConfig).
  maxCostUsd?: number;
  // When set, attach to an existing CDP browser (e.g. a shared browser
  // container) instead of launching a local Chromium. Env: DEEPDIVE_BROWSER_CDP_ENDPOINT.
  browserCdpEndpoint?: string;
  // Subcommand-scoped flags. These don't affect a research run, so
  // resolveConfig ignores them — they're read directly by the export / diff /
  // sessions-prune handlers off ParsedArgs.flags.
  format?: string; // `deepdive export` output format: html | md
  narrate?: boolean; // `deepdive diff --narrate`: LLM summary of the change
  dryRun?: boolean; // `deepdive sessions prune --dry-run`: report, don't delete
  olderThan?: string; // `deepdive sessions prune --older-than=30d`
  keep?: number; // `deepdive sessions prune --keep=20`
}

const DEFAULTS = {
  baseUrl: "http://localhost:3456",
  apiKey: "dario",
  model: "claude-sonnet-4-6",
  maxTokens: 4096,
  searchAdapter: "duckduckgo",
  resultsPerQuery: 5,
  maxSources: 12,
  maxWordsPerSource: 2000,
  timeoutMs: 30000,
  maxBytesPerFetch: 2_000_000,
  deepRounds: 0,
  concurrency: 4,
  cacheTtlMs: 60 * 60 * 1000, // 1 hour
  llmTimeoutMs: 120_000, // 2 minutes per LLM call
  llmAttempts: 3,
};

export function resolveConfig(
  flags: CLIFlags,
  env: Record<string, string | undefined>,
): RuntimeConfig {
  const baseUrl = flags.baseUrl ?? env.DEEPDIVE_BASE_URL ?? DEFAULTS.baseUrl;
  const apiKey = flags.apiKey ?? env.DEEPDIVE_API_KEY ?? DEFAULTS.apiKey;
  const model = flags.model ?? env.DEEPDIVE_MODEL ?? DEFAULTS.model;
  // Per-stage overrides — fall back to the base model when unset.
  const planModel =
    flags.planModel ?? env.DEEPDIVE_PLAN_MODEL ?? model;
  const synthModel =
    flags.synthModel ?? env.DEEPDIVE_SYNTH_MODEL ?? model;
  const criticModel =
    flags.criticModel ?? env.DEEPDIVE_CRITIC_MODEL ?? model;
  const maxTokens =
    flags.maxTokens ??
    parsePositiveInt(env.DEEPDIVE_MAX_TOKENS) ??
    DEFAULTS.maxTokens;

  const searchAdapter =
    flags.search ?? env.DEEPDIVE_SEARCH ?? DEFAULTS.searchAdapter;

  const resultsPerQuery =
    flags.resultsPerQuery ??
    parsePositiveInt(env.DEEPDIVE_RESULTS_PER_QUERY) ??
    DEFAULTS.resultsPerQuery;

  const maxSources =
    flags.maxSources ??
    parsePositiveInt(env.DEEPDIVE_MAX_SOURCES) ??
    DEFAULTS.maxSources;

  const maxWordsPerSource =
    flags.maxWordsPerSource ??
    parsePositiveInt(env.DEEPDIVE_MAX_WORDS_PER_SOURCE) ??
    DEFAULTS.maxWordsPerSource;

  const timeoutMs =
    flags.timeoutMs ??
    parsePositiveInt(env.DEEPDIVE_FETCH_TIMEOUT_MS) ??
    DEFAULTS.timeoutMs;

  const llmTimeoutMs =
    flags.llmTimeoutMs ??
    parsePositiveInt(env.DEEPDIVE_LLM_TIMEOUT_MS) ??
    DEFAULTS.llmTimeoutMs;

  const llmAttempts =
    flags.llmAttempts ??
    parsePositiveInt(env.DEEPDIVE_LLM_ATTEMPTS) ??
    DEFAULTS.llmAttempts;

  const deepRounds =
    flags.deepRounds ??
    parseNonNegativeInt(env.DEEPDIVE_DEEP_ROUNDS) ??
    DEFAULTS.deepRounds;

  const concurrency =
    flags.concurrency ??
    parsePositiveInt(env.DEEPDIVE_CONCURRENCY) ??
    DEFAULTS.concurrency;

  const cacheEnabled =
    flags.noCache === true
      ? false
      : env.DEEPDIVE_NO_CACHE === "1"
      ? false
      : true;

  const cacheDir =
    env.DEEPDIVE_CACHE_DIR ?? join(homedir(), ".deepdive", "cache");

  const cacheTtlMs =
    flags.cacheTtlMs ??
    parsePositiveInt(env.DEEPDIVE_CACHE_TTL_MS) ??
    DEFAULTS.cacheTtlMs;

  const respectRobots =
    !(flags.ignoreRobots ?? env.DEEPDIVE_IGNORE_ROBOTS === "1");

  const verifyCitations =
    !(flags.noVerifyCites ?? env.DEEPDIVE_NO_VERIFY_CITES === "1");
  const strictCitations =
    flags.strictCites ?? env.DEEPDIVE_STRICT_CITES === "1";
  const citeMinRecall =
    flags.citeMinRecall ??
    parseUnitFloat(env.DEEPDIVE_CITE_MIN_RECALL) ??
    0.4;

  const costEnabled = !(flags.noCost ?? env.DEEPDIVE_NO_COST === "1");

  const pdfMaxPages =
    flags.pdfMaxPages ??
    parsePositiveInt(env.DEEPDIVE_PDF_MAX_PAGES) ??
    50;

  const includeFromEnv = (env.DEEPDIVE_INCLUDE ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const include = flags.include ?? includeFromEnv;

  const domainFilter: DomainFilter = {
    allow: flags.allowDomain ?? parseDomainList(env.DEEPDIVE_ALLOW_DOMAIN),
    deny: flags.denyDomain ?? parseDomainList(env.DEEPDIVE_DENY_DOMAIN),
  };

  const sessionsEnabled =
    flags.noSessions === true
      ? false
      : env.DEEPDIVE_NO_SESSIONS === "1"
      ? false
      : true;
  const sessionsDir = defaultSessionsDir(env);

  // API format: explicit flag/env wins; otherwise auto-detect from baseUrl.
  const apiFormatEnv =
    env.DEEPDIVE_API_FORMAT === "openai" || env.DEEPDIVE_API_FORMAT === "anthropic"
      ? (env.DEEPDIVE_API_FORMAT as ApiFormat)
      : undefined;
  const apiFormat: ApiFormat =
    flags.apiFormat ?? apiFormatEnv ?? detectApiFormat(baseUrl);
  const jsonOutput = flags.json ?? env.DEEPDIVE_JSON === "1";
  const streamOptOut = flags.noStream ?? env.DEEPDIVE_NO_STREAM === "1";
  // Streaming is on by default. Auto-disabled for:
  //  - JSON output (we buffer into the JSON envelope)
  //  - Explicit --no-stream
  // Deep mode used to disable streaming; v0.9 enables it again with
  // round-header separators between intermediate drafts.
  // CLI can further require stdout.isTTY before enabling.
  const streamEnabled = !streamOptOut && !jsonOutput;
  const verbose = flags.verbose ?? env.DEEPDIVE_VERBOSE === "1";

  // v0.11.0 — budget cap. Flag takes a pre-parsed number from cli.ts
  // (which uses parseMaxCost on the raw string). Env var is parsed here.
  const maxCostUsd = flags.maxCostUsd ?? parseMaxCost(env.DEEPDIVE_MAX_COST);

  return {
    llm: {
      baseUrl,
      apiKey,
      model,
      maxTokens,
      timeoutMs: llmTimeoutMs,
      maxAttempts: llmAttempts,
      apiFormat,
    },
    models: {
      plan: planModel,
      synth: synthModel,
      critique: criticModel,
    },
    browser: {
      headless: env.DEEPDIVE_HEADED === "1" ? false : true,
      timeoutMs,
      maxBytes: DEFAULTS.maxBytesPerFetch,
      cdpEndpoint: flags.browserCdpEndpoint ?? env.DEEPDIVE_BROWSER_CDP_ENDPOINT,
    },
    searchAdapter,
    resultsPerQuery,
    maxSources,
    maxWordsPerSource,
    deepRounds,
    concurrency,
    cache: { enabled: cacheEnabled, dir: cacheDir, ttlMs: cacheTtlMs },
    respectRobots,
    verifyCitations,
    citeMinRecall,
    strictCitations,
    costEnabled,
    pdfMaxPages,
    include,
    domainFilter,
    sessions: { enabled: sessionsEnabled, dir: sessionsDir },
    jsonOutput,
    streamEnabled,
    verbose,
    maxCostUsd,
  };
}

// Exported for unit tests.
export function parsePositiveInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

// Exported for unit tests.
export function parseNonNegativeInt(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}

// Exported for unit tests. Parses a float in [0, 1] — the citation-recall
// threshold. Returns undefined for non-numeric or out-of-range input.
export function parseUnitFloat(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
  return n;
}
