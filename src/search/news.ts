// News search adapter. No API key. Uses the Bing News RSS endpoint
// (bing.com/news/search?format=rss), which returns an RSS 2.0 feed of recent,
// dated news articles. A fit for recency-sensitive questions ("what was
// released in the last six months", "what happened with X") where the
// general-web engines surface stale evergreen pages and Wikipedia lags
// current events — the gap that benched 1/3 sources on the `recent` golden
// question under DDG rate-limiting.
//
// Same hand-rolled-parser stance as the arXiv/DDG adapters. Bing wraps each
// result link in a bing.com/news/apiclick.aspx redirect whose `url` query
// param carries the real publisher URL — decode it so deepdive fetches (and
// cites) the publisher directly. Each item's pubDate is prefixed to the
// snippet so the planner/synthesizer can see recency at a glance; the
// fetch-stage date extraction still governs --since filtering.

import {
  searchTimeoutSignal,
  SearchRateLimitError,
  type SearchAdapter,
  type SearchResult,
} from "../search.js";
import { decodeHtmlEntities } from "./duckduckgo.js";

export class NewsSearch implements SearchAdapter {
  readonly name = "news";

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://www.bing.com/news/search");
    url.searchParams.set("q", query);
    url.searchParams.set("format", "rss");
    const res = await fetch(url, {
      headers: {
        accept: "application/rss+xml, application/xml, text/xml",
        "user-agent": "deepdive (+https://github.com/askalf/deepdive)",
      },
      signal: searchTimeoutSignal(signal),
    });
    if (res.status === 403 || res.status === 429) {
      throw new SearchRateLimitError("news", `HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`news ${res.status} ${res.statusText}`);
    return parseNewsRss(await res.text(), limit);
  }
}

// Exported for unit tests. Pure RSS 2.0 parser: pulls title / publisher link /
// pubDate / description from each <item>. Items missing a usable link or
// title are skipped rather than failing the parse.
export function parseNewsRss(xml: string, limit: number): SearchResult[] {
  const results: SearchResult[] = [];
  const itemRe = /<item\b[^>]*>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) !== null) {
    const item = m[1];
    const url = resolvePublisherUrl(decodeHtmlEntities(tag(item, "link")).trim());
    const title = clean(tag(item, "title"));
    if (!url || !title) continue;
    const date = isoDate(tag(item, "pubDate"));
    // Bing entity-encodes the markup inside <description>, so decode FIRST,
    // then strip the now-real tags.
    const desc = stripTags(decodeHtmlEntities(tag(item, "description")))
      .replace(/\s+/g, " ")
      .trim();
    results.push({
      url,
      title,
      snippet: date ? (desc ? `${date} — ${desc}` : date) : desc,
      rank: results.length + 1,
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

function stripTags(s: string): string {
  return s.replace(/<[^>]*>/g, " ");
}

// RSS pubDate is RFC 1123 ("Wed, 10 Jun 2026 17:46:00 GMT"). Reduce to a
// YYYY-MM-DD snippet prefix; an unparseable date just drops the prefix.
function isoDate(raw: string): string {
  const t = Date.parse(raw.trim());
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

// Bing wraps result links as
//   bing.com/news/apiclick.aspx?...&url=<urlencoded publisher URL>&...
// Unwrap to the publisher URL; a non-redirect link passes through. Anything
// that isn't a plain http(s) URL is rejected (the caller skips the item).
export function resolvePublisherUrl(link: string): string | null {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (/(^|\.)bing\.com$/.test(u.hostname) && u.pathname.includes("apiclick")) {
    const target = u.searchParams.get("url");
    if (!target) return null;
    try {
      const t = new URL(target);
      if (t.protocol !== "http:" && t.protocol !== "https:") return null;
      return t.toString();
    } catch {
      return null;
    }
  }
  return u.toString();
}
