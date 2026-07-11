// Stack Exchange search adapter. No API key (keyless requests are rate-limited
// but fine for interactive research). Searches one site (default
// stackoverflow; override with DEEPDIVE_STACKEXCHANGE_SITE). A fit for
// concrete "how do I X" / error-message questions. The kept source is the
// question page; deepdive's fetch step pulls the question + answers.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";
import { keywordLadder } from "../query-keywords.js";

interface SEItem {
  title?: string;
  link?: string;
  score?: number;
  answer_count?: number;
  is_answered?: boolean;
}

// The network's flagship sites live on their OWN domains, not subdomains of
// stackexchange.com (#130's scorer lesson, needed adapter-side too).
const SE_FLAGSHIP_DOMAINS: Record<string, string> = {
  stackoverflow: "stackoverflow.com",
  serverfault: "serverfault.com",
  superuser: "superuser.com",
  askubuntu: "askubuntu.com",
  mathoverflow: "mathoverflow.net",
};

export class StackExchangeSearch implements SearchAdapter {
  readonly name = "stackexchange";
  // #157 — the API answers for exactly one site, and /search/advanced is
  // literal-match: it can neither serve another host nor act on a domain
  // hint. Declaring the serving set lets the structural gates (hinted retry,
  // allow-domain fallback) skip this adapter instead of burning keyless
  // calls walking the keyword ladder over an unsatisfiable query — the
  // exact waste #157's live receipt showed.
  readonly servesDomains: readonly string[];
  constructor(private readonly site: string = "stackoverflow") {
    this.servesDomains = [SE_FLAGSHIP_DOMAINS[site] ?? `${site}.stackexchange.com`];
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    // /search/advanced is literal-match against the question corpus, so the
    // planner's long natural-language queries routinely return ZERO — even for
    // error-message questions the network is full of answers to (#131; the
    // same failure #86 fixed for wikipedia). When the verbatim query finds
    // nothing, walk progressively shorter keyword variants (4 → 2 → 1 leading
    // content tokens) until one hits. At most 3 extra calls against a keyless
    // API, and only on the would-have-been-empty path.
    const verbatim = await this.searchRaw(query, limit, signal);
    if (verbatim.length > 0) return verbatim;
    for (const variant of keywordLadder(query)) {
      const results = await this.searchRaw(variant, limit, signal);
      if (results.length > 0) return results;
    }
    return [];
  }

  private async searchRaw(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
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
