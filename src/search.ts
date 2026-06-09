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
