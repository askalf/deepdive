// Main agent loop.
//
// Single-pass mode (default): plan → search → fetch → extract → synthesize.
// Deep mode (--deep[=N]): after the first synthesis, a critic LLM reviews the
// draft, proposes follow-up queries, and the loop runs another round. Up to
// `maxRounds` extra rounds, bounded by the source cap.
//
// Fetching is concurrent (configurable via browser.concurrency) and optionally
// backed by an on-disk cache (src/cache.ts) so re-running a question is cheap.

import type { LLMConfig } from "./llm.js";
import type { SearchAdapter } from "./search.js";
import { dedupeByUrl } from "./search.js";
import { planQueries, critique, type Plan, type Critique } from "./plan.js";
import { BrowserSession, type BrowserOptions, type FetchedPage } from "./browser.js";
import { extractContent } from "./extract.js";
import { buildSourceTable, renderAnswerMarkdown, type Source } from "./citations.js";
import { synthesize, type SourceWithContent } from "./synthesize.js";
import type { PageCache } from "./cache.js";
import { runConcurrent } from "./concurrency.js";
import {
  canFetch,
  DEFAULT_USER_AGENT,
  type RobotsCache,
} from "./robots.js";

// Minimal surface the agent needs from a browser. BrowserSession satisfies it;
// tests pass a mock with the same shape.
export interface BrowserLike {
  start(): Promise<void>;
  fetch(url: string): Promise<FetchedPage>;
  close(): Promise<void>;
}

export interface AgentConfig {
  llm: LLMConfig;
  search: SearchAdapter;
  browser: BrowserOptions;
  resultsPerQuery: number;
  maxSources: number;
  maxWordsPerSource: number;
  deepRounds: number;
  concurrency: number;
  cache?: PageCache;
  browserFactory?: (opts: BrowserOptions) => BrowserLike;
  // Respect robots.txt when true (default). Network errors fetching robots
  // return "unknown" and we err on the side of fetching. --ignore-robots in
  // the CLI flips this to false.
  respectRobots?: boolean;
  robotsUserAgent?: string;
  robotsCache?: RobotsCache;
  onEvent?: (event: AgentEvent) => void;
  // Fires for each SSE token emitted by the synthesizer. When set, the agent
  // uses the streaming LLM path for synthesize() calls. CLI callers enable
  // this only in single-pass, non-JSON, TTY mode so tokens can land on
  // stdout live.
  onSynthesizeToken?: (chunk: string, round: number) => void;
}

export type AgentEvent =
  | { type: "plan.start"; question: string }
  | { type: "plan.done"; plan: Plan }
  | { type: "round.start"; round: number; queries: string[] }
  | { type: "search.start"; query: string }
  | { type: "search.done"; query: string; count: number }
  | { type: "fetch.start"; url: string; cached: boolean }
  | {
      type: "fetch.done";
      url: string;
      ok: boolean;
      status: number;
      words: number;
      cached: boolean;
    }
  | { type: "fetch.skipped"; url: string; reason: "robots" }
  | { type: "synthesize.start"; sourceCount: number; round: number }
  | { type: "synthesize.done"; round: number }
  | { type: "critique.start"; round: number }
  | { type: "critique.done"; round: number; critique: Critique };

export interface RoundTrace {
  round: number;
  queries: string[];
  candidatesFound: number;
  fetched: number;
  kept: number;
  critique?: Critique;
}

export interface AgentResult {
  question: string;
  plan: Plan;
  sources: Source[];
  answer: string;
  markdown: string;
  rounds: RoundTrace[];
  usage: {
    queries: number;
    fetched: number;
    kept: number;
    rounds: number;
    cacheHits: number;
  };
}

type Candidate = { url: string; title: string; snippet: string; query: string };

