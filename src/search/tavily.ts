// Tavily adapter. Requires DEEPDIVE_TAVILY_KEY. Tavily returns search results
// with pre-extracted content, which means the browser fetch step can be
// skipped when using this adapter — but deepdive re-fetches anyway so the
// downstream extract/synthesis path is identical across adapters.

import type { SearchAdapter, SearchResult } from "../search.js";

export class TavilySearch implements SearchAdapter {
  readonly name = "tavily";
  constructor(private readonly key: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify({
        api_key: this.key,
        query,
        max_results: limit,
        search_depth: "basic",
      }),
      signal,
    });
    if (!res.ok) throw new Error(`tavily ${res.status} ${res.statusText}`);
    const json = (await res.json()) as {
      results?: { url: string; title: string; content?: string }[];
    };
    const items = json.results ?? [];
    return items.slice(0, limit).map((r, i) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.content ?? "",
      rank: i + 1,
    }));
  }
}
