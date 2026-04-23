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
