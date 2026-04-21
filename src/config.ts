// Config resolution — merges CLI flags, env vars, and defaults.
// No config file in v0.1.0: keep the surface small. Env vars are prefixed
// DEEPDIVE_* to avoid collisions with other tools in the user's shell.

import type { LLMConfig } from "./llm.js";
import type { BrowserOptions } from "./browser.js";

export interface RuntimeConfig {
  llm: LLMConfig;
  browser: BrowserOptions;
  searchAdapter: string;
  resultsPerQuery: number;
  maxSources: number;
  maxWordsPerSource: number;
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

  const verbose = flags.verbose ?? env.DEEPDIVE_VERBOSE === "1";

  return {
    llm: { baseUrl, apiKey, model, maxTokens },
    browser: {
      headless: env.DEEPDIVE_HEADED === "1" ? false : true,
      timeoutMs,
      maxBytes: DEFAULTS.maxBytesPerFetch,
    },
    searchAdapter,
    resultsPerQuery,
    maxSources,
    maxWordsPerSource,
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
