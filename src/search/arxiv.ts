// arXiv search adapter. No API key. Uses the arXiv Atom API
// (export.arxiv.org/api/query), which returns an Atom feed of matching
// papers. A fit for research-paper / preprint questions where the planner's
// sub-queries name a method, model, or result.
//
// The response is XML; we parse <entry> blocks with a hand-rolled regex (the
// same "fix the parser if it breaks, don't reach for a dep" stance the DDG
// adapter takes). The abstract page URL (<id>) is the kept source; deepdive's
// fetch step pulls the abstract page, and the PDF path handles the linked PDF
// if the planner picks it.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";
import { decodeHtmlEntities } from "./duckduckgo.js";

export class ArxivSearch implements SearchAdapter {
  readonly name = "arxiv";
  // Results are arxiv.org abstract-page URLs (the Atom <id>) — #147.
  readonly servesDomains = ["arxiv.org"];

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://export.arxiv.org/api/query");
    url.searchParams.set("search_query", `all:${query}`);
    url.searchParams.set("start", "0");
    url.searchParams.set("max_results", String(Math.min(Math.max(limit, 1), 50)));
    url.searchParams.set("sortBy", "relevance");
    const res = await fetch(url, {
      headers: { "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`arxiv ${res.status} ${res.statusText}`);
    const xml = await res.text();
    return parseArxivAtom(xml, limit);
  }
}

// Exported for unit tests. Pure Atom-feed parser. Pulls title / abstract URL /
// summary from each <entry>; collapses the whitespace arXiv wraps titles and
// abstracts with.
export function parseArxivAtom(xml: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const entryRe = /<entry\b[^>]*>([\s\S]*?)<\/entry>/g;
  let m: RegExpExecArray | null;
  let rank = 0;
  while ((m = entryRe.exec(xml)) !== null) {
    const entry = m[1];
    const id = tag(entry, "id");
    const url = normalizeAbsUrl(id);
    if (!url) continue;
    rank++;
    results.push({
      url,
      title: clean(tag(entry, "title")),
      snippet: clean(tag(entry, "summary")),
      rank,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function tag(xml: string, name: string): string {
  const m = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)<\\/${name}>`).exec(xml);
  return m ? m[1] : "";
}

function clean(s: string): string {
  return decodeHtmlEntities(s).replace(/\s+/g, " ").trim();
}

// arXiv <id> is the abstract URL (http://arxiv.org/abs/...). Force https and
// reject anything that isn't an arxiv.org abstract link.
function normalizeAbsUrl(id: string): string | null {
  const raw = id.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (!/(^|\.)arxiv\.org$/.test(u.hostname)) return null;
    u.protocol = "https:";
    return u.toString();
  } catch {
    return null;
  }
}
