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
    const isDDG = u.hostname === "duckduckgo.com" || u.hostname.endsWith(".duckduckgo.com");
    if (isDDG && u.pathname === "/l/") {
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

// Exported for unit tests. Single-pass HTML entity decoder — each `&...;`
// token is resolved exactly once with no rescan, so `&amp;#39;` decodes to
// the literal `&#39;` rather than double-unescaping to `'`.
export function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (match, name) => {
    const named: Record<string, string> = {
      amp: "&",
      lt: "<",
      gt: ">",
      quot: '"',
      apos: "'",
      nbsp: " ",
    };
    const low = name.toLowerCase();
    if (low in named) return named[low];
    if (name.startsWith("#x") || name.startsWith("#X")) {
      const code = parseInt(name.slice(2), 16);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    if (name.startsWith("#")) {
      const code = parseInt(name.slice(1), 10);
      return isValidCodePoint(code) ? String.fromCodePoint(code) : match;
    }
    return match;
  });
}

function isValidCodePoint(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && n <= 0x10ffff;
}

// Exported for unit tests. Strips well-formed tags, then drops any stray `<`
// to defuse malformed/partial tags (e.g. `<scrip` with no closing `>`).
// Output is plain text destined for markdown citation rows — not
// HTML-rendered — but we harden here so a malformed snippet can never leak
// a tag opener into downstream consumers.
export function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ").split("<").join(" ");
}
