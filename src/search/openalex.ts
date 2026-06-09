// OpenAlex search adapter. No API key (the polite pool just asks for a
// mailto; set DEEPDIVE_OPENALEX_MAILTO to join it). Open catalog of ~250M
// scholarly works across every discipline. The kept source is the work's open
// landing page (or its DOI) when available.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface OAWork {
  display_name?: string;
  doi?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  primary_location?: { landing_page_url?: string | null } | null;
  authorships?: { author?: { display_name?: string } }[];
}

export class OpenAlexSearch implements SearchAdapter {
  readonly name = "openalex";
  constructor(private readonly mailto?: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.openalex.org/works");
    url.searchParams.set("search", query);
    url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 50)));
    // Trim the payload to the fields we render.
    url.searchParams.set(
      "select",
      "display_name,doi,publication_year,cited_by_count,primary_location,authorships",
    );
    if (this.mailto) url.searchParams.set("mailto", this.mailto);
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`openalex ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { results?: OAWork[] };
    return mapOpenAlexWorks(json.results ?? [], limit);
  }
}

// Exported for unit tests. Pure mapper. URL preference: open landing page →
// DOI URL. Works with neither are dropped (nothing to fetch).
export function mapOpenAlexWorks(works: OAWork[], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  for (const w of works) {
    if (out.length >= limit) break;
    const title = w.display_name ?? "";
    if (!title) continue;
    const url = workUrl(w);
    if (!url) continue;
    out.push({ url, title, snippet: oaSnippet(w), rank: out.length + 1 });
  }
  return out;
}

function workUrl(w: OAWork): string | null {
  const landing = w.primary_location?.landing_page_url;
  if (typeof landing === "string" && landing.length > 0) return landing;
  if (typeof w.doi === "string" && w.doi.length > 0) {
    return w.doi.startsWith("http") ? w.doi : `https://doi.org/${w.doi.replace(/^doi:/, "")}`;
  }
  return null;
}

function oaSnippet(w: OAWork): string {
  const parts: string[] = [];
  if (typeof w.cited_by_count === "number") {
    parts.push(`${w.cited_by_count} citation${w.cited_by_count === 1 ? "" : "s"}`);
  }
  if (typeof w.publication_year === "number") parts.push(String(w.publication_year));
  const authors = (w.authorships ?? [])
    .map((a) => a.author?.display_name)
    .filter((n): n is string => Boolean(n));
  if (authors.length > 0) {
    parts.push(authors.length > 3 ? `${authors.slice(0, 3).join(", ")}, et al.` : authors.join(", "));
  }
  return parts.join(" · ");
}
