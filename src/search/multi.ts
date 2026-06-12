// Multi-adapter fan-out. `--search=multi:duckduckgo,wikipedia,arxiv` queries
// several backends concurrently and interleaves their results round-robin —
// one general-web engine plus one or two domain engines gives the planner a
// source pool no single backend returns. Partial failures are tolerated (a
// throttled backend shouldn't sink the round); it throws only when EVERY
// sub-adapter failed, so the agent's zero-source handling still fires.

import { dedupeKey } from "../url-util.js";
import { isRateLimitError, SearchRateLimitError } from "../search.js";
import type { SearchAdapter, SearchResult, SubAdapterFailure } from "../search.js";

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

  constructor(private readonly adapters: SearchAdapter[]) {
    if (adapters.length < 2) {
      throw new Error("multi search needs at least two sub-adapters (multi:a,b)");
    }
    this.name = `multi(${adapters.map((a) => a.name).join(",")})`;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    this.lastFailures = this.adapters
      .filter((a) => this.benched.has(a.name))
      .map((a) => ({
        adapter: a.name,
        message: "rate-limited earlier in this run; skipped",
        rateLimited: true,
      }));
    const active = this.adapters.filter((a) => !this.benched.has(a.name));
    if (active.length === 0) {
      throw new SearchRateLimitError(this.name, "every sub-adapter is rate-limited");
    }
    const settled = await Promise.allSettled(
      // Ask each backend for the full limit — each ranks its own world and
      // interleave + dedupe below trims the merged pool back down.
      active.map((a) => a.search(query, limit, signal)),
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
    return interleaveResults(lists, limit);
  }
}

// Exported for unit tests. Round-robin interleave across the lists in adapter
// order (a[0], b[0], c[0], a[1], …), dedupe on the normalized URL (first
// occurrence wins), re-rank densely from 1, cap at limit.
export function interleaveResults(lists: SearchResult[][], limit: number): SearchResult[] {
  const out: SearchResult[] = [];
  const seen = new Set<string>();
  const longest = Math.max(0, ...lists.map((l) => l.length));
  for (let i = 0; i < longest && out.length < limit; i++) {
    for (const list of lists) {
      if (out.length >= limit) break;
      const r = list[i];
      if (!r) continue;
      const key = dedupeKey(r.url);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ ...r, rank: out.length + 1 });
    }
  }
  return out;
}
