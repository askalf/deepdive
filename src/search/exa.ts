// Exa adapter. Requires DEEPDIVE_EXA_KEY. Exa is a neural search API tuned
// for research workloads — the planner's sub-queries (and especially the
// critic's gap-filling follow-ups) tend to be long, intent-rich strings,
// which is the shape Exa's embedding-based retrieval is built for.
//
// We request highlights (short, query-focused excerpts) for each result so
// the snippet shown in events/logs is informative. Full-page text is left
// to deepdive's normal Playwright fetch step so the downstream extract /
// synthesis path is identical across adapters.

import type { SearchAdapter, SearchResult } from "../search.js";

interface ExaResponseItem {
  url: string;
  title?: string | null;
  text?: string;
  highlights?: string[];
  summary?: string;
}

interface ExaResponse {
  results?: ExaResponseItem[];
}

export class ExaSearch implements SearchAdapter {
  readonly name = "exa";
  constructor(private readonly key: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const res = await fetch("https://api.exa.ai/search", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        "x-api-key": this.key,
        "x-exa-integration": "deepdive",
      },
      body: JSON.stringify({
        query,
        numResults: Math.min(limit, 100),
        type: "auto",
        contents: { highlights: { numSentences: 2 } },
      }),
      signal,
    });
    if (!res.ok) throw new Error(`exa ${res.status} ${res.statusText}`);
    const json = (await res.json()) as ExaResponse;
    return mapExaResults(json.results ?? [], limit);
  }
}

// Exported for unit tests. Pure, deterministic, no I/O.
export function mapExaResults(items: ExaResponseItem[], limit: number): SearchResult[] {
  return items.slice(0, limit).map((r, i) => ({
    url: r.url,
    title: r.title ?? "",
    snippet: extractSnippet(r),
    rank: i + 1,
  }));
}

// Snippet cascade: highlights → text → summary → "". Exa may return any
// combination depending on what was requested or what the page yielded.
function extractSnippet(r: ExaResponseItem): string {
  if (r.highlights && r.highlights.length > 0) {
    return r.highlights.join(" … ").trim();
  }
  if (r.text && r.text.length > 0) {
    return r.text.slice(0, 500).trim();
  }
  if (r.summary && r.summary.length > 0) {
    return r.summary.trim();
  }
  return "";
}
