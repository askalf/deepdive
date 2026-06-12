// Search adapter interface. A "search" returns candidate URLs with metadata.
// Adapters live under src/search/*. Default is DuckDuckGo HTML (no API key).

import { dedupeKey } from "./url-util.js";

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
  rank: number;
}

export interface SearchAdapter {
  readonly name: string;
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
}

// Typed "the backend is refusing us because we asked too often" error —
// distinct from a parse failure or network error so the agent can stop
// hammering the engine for the rest of the round and the CLI can suggest a
// concrete fallback instead of a mysterious all-zero-results run. Adapters
// that can recognize their backend's throttle response should throw this.
export class SearchRateLimitError extends Error {
  readonly rateLimited = true;
  constructor(
    public readonly adapter: string,
    detail: string,
  ) {
    super(`${adapter} is rate-limiting requests (${detail})`);
    this.name = "SearchRateLimitError";
  }
}

// Duck-typed check (rather than bare instanceof) so a rate-limit error
// still classifies correctly if two copies of this module are loaded
// (e.g. a library consumer bundling their own deepdive build).
export function isRateLimitError(err: unknown): boolean {
  return (
    err instanceof SearchRateLimitError ||
    (err instanceof Error && (err as { rateLimited?: unknown }).rateLimited === true)
  );
}

// Per-request search timeout. Adapters previously passed only the caller's
// abort signal (wired to SIGINT/SIGTERM), so a hung search endpoint blocked the
// whole run with no escape. Combine the caller's signal with a hard timeout,
// mirroring the per-request timeout robots.ts already applies. Override the
// 15s default via DEEPDIVE_SEARCH_TIMEOUT_MS.
export function searchTimeoutSignal(signal?: AbortSignal): AbortSignal {
  const ms = Number(process.env["DEEPDIVE_SEARCH_TIMEOUT_MS"]) || 15_000;
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function resolveSearchAdapter(
  name: string,
  env: Record<string, string | undefined>,
): Promise<SearchAdapter> {
  // Fan-out: `multi:a,b[,c…]` resolves each sub-adapter recursively and
  // interleaves their results. Nesting (`multi:` inside the list) is refused.
  if (name === "multi" || name.startsWith("multi:")) {
    const list = name
      .slice("multi:".length)
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (name === "multi" || list.length < 2) {
      throw new Error(
        "multi search needs a comma-separated adapter list, e.g. --search=multi:duckduckgo,wikipedia",
      );
    }
    if (list.some((n) => n === "multi" || n.startsWith("multi:"))) {
      throw new Error("multi search cannot nest another multi adapter");
    }
    const { MultiSearch } = await import("./search/multi.js");
    const adapters = await Promise.all(list.map((n) => resolveSearchAdapter(n, env)));
    return new MultiSearch(adapters);
  }
  switch (name) {
    case "duckduckgo":
    case "ddg": {
      const { DuckDuckGoSearch } = await import("./search/duckduckgo.js");
      return new DuckDuckGoSearch();
    }
    case "searxng": {
      const { SearXNGSearch } = await import("./search/searxng.js");
      const url = env.DEEPDIVE_SEARXNG_URL;
      if (!url) throw new Error("searxng adapter requires DEEPDIVE_SEARXNG_URL");
      return new SearXNGSearch(url);
    }
    case "brave": {
      const { BraveSearch } = await import("./search/brave.js");
      const key = env.DEEPDIVE_BRAVE_KEY;
      if (!key) throw new Error("brave adapter requires DEEPDIVE_BRAVE_KEY");
      return new BraveSearch(key);
    }
    case "tavily": {
      const { TavilySearch } = await import("./search/tavily.js");
      const key = env.DEEPDIVE_TAVILY_KEY;
      if (!key) throw new Error("tavily adapter requires DEEPDIVE_TAVILY_KEY");
      return new TavilySearch(key);
    }
    case "exa": {
      const { ExaSearch } = await import("./search/exa.js");
      const key = env.DEEPDIVE_EXA_KEY;
      if (!key) throw new Error("exa adapter requires DEEPDIVE_EXA_KEY");
      return new ExaSearch(key);
    }
    case "wikipedia":
    case "wiki": {
      const { WikipediaSearch } = await import("./search/wikipedia.js");
      const lang = (env.DEEPDIVE_WIKIPEDIA_LANG ?? "en").trim() || "en";
      return new WikipediaSearch(lang);
    }
    case "arxiv": {
      const { ArxivSearch } = await import("./search/arxiv.js");
      return new ArxivSearch();
    }
    case "github": {
      // Token is optional — unauthenticated search works at a lower rate
      // limit. DEEPDIVE_GITHUB_TOKEN raises it.
      const { GitHubSearch } = await import("./search/github.js");
      return new GitHubSearch(env.DEEPDIVE_GITHUB_TOKEN);
    }
    case "hackernews":
    case "hn": {
      const { HackerNewsSearch } = await import("./search/hackernews.js");
      return new HackerNewsSearch();
    }
    case "stackexchange":
    case "stackoverflow":
    case "so": {
      const { StackExchangeSearch } = await import("./search/stackexchange.js");
      // Default site stackoverflow; override with DEEPDIVE_STACKEXCHANGE_SITE.
      const site = (env.DEEPDIVE_STACKEXCHANGE_SITE ?? "stackoverflow").trim() || "stackoverflow";
      return new StackExchangeSearch(site);
    }
    case "pubmed": {
      const { PubMedSearch } = await import("./search/pubmed.js");
      return new PubMedSearch();
    }
    case "semanticscholar":
    case "s2": {
      const { SemanticScholarSearch } = await import("./search/semanticscholar.js");
      return new SemanticScholarSearch(env.DEEPDIVE_S2_KEY);
    }
    case "openalex": {
      const { OpenAlexSearch } = await import("./search/openalex.js");
      return new OpenAlexSearch(env.DEEPDIVE_OPENALEX_MAILTO);
    }
    case "auto": {
      // DDG primary, Brave fallback. Brave is optional — if no key is set,
      // `auto` degrades to DDG-only (the pre-auto default behavior) rather
      // than failing, so users without a Brave key still get sensible
      // results.
      const { AutoSearch } = await import("./search/auto.js");
      const { DuckDuckGoSearch } = await import("./search/duckduckgo.js");
      const primary = new DuckDuckGoSearch();
      const braveKey = env.DEEPDIVE_BRAVE_KEY;
      let secondary = null;
      if (braveKey) {
        const { BraveSearch } = await import("./search/brave.js");
        secondary = new BraveSearch(braveKey);
      }
      return new AutoSearch(primary, secondary);
    }
    default:
      throw new Error(`unknown search adapter: ${name}`);
  }
}

// Normalize a user-supplied adapter list ("wikipedia" / "wikipedia,arxiv" /
// "multi:wikipedia,arxiv") into a single resolvable adapter name: a bare
// comma list gets the multi: prefix, a single name passes through. Returns
// undefined for empty input. Used by --search-fallback so users don't have
// to know the multi: spelling.
export function normalizeAdapterList(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return undefined;
  if (trimmed.startsWith("multi:")) return trimmed;
  const parts = trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return undefined;
  return parts.length === 1 ? parts[0] : `multi:${parts.join(",")}`;
}

export function dedupeByUrl(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const out: SearchResult[] = [];
  for (const r of results) {
    const key = dedupeKey(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}
