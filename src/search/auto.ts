// Auto search adapter — tries the primary engine (DuckDuckGo) first, falls
// back to the secondary (Brave) on HTTP/network errors or empty results.
// Exposes `lastEngine` so the agent can surface which engine served each
// query in `search.done` events.

import { siteOperatorQuery, type DomainHint, type SearchAdapter, type SearchResult } from "../search.js";

export class AutoSearch implements SearchAdapter {
  readonly name = "auto";
  lastEngine: string;

  constructor(
    private readonly primary: SearchAdapter,
    private readonly fallback: SearchAdapter | null,
  ) {
    this.lastEngine = primary.name;
  }

  // #157 — both engines auto wraps (ddg, brave) speak site:, so the hinted
  // form rides the same primary→fallback path as a plain search.
  searchHinted(
    query: string,
    hint: DomainHint,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.search(siteOperatorQuery(query, hint.hosts), limit, signal);
  }

  async search(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    let primaryError: unknown;
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
      primaryError = err;
      primaryFailed = true;
    }
    if (!primaryFailed) {
      this.lastEngine = this.primary.name;
      return [];
    }
    if (this.fallback === null) {
      this.lastEngine = this.primary.name;
      if (primaryError !== undefined) throw primaryError;
      throw new Error(`primary search '${this.primary.name}' returned 0 results and no fallback is configured`);
    }
    const results = await this.fallback.search(query, limit, signal);
    this.lastEngine = this.fallback.name;
    return results;
  }
}
