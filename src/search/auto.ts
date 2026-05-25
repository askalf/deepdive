// Auto search adapter — tries the primary engine (DuckDuckGo) first, falls
// back to the secondary (Brave) on HTTP/network errors or empty results.
// Exposes `lastEngine` so the agent can surface which engine served each
// query in `search.done` events.

import type { SearchAdapter, SearchResult } from "../search.js";

export class AutoSearch implements SearchAdapter {
  readonly name = "auto";
  lastEngine: string;

  constructor(
    private readonly primary: SearchAdapter,
    private readonly fallback: SearchAdapter,
  ) {
    this.lastEngine = primary.name;
  }

  async search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    let primaryFailed = false;
    try {
      const results = await this.primary.search(query, limit, signal);
      if (results.length > 0) {
        this.lastEngine = this.primary.name;
        return results;
      }
      primaryFailed = true;
    } catch (err) {
      if (signal?.aborted) throw err;
      primaryFailed = true;
    }
    if (!primaryFailed) {
      this.lastEngine = this.primary.name;
      return [];
    }
    const results = await this.fallback.search(query, limit, signal);
    this.lastEngine = this.fallback.name;
    return results;
  }
}
