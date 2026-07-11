// Multi-adapter fan-out. `--search=multi:duckduckgo,wikipedia,arxiv` queries
// several backends concurrently and interleaves their results round-robin —
// one general-web engine plus one or two domain engines gives the planner a
// source pool no single backend returns. Partial failures are tolerated (a
// throttled backend shouldn't sink the round); it throws only when EVERY
// sub-adapter failed, so the agent's zero-source handling still fires.

import { dedupeKey } from "../url-util.js";
import { domainHintTokens, isRateLimitError, SearchRateLimitError } from "../search.js";
import type { DomainHint, SearchAdapter, SearchResult, SubAdapterFailure } from "../search.js";
import { rankByAuthority, type SourceAuthorityMode } from "../source-authority.js";
import { extractKeywords } from "../query-keywords.js";

export class MultiSearch implements SearchAdapter {
  readonly name: string;
  // Sub-adapters that failed on the most recent search() while others
  // succeeded — reset per call (a fully-failed call throws instead). The
  // agent duck-reads this after each call (same pattern as AutoSearch's
  // lastEngine) and surfaces it as a `search.degraded` event; without it, a
  // silently rate-limited backend hides inside partial-failure tolerance and
  // the user never learns why the source pool got thin.
  lastFailures: SubAdapterFailure[] = [];
  // A sub-adapter that rate-limits once is benched for the rest of this
  // instance's lifetime (= the run): re-asking a limiter that just refused
  // wastes time and digs the throttle hole deeper. Benched adapters keep
  // appearing in lastFailures so the degradation stays visible per query.
  private benched = new Set<string>();

  constructor(
    private readonly adapters: SearchAdapter[],
    // #111 P4 — search-side bias toward primary sources. When set to
    // "prefer"/"strict", the merged fan-out pool is reordered by domain
    // authority BEFORE the slot cap, so an authoritative backend's results
    // aren't truncated by a general-web backend that search ranked first. The
    // keep-stage (agent.ts) only re-ranks candidates the search already
    // returned; it can't recover a primary source the search `limit` dropped.
    // Defaults to "off" so library callers and the unit tests keep the plain
    // round-robin order; the CLI threads the resolved config value through.
    private readonly authorityMode: SourceAuthorityMode = "off",
  ) {
    if (adapters.length < 2) {
      throw new Error("multi search needs at least two sub-adapters (multi:a,b)");
    }
    this.name = `multi(${adapters.map((a) => a.name).join(",")})`;
  }

  // #147 — the fan-out's serving set is the union of its sub-adapters', and
  // only knowable when EVERY sub-adapter declares one: a single open-web
  // backend (ddg, searxng, news…) means results can come from anywhere, so
  // the whole fan-out reports open web (undefined).
  get servesDomains(): readonly string[] | undefined {
    const sets = this.adapters.map((a) => a.servesDomains);
    if (sets.some((s) => s === undefined)) return undefined;
    return [...new Set(sets.flatMap((s) => [...s!]))];
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.fanOut(query, limit, (a) => a.search(query, limit, signal));
  }

  // #157 — dispatch an allow-domain hint per sub-adapter: engine-syntax
  // backends run their own site: form; fixed-domain backends are SKIPPED
  // (they cannot act on a hint, and the plain pass already asked them — a
  // literal-match API re-walking its keyword ladder over an unsatisfiable
  // hinted string was the receipted waste this fixes); open-web backends
  // without query syntax get the token form. When no sub-adapter can act on
  // the hint at all, resolves to [] — that's "nothing to try", not a failure.
  async searchHinted(
    query: string,
    hint: DomainHint,
    limit: number,
    signal?: AbortSignal,
  ): Promise<SearchResult[]> {
    return this.fanOut(
      query,
      limit,
      (a) =>
        a.searchHinted
          ? a.searchHinted(query, hint, limit, signal)
          : a.search(domainHintTokens(query, hint.hosts), limit, signal),
      (a) => a.searchHinted !== undefined || a.servesDomains === undefined,
    );
  }

