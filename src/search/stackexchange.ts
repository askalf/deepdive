// Stack Exchange search adapter. No API key (keyless requests are rate-limited
// but fine for interactive research). Searches one site (default
// stackoverflow; override with DEEPDIVE_STACKEXCHANGE_SITE). A fit for
// concrete "how do I X" / error-message questions. The kept source is the
// question page; deepdive's fetch step pulls the question + answers.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface SEItem {
  title?: string;
  link?: string;
  score?: number;
  answer_count?: number;
  is_answered?: boolean;
}

export class StackExchangeSearch implements SearchAdapter {
  readonly name = "stackexchange";
  constructor(private readonly site: string = "stackoverflow") {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.stackexchange.com/2.3/search/advanced");
    url.searchParams.set("order", "desc");
    url.searchParams.set("sort", "relevance");
    url.searchParams.set("q", query);
    url.searchParams.set("site", this.site);
    url.searchParams.set("pagesize", String(Math.min(Math.max(limit, 1), 50)));
    const res = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "deepdive (+https://github.com/askalf/deepdive)" },
      signal: searchTimeoutSignal(signal),
    });
    if (!res.ok) throw new Error(`stackexchange ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { items?: SEItem[]; error_message?: string };
    if (json.error_message) throw new Error(`stackexchange: ${json.error_message}`);
    return mapStackExchangeItems(json.items ?? [], limit);
  }
}

// Exported for unit tests. Pure mapper. Snippet carries the score + answered
// state so the planner/critic can weigh a well-vetted answer.
export function mapStackExchangeItems(items: SEItem[], limit: number): SearchResult[] {
  return items
    .filter((it) => typeof it.link === "string" && it.link.length > 0)
    .slice(0, limit)
    .map((it, i) => ({
      url: it.link as string,
      title: decodeEntities(it.title ?? ""),
      snippet: seSnippet(it),
      rank: i + 1,
    }));
}

function seSnippet(it: SEItem): string {
  const parts: string[] = [];
  if (typeof it.score === "number") parts.push(`score ${it.score}`);
  if (typeof it.answer_count === "number") {
    parts.push(`${it.answer_count} answer${it.answer_count === 1 ? "" : "s"}`);
  }
  if (it.is_answered) parts.push("accepted");
  return parts.join(" · ");
}

// SE titles arrive HTML-entity-encoded (e.g. &quot;, &#39;). Decode the common
// ones so the title reads cleanly. Pure, single-pass.
function decodeEntities(s: string): string {
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" };
  return s.replace(/&(#\d+|[a-zA-Z]+);/g, (m, name) => {
    if (name in named) return named[name];
    if (name[0] === "#") {
      const code = Number(name.slice(1));
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    }
    return m;
  });
}
