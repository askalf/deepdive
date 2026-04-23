// Config resolution — merges CLI flags, env vars, and defaults.
// Env vars are prefixed DEEPDIVE_* to avoid collisions in the user's shell.

import { homedir } from "node:os";
import { join } from "node:path";
import type { LLMConfig } from "./llm.js";
import type { BrowserOptions } from "./browser.js";

export interface RuntimeConfig {
  llm: LLMConfig;
  browser: BrowserOptions;
  searchAdapter: string;
  resultsPerQuery: number;
  maxSources: number;
  maxWordsPerSource: number;
  deepRounds: number;
  concurrency: number;
  cache: { enabled: boolean; dir: string; ttlMs: number };
  respectRobots: boolean;
  jsonOutput: boolean;
  streamEnabled: boolean;
  verbose: boolean;
}

export interface CLIFlags {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
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
  json?: boolean;
  noStream?: boolean;
  verbose?: boolean;
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
  const jsonOutput = flags.json ?? env.DEEPDIVE_JSON === "1";
  const streamOptOut = flags.noStream ?? env.DEEPDIVE_NO_STREAM === "1";
  // Streaming is on by default but gets auto-disabled for:
  //  - JSON output (we buffer into the JSON envelope)
  //  - Deep mode (intermediate rounds would print multiple full drafts back-to-back)
  //  - Explicit --no-stream
  // CLI can further require stdout.isTTY before enabling.
  const streamEnabled = !streamOptOut && !jsonOutput && deepRounds === 0;
  const verbose = flags.verbose ?? env.DEEPDIVE_VERBOSE === "1";

  return {
    llm: {
      baseUrl,
      apiKey,
      model,
      maxTokens,
      timeoutMs: llmTimeoutMs,
      maxAttempts: llmAttempts,
    },
    browser: {
      headless: env.DEEPDIVE_HEADED === "1" ? false : true,
      timeoutMs,
      maxBytes: DEFAULTS.maxBytesPerFetch,
    },
    searchAdapter,
    resultsPerQuery,
    maxSources,
    maxWordsPerSource,
    deepRounds,
    concurrency,
    cache: { enabled: cacheEnabled, dir: cacheDir, ttlMs: cacheTtlMs },
    respectRobots,
    jsonOutput,
    streamEnabled,
    verbose,
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