  // Shared fan-out machinery: benched bookkeeping, partial-failure tolerance,
  // all-failed classification, authority-and-relevance-ordered merge.
  private async fanOut(
    query: string,
    limit: number,
    run: (a: SearchAdapter) => Promise<SearchResult[]>,
    eligible?: (a: SearchAdapter) => boolean,
  ): Promise<SearchResult[]> {
    this.lastFailures = this.adapters
      .filter((a) => this.benched.has(a.name))
      .map((a) => ({
        adapter: a.name,
        message: "rate-limited earlier in this run; skipped",
        rateLimited: true,
      }));
    let active = this.adapters.filter((a) => !this.benched.has(a.name));
    if (active.length === 0) {
      throw new SearchRateLimitError(this.name, "every sub-adapter is rate-limited");
    }
    if (eligible) {
      active = active.filter(eligible);
      if (active.length === 0) return [];
    }
    const settled = await Promise.allSettled(
      // Ask each backend for the full limit — each ranks its own world and
      // interleave + dedupe below trims the merged pool back down.
      active.map((a) => run(a)),
    );
    const lists: SearchResult[][] = [];
    const failures: string[] = [];
    let rateLimitedFailures = 0;
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") {
        lists.push(s.value);
        return;
      }
      const adapter = active[i].name;
      const rateLimited = isRateLimitError(s.reason);
      if (rateLimited) {
        this.benched.add(adapter);
        rateLimitedFailures++;
      }
      const message = s.reason instanceof Error ? s.reason.message : String(s.reason);
      failures.push(`${adapter}: ${message}`);
      this.lastFailures.push({ adapter, message, rateLimited });
    });
    if (lists.length === 0) {
      // When EVERY backend failed because of throttling, classify the
      // aggregate as a rate limit so the agent stops re-asking this round.
      // A mixed failure set stays a plain error — some backend might serve
      // the next query fine.
      if (rateLimitedFailures === failures.length) {
        throw new SearchRateLimitError(this.name, failures.join(" · "));
      }
      throw new Error(`multi: every sub-adapter failed — ${failures.join(" · ")}`);
    }
    // #148 — the query's content tokens break authority ties in the merged
    // pool, so a uniform-tier fan-out (e.g. wikipedia dominating a reputable
    // pool) is ordered by topical fit rather than raw interleave order.
    return interleaveResults(lists, limit, this.authorityMode, extractKeywords(query));
  }
}

// Exported for unit tests. Round-robin interleave across the lists in adapter
// order (a[0], b[0], c[0], a[1], …), dedupe on the normalized URL (first
// occurrence wins), then cap at `limit` and re-rank densely from 1.
//
// With `authorityMode` off (default) the cap is applied while merging, so the
// plain round-robin order is preserved exactly. With "prefer"/"strict" the
// full deduped pool is merged first and then reordered by domain authority
// (rankByAuthority — same primitive the keep-stage uses) BEFORE the cap, so a
// primary source that search ranked low still wins a slot instead of being
// truncated by a farm that ranked first. "strict" additionally drops known
// content farms, with rankByAuthority's min-keep floor (an all-farm round
// still returns sources).
export function interleaveResults(
  lists: SearchResult[][],
  limit: number,
  authorityMode: SourceAuthorityMode = "off",
  // #148 — optional query content tokens; when present (and biasing is on),
  // equal-authority entries are ordered by title+snippet overlap with them.
  relevanceTerms: readonly string[] = [],
): SearchResult[] {
  // When biasing is on, merge the whole deduped pool (cap = Infinity) so the
  // authority sort decides which entries win the limited slots rather than
  // raw search order.
  const cap = authorityMode === "off" ? limit : Infinity;
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && merged.length < cap; i++) {
    for (const list of lists) {
      if (merged.length >= cap) break;
      const r = list[i];
      if (!r) continue;
      const key = dedupeKey(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(r);
    }
  }
  const ordered =
    authorityMode === "off"
      ? merged
      : rankByAuthority(merged, (r) => r.url, authorityMode, {
          terms: relevanceTerms,
          textOf: (r) => `${r.title} ${r.snippet}`,
        });
  return ordered.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
}
