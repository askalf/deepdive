// DuckDuckGo HTML search. Uses the html.duckduckgo.com endpoint, which returns
// a static HTML document that's scrapable without an API key. Parses result
// links from the document structure, unwraps DDG's //duckduckgo.com/l/?uddg=
// redirect tracking, and returns { url, title, snippet }.
//
// If DDG changes their HTML layout, this breaks. Regenerate parser accordingly.

import {
  searchTimeoutSignal,
  SearchRateLimitError,
  siteOperatorQuery,
  type DomainHint,
  type SearchAdapter,
  type SearchResult,
} from "../search.js";

const ENDPOINT = "https://html.duckduckgo.com/html/";

// DDG's HTML endpoint throttles bursts (~7 rapid queries trips it) and then
// answers 200 with a bot-challenge page instead of results — which the parser
// would silently turn into an empty list, burning the synthesis LLM call on
// nothing. Two defenses: space consecutive requests out (below), and detect
// the challenge / throttle response so the caller gets a typed rate-limit
// error instead of a mysterious all-zero round.
const DEFAULT_REQUEST_SPACING_MS = 1_000;

function requestSpacingMs(): number {
  const raw = process.env["DEEPDIVE_DDG_DELAY_MS"];
  if (raw === undefined || raw.trim() === "") return DEFAULT_REQUEST_SPACING_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_REQUEST_SPACING_MS;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    // Wake early on abort — the fetch right after will throw on the
    // already-aborted signal, so resolving (not rejecting) is fine here.
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class DuckDuckGoSearch implements SearchAdapter {
  readonly name = "duckduckgo";
  private lastRequestAt = 0;

  // #157 — DDG supports the site: operator; see SearXNGSearch.searchHinted.
  searchHinted(
    query: string,
    hint: DomainHint,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.search(siteOperatorQuery(query, hint.hosts), limit, signal);
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const wait = this.lastRequestAt + requestSpacingMs() - Date.now();
    if (wait > 0) await sleep(wait, signal);
    this.lastRequestAt = Date.now();
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
      signal: searchTimeoutSignal(signal),
    });
    // DDG signals "slow down" as 202 (anomaly check), 403, or 429 depending
    // on which layer trips first.
    if (res.status === 202 || res.status === 403 || res.status === 429) {
      throw new SearchRateLimitError(this.name, `HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`duckduckgo ${res.status} ${res.statusText}`);
    const html = await res.text();
    const results = parseDuckDuckGoHTML(html, limit);
    // Only inspect for a challenge page when parsing found nothing — a page
    // with real results is never the challenge, so this can't false-positive
    // on a snippet that merely mentions the marker strings.
    if (results.length === 0 && looksLikeDdgChallenge(html)) {
      throw new SearchRateLimitError(this.name, "challenge page returned");
    }
    return results;
  }
}

// Exported for unit tests. Markers seen on DDG's bot-challenge / anomaly
// page. indexOf-style scanning, no HTML regex (CodeQL: js/bad-tag-filter).
export function looksLikeDdgChallenge(html: string): boolean {
  return (
    html.includes("anomaly-modal") ||
    html.includes("challenge-form") ||
    html.toLowerCase().includes("bots use duckduckgo too")
  );
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
