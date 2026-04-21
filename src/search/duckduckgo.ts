// DuckDuckGo HTML search. Uses the html.duckduckgo.com endpoint, which returns
// a static HTML document that's scrapable without an API key. Parses result
// links from the document structure, unwraps DDG's //duckduckgo.com/l/?uddg=
// redirect tracking, and returns { url, title, snippet }.
//
// If DDG changes their HTML layout, this breaks. Regenerate parser accordingly.

import type { SearchAdapter, SearchResult } from "../search.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

export class DuckDuckGoSearch implements SearchAdapter {
  readonly name = "duckduckgo";

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const form = new URLSearchParams({ q: query });
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      body: form.toString(),
      signal,
    });
    if (!res.ok) throw new Error(`duckduckgo ${res.status} ${res.statusText}`);
    const html = await res.text();
    return parseDuckDuckGoHTML(html, limit);
  }
}

// Exported for unit tests.
export function parseDuckDuckGoHTML(html: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  // Each result is wrapped in <div class="result results_links ...">.
  // We match non-greedily on the title/snippet anchors within.
  const blockRe =
    /<div class="result[^"]*"[\s\S]*?<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;

  let rank = 0;
  let m: RegExpExecArray | null;
  while ((m = blockRe.exec(html)) !== null) {
    const [, rawHref, rawTitle, rawSnippet] = m;
    const url = unwrapDDGRedirect(decodeHtmlEntities(rawHref));
    if (!isValidHttpUrl(url)) continue;
    rank++;
    results.push({
      url,
      title: stripTags(decodeHtmlEntities(rawTitle)).trim(),
      snippet: stripTags(decodeHtmlEntities(rawSnippet)).trim(),
      rank,
    });
    if (results.length >= limit) break;
  }
  return results;
}

function unwrapDDGRedirect(href: string): string {
  // DDG wraps real URLs behind //duckduckgo.com/l/?uddg=<encoded>&rut=<hash>
  // The real target is in the uddg param.
  if (href.startsWith("//")) href = "https:" + href;
  try {
    const u = new URL(href);
    if (u.hostname.endsWith("duckduckgo.com") && u.pathname === "/l/") {
      const uddg = u.searchParams.get("uddg");
      if (uddg) return decodeURIComponent(uddg);
    }
    return u.toString();
  } catch {
    return href;
  }
}

function isValidHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x2F;/g, "/")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "");
}
