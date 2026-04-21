// Brave Search API adapter. Requires DEEPDIVE_BRAVE_KEY.

import type { SearchAdapter, SearchResult } from "../search.js";

export class BraveSearch implements SearchAdapter {
  readonly name = "brave";
  constructor(private readonly key: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 20)));
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "x-subscription-token": this.key,
      },
      signal,
    });
    if (!res.ok) throw new Error(`brave ${res.status} ${res.statusText}`);
    const json = (await res.json()) as {
      web?: { results?: { url: string; title: string; description?: string }[] };
    };
    const items = json.web?.results ?? [];
    return items.map((r, i) => ({
      url: r.url,
      title: r.title ?? "",
      snippet: r.description ?? "",
      rank: i + 1,
    }));
  }
}
