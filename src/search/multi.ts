// Multi-adapter fan-out. `--search=multi:duckduckgo,wikipedia,arxiv` queries
// several backends concurrently and interleaves their results round-robin —
// one general-web engine plus one or two domain engines gives the planner a
// source pool no single backend returns. Partial failures are tolerated (a
// throttled backend shouldn't sink the round); it throws only when EVERY
// sub-adapter failed, so the agent's zero-source handling still fires.

import { dedupeKey } from "../url-util.js";
import type { SearchAdapter, SearchResult } from "../search.js";

export class MultiSearch implements SearchAdapter {
  readonly name: string;

  constructor(private readonly adapters: SearchAdapter[]) {
    if (adapters.length < 2) {
      throw new Error("multi search needs at least two sub-adapters (multi:a,b)");
    }
    this.name = `multi(${adapters.map((a) => a.name).join(",")})`;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const settled = await Promise.allSettled(
      // Ask each backend for the full limit — each ranks its own world and
      // interleave + dedupe below trims the merged pool back down.
      this.adapters.map((a) => a.search(query, limit, signal)),
    );
    const lists: SearchResult[][] = [];
    const failures: string[] = [];
    settled.forEach((s, i) => {
      if (s.status === "fulfilled") lists.push(s.value);
      else {
        failures.push(
          `${this.adapters[i].name}: ${s.reason instanceof Error ? s.reason.message : String(s.reason)}`,
        );
      }
    });
    if (lists.length === 0) {
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
