// Semantic Scholar search adapter. No API key (keyless requests are
// rate-limited but fine interactively; set DEEPDIVE_S2_KEY to use an API key).
// Uses the Graph API paper-search endpoint. Strong for CS / general academic
// questions — the kept source is the paper's landing page.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface S2Paper {
  paperId?: string;
  title?: string;
  url?: string;
  abstract?: string | null;
  year?: number | null;
  citationCount?: number | null;
  authors?: { name?: string }[];
}

export class SemanticScholarSearch implements SearchAdapter {
  readonly name = "semanticscholar";
  constructor(private readonly key?: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.semanticscholar.org/graph/v1/paper/search");
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set("fields", "title,url,abstract,year,citationCount,authors");
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "deepdive (+https://github.com/askalf/deepdive)",
    };
    if (this.key) headers["x-api-key"] = this.key;
    const res = await fetch(url, { headers, signal: searchTimeoutSignal(signal) });
    if (!res.ok) throw new Error(`semanticscholar ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { data?: S2Paper[] };
    return mapS2Papers(json.data ?? [], limit);
  }
}

// Exported for unit tests. Pure mapper. Falls back to the S2 paper page when a
// paper has no canonical `url`. Snippet leads with citation count + year.
export function mapS2Papers(papers: S2Paper[], limit: number): SearchResult[] {
  return papers
    .filter((p) => (p.title ?? "").length > 0 && (p.url || p.paperId))
    .slice(0, limit)
    .map((p, i) => ({
      url: p.url || `https://www.semanticscholar.org/paper/${p.paperId}`,
      title: p.title as string,
      snippet: s2Snippet(p),
      rank: i + 1,
    }));
}

function s2Snippet(p: S2Paper): string {
  const parts: string[] = [];
  if (typeof p.citationCount === "number") {
    parts.push(`${p.citationCount} citation${p.citationCount === 1 ? "" : "s"}`);
  }
  if (typeof p.year === "number") parts.push(String(p.year));
  const authors = (p.authors ?? []).map((a) => a.name).filter(Boolean);
  if (authors.length > 0) {
    parts.push(authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", "));
  }
  if (p.abstract) parts.push(p.abstract.slice(0, 160).trim());
  return parts.join(" · ");
}