export async function runAgent(
  question: string,
  config: AgentConfig,
  signal?: AbortSignal,
): Promise<AgentResult> {
  emit(config, { type: "plan.start", question });
  const plan = await planQueries(question, config.llm, signal);
  emit(config, { type: "plan.done", plan });

  const seenUrls = new Set<string>();
  const allCandidates: Candidate[] = [];
  const allQueries: string[] = [];
  const keptSources: SourceWithContent[] = [];
  const rounds: RoundTrace[] = [];

  let browser: BrowserLike | null = null;
  let answer = "";
  const makeBrowser =
    config.browserFactory ?? ((opts: BrowserOptions) => new BrowserSession(opts));

  async function ensureBrowser(): Promise<BrowserLike> {
    if (browser) return browser;
    browser = makeBrowser(config.browser);
    await browser.start();
    return browser;
  }

  try {
    const maxRoundsTotal = 1 + Math.max(0, config.deepRounds);
    let queriesForRound = plan.queries;

    for (let round = 0; round < maxRoundsTotal; round++) {
      if (signal?.aborted) throw new Error("aborted");
      if (queriesForRound.length === 0) break;

      emit(config, { type: "round.start", round, queries: queriesForRound });
      allQueries.push(...queriesForRound);

      const candidatesBefore = allCandidates.length;
      for (const query of queriesForRound) {
        if (signal?.aborted) throw new Error("aborted");
        emit(config, { type: "search.start", query });
        const results = await config.search.search(
          query,
          config.resultsPerQuery,
          signal,
        );
        const fresh = dedupeByUrl(results).filter((r) => !seenUrls.has(r.url));
        for (const r of fresh) {
          seenUrls.add(r.url);
          allCandidates.push({
            url: r.url,
            title: r.title,
            snippet: r.snippet,
            query,
          });
        }
        emit(config, { type: "search.done", query, count: fresh.length });
      }
      const candidatesFoundThisRound = allCandidates.length - candidatesBefore;

      const headroom = Math.max(0, config.maxSources - keptSources.length);
      const toFetch = allCandidates
        .slice(candidatesBefore)
        .slice(0, Math.max(headroom, candidatesFoundThisRound));

      const fetched = await fetchMany(toFetch, config, ensureBrowser, signal);

      for (const f of fetched) {
        if (keptSources.length >= config.maxSources) break;
        if (f.page.status >= 200 && f.page.status < 400 && f.words > 50) {
          const sourceId = keptSources.length + 1;
          const extracted = extractContent(
            f.page.text,
            f.page.title || f.candidate.title,
            config.maxWordsPerSource,
          );
          if (extracted.text.length === 0) continue;
          keptSources.push({
            id: sourceId,
            url: f.page.finalUrl || f.page.url,
            title: f.page.title || f.candidate.title,
            fetchedAt: f.page.fetchedAt,
            content: extracted.text,
          });
        }
      }

      emit(config, {
        type: "synthesize.start",
        sourceCount: keptSources.length,
        round,
      });
      const tokenSink = config.onSynthesizeToken
        ? (chunk: string) => config.onSynthesizeToken!(chunk, round)
        : undefined;
      answer = await synthesize(
        question,
        keptSources,
        config.llm,
        signal,
        tokenSink,
      );
      emit(config, { type: "synthesize.done", round });

      const roundTrace: RoundTrace = {
        round,
        queries: queriesForRound,
        candidatesFound: candidatesFoundThisRound,
        fetched: fetched.length,
        kept: keptSources.length,
      };

      const isLastPossibleRound = round === maxRoundsTotal - 1;
      if (!isLastPossibleRound && keptSources.length < config.maxSources) {
        emit(config, { type: "critique.start", round });
        const crit = await critique(
          question,
          answer,
          allQueries,
          config.llm,
          signal,
        );
        emit(config, { type: "critique.done", round, critique: crit });
        roundTrace.critique = crit;
        rounds.push(roundTrace);
        if (crit.done || crit.queries.length === 0) break;
        queriesForRound = crit.queries;
      } else {
        rounds.push(roundTrace);
        break;
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => undefined);
  }

  const sourceTable = buildSourceTable(
    keptSources.map((s) => ({ url: s.url, title: s.title, fetchedAt: s.fetchedAt })),
  );
  // Rebind ids to the final table order (keptSources already assigned ids).
  for (let i = 0; i < keptSources.length; i++) {
    keptSources[i].id = sourceTable[i].id;
  }

  const markdown = renderAnswerMarkdown(question, answer, keptSources);

  return {
    question,
    plan,
    sources: keptSources,
    answer,
    markdown,
    rounds,
    usage: {
      queries: allQueries.length,
      fetched: rounds.reduce((sum, r) => sum + r.fetched, 0),
      kept: keptSources.length,
      rounds: rounds.length,
      cacheHits: config.cache?.hits ?? 0,
    },
  };
}

interface FetchOutcome {
  candidate: Candidate;
  page: FetchedPage;
  words: number;
  cached: boolean;
}

async function fetchMany(
  candidates: Candidate[],
  config: AgentConfig,
  ensureBrowser: () => Promise<BrowserLike>,
  signal?: AbortSignal,
): Promise<FetchOutcome[]> {
  const results = await runConcurrent(
    candidates,
    config.concurrency,
    async (c) => fetchOne(c, config, ensureBrowser),
    signal,
  );
  return results.filter((r): r is FetchOutcome => r !== null);
}

async function fetchOne(
  c: Candidate,
  config: AgentConfig,
  ensureBrowser: () => Promise<BrowserLike>,
): Promise<FetchOutcome | null> {
  if (config.respectRobots !== false) {
    const ua = config.robotsUserAgent ?? DEFAULT_USER_AGENT;
    const result = await canFetch(c.url, {
      userAgent: ua,
      cache: config.robotsCache,
    });
    if (result === "deny") {
      emit(config, { type: "fetch.skipped", url: c.url, reason: "robots" });
      return null;
    }
  }
  if (config.cache) {
    const cached = await config.cache.get(c.url);
    if (cached) {
      const words = (cached.text.match(/\S+/g) ?? []).length;
      emit(config, { type: "fetch.start", url: c.url, cached: true });
      emit(config, {
        type: "fetch.done",
        url: c.url,
        ok: cached.status >= 200 && cached.status < 400,
        status: cached.status,
        words,
        cached: true,
      });
      return { candidate: c, page: cached, words, cached: true };
    }
  }
  emit(config, { type: "fetch.start", url: c.url, cached: false });
  try {
    const browser = await ensureBrowser();
    const page = await browser.fetch(c.url);
    const words = (page.text.match(/\S+/g) ?? []).length;
    if (config.cache && page.status >= 200 && page.status < 400) {
      await config.cache.put(c.url, page).catch(() => undefined);
    }
    emit(config, {
      type: "fetch.done",
      url: c.url,
      ok: page.status >= 200 && page.status < 400,
      status: page.status,
      words,
      cached: false,
    });
    return { candidate: c, page, words, cached: false };
  } catch {
    emit(config, {
      type: "fetch.done",
      url: c.url,
      ok: false,
      status: 0,
      words: 0,
      cached: false,
    });
    return null;
  }
}

function emit(config: AgentConfig, event: AgentEvent): void {
  config.onEvent?.(event);
}
