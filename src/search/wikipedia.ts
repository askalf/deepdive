// Wikipedia search adapter. No API key. Uses the MediaWiki search API
// (action=query&list=search) against the language edition of your choice
// (DEEPDIVE_WIKIPEDIA_LANG, default "en"). Good for definitional / factual
// sub-queries where an encyclopedia is the authoritative first stop.
//
// The API returns HTML-ish snippets with <span class="searchmatch"> markers;
// we strip tags and decode entities so the snippet is clean text. Full page
// content is left to deepdive's normal fetch step (the article URL), keeping
// the downstream extract/synthesis path identical across adapters.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";
import { keywordLadder } from "../query-keywords.js";
import { stripTags, decodeHtmlEntities } from "./duckduckgo.js";

interface WikiSearchItem {
  title?: string;
  snippet?: string;
  pageid?: number;
}

export class WikipediaSearch implements SearchAdapter {
  readonly name = "wikipedia";
  constructor(private readonly lang: string = "en") {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    // MediaWiki search matches article titles/text, so the planner's long
    // natural-language queries routinely return zero (#86 — this hollowed
    // out wikipedia's value as the default fallback). When the verbatim
    // query finds nothing, walk progressively shorter keyword variants
    // (4 → 2 → 1 leading keywords) until one hits. At most 3 extra calls
    // against a keyless API, and only on the would-have-been-empty path.
    const verbatim = await this.searchRaw(query, limit, signal);
    if (verbatim.length > 0) return verbatim;
    for (const variant of keywordLadder(query)) {
      const results = await this.searchRaw(variant, limit, signal);
      if (results.length > 0) return results;
    }
    return [];
  }

  private async searchRaw(
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    const url = new URL(`https://${this.lang}.wikipedia.org/w/api.php`);
    url.searchParams.set("action", "query");
    url.searchParams.set("list", "search");
    url.searchParams.set("srsearch", query);
    url.searchParams.set("srlimit", String(Math.min(Math.max(limit, 1), 50)));
    url.searchParams.set("format", "json");
    url.searchParams.set("origin", "*");
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        "user-agent": "deepdive (+https://github.com/askalf/deepdive)",
      },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`wikipedia ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { query?: { search?: WikiSearchItem[] } };
    return mapWikipediaResults(json.query?.search ?? [], this.lang, limit);
  }
}

// Exported for unit tests. Pure, deterministic, no I/O. Builds the canonical
// article URL from the page title and cleans the search-match snippet.
export function mapWikipediaResults(
  items: WikiSearchItem[],
  lang: string,
  limit: number,
): SearchResult[] {
  return items.slice(0, limit).map((r, i) => ({
    url: wikipediaArticleUrl(lang, r.title ?? ""),
    title: r.title ?? "",
    snippet: stripTags(decodeHtmlEntities(r.snippet ?? "")).replace(/\s+/g, " ").trim(),
    rank: i + 1,
  }));
}

// Exported for unit tests. Title → canonical /wiki/<Title_With_Underscores>.
// encodeURI (not encodeURIComponent) so the slashes/colons MediaWiki allows in
// titles survive, while spaces become underscores per Wikipedia convention.
export function wikipediaArticleUrl(lang: string, title: string): string {
  const slug = encodeURI(title.replace(/ /g, "_")).replace(/\?/g, "%3F").replace(/#/g, "%23");
  return `https://${lang}.wikipedia.org/wiki/${slug}`;
}
