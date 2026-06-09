// Hacker News search adapter. No API key. Uses the Algolia-hosted HN Search
// API (hn.algolia.com). A fit for "what does the community think of X",
// release discussions, and primary-source threads. Defaults to story results;
// the kept source is the story's target URL (or the HN thread itself for
// Ask/Show HN posts with no external link).

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface HNHit {
  objectID?: string;
  title?: string | null;
  url?: string | null;
  points?: number | null;
  num_comments?: number | null;
  author?: string | null;
}

export class HackerNewsSearch implements SearchAdapter {
  readonly name = "hackernews";

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://hn.algolia.com/api/v1/search");
    url.searchParams.set("query", query);
    url.searchParams.set("tags", "story");
    url.searchParams.set("hitsPerPage", String(Math.min(Math.max(limit, 1), 50)));
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`hackernews ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { hits?: HNHit[] };
    return mapHNHits(json.hits ?? [], limit);
  }
}

// Exported for unit tests. Pure mapper. Ask/Show HN posts have a null `url`;
// fall back to the HN thread page so there's always something to fetch.
export function mapHNHits(hits: HNHit[], limit: number): SearchResult[] {
  return hits
    .filter((h) => (h.title ?? "").length > 0 && (h.url || h.objectID))
    .slice(0, limit)
    .map((h, i) => ({
      url: h.url || `https://news.ycombinator.com/item?id=${h.objectID}`,
      title: h.title as string,
      snippet: hnSnippet(h),
      rank: i + 1,
    }));
}

function hnSnippet(h: HNHit): string {
  const parts: string[] = [];
  if (typeof h.points === "number") parts.push(`${h.points} points`);
  if (typeof h.num_comments === "number") parts.push(`${h.num_comments} comments`);
  if (h.author) parts.push(`by ${h.author}`);
  return parts.join(" · ");
}
