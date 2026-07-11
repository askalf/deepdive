// SearXNG adapter. Points at an existing SearXNG instance (self-hosted or
// public). Requires DEEPDIVE_SEARXNG_URL. Uses the JSON output format.

import {
  searchTimeoutSignal,
  siteOperatorQuery,
  type DomainHint,
  type SearchAdapter,
  type SearchResult,
} from "../search.js";
import { trimTrailingSlashes } from "../url-util.js";

export class SearXNGSearch implements SearchAdapter {
  readonly name = "searxng";
  constructor(private readonly baseUrl: string) {}

  // #157 — SearXNG passes site: through to its engines (and understands it
  // natively), so an allow-domain hint becomes a directive instead of the
  // bare relevance token that failed to steer ranking in the wild.
  searchHinted(
    query: string,
    hint: DomainHint,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.search(siteOperatorQuery(query, hint.hosts), limit, signal);
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL(trimTrailingSlashes(this.baseUrl) + "/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "json");
    const res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`searxng ${res.status} ${res.statusText}`);
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
