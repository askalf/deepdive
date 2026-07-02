// Main agent loop.
//
// Single-pass mode (default): plan → search → fetch → extract → synthesize.
// Deep mode (--deep[=N]): after the first synthesis, a critic LLM reviews the
// draft, proposes follow-up queries, and the loop runs another round. Up to
// `maxRounds` extra rounds, bounded by the source cap.
//
// Fetching is concurrent (configurable via browser.concurrency) and optionally
// backed by an on-disk cache (src/cache.ts) so re-running a question is cheap.

import { withModel, type LLMConfig } from "./llm.js";
import type { SearchAdapter, SearchResult, SubAdapterFailure } from "./search.js";
import { dedupeByUrl, isRateLimitError } from "./search.js";
import { rankByAuthority, type SourceAuthorityMode } from "./source-authority.js";
import { planQueries, critique, type Plan, type Critique } from "./plan.js";
import { BrowserSession, type BrowserOptions, type FetchedPage } from "./browser.js";
import { extractContent } from "./extract.js";
import { extractKeywords } from "./query-keywords.js";
import { selectRelevantWindow } from "./relevance-window.js";
import { buildSourceTable, renderAnswerMarkdown, type Source } from "./citations.js";
import { synthesize, type SourceWithContent } from "./synthesize.js";
import {
  verifyCitations as runVerify,
  DEFAULT_CITE_MIN_RECALL,
  type VerificationReport,
} from "./verify.js";
import {
  estimateCostMultiModel,
  priceFor,
  type MultiModelCostEstimate,
} from "./pricing.js";
import { enforceBudget, BudgetExceededError } from "./budget.js";
import {
  extractPdfText,
  PdfExtractorMissingError,
  looksLikePdf,
} from "./pdf.js";
import { ingestLocalPaths } from "./local.js";
import { extractPublishedDate } from "./dates.js";
import {
  contentShingles,
  findNearDuplicate,
  DEFAULT_NEAR_DUPE_THRESHOLD,
} from "./similarity.js";
import { classifyUrl, type DomainFilter } from "./domain-filter.js";
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
  // v0.10.0 — per-stage model overrides. Each falls back to `llm.model`
  // when undefined. Library consumers who want a single model can omit
  // this object entirely; the agent treats undefined-stage as "use base".
  models?: { plan?: string; synth?: string; critique?: string };
  // v0.11.0 — budget cap in USD. After each LLM call, the agent
  // computes the running aggregate cost; if it exceeds `maxCostUsd`,
  // a `BudgetExceededError` is thrown (caught by the CLI; library
  // consumers can catch it directly). Undefined means no cap.
  maxCostUsd?: number;
  // v0.12.0 — session continuation. Sources from a prior run are seeded
  // into the kept-sources pool with their saved content intact; their
  // URLs are added to seenUrls so the fetch loop doesn't re-fetch.
  // Used by the `deepdive continue` subcommand; library consumers can
  // pass any SourceWithContent[] (e.g. from a custom source feed).
  // Ordering: include[] (local files) → preKept (saved) → search-fetched.
  preKept?: SourceWithContent[];
  search: SearchAdapter;
  // v0.20.0 — opt-in recovery adapter. When a round's primary searches
  // produce ZERO candidates (rate-limited, down, or genuinely empty), the
  // round's queries are re-run once through this adapter before the
  // zero-source guard fires. CLI: --search-fallback=wikipedia,arxiv.
  fallbackSearch?: SearchAdapter;
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
  // Citation verification — runs once after the final synthesis. Disabled
  // when verifyCitations === false. Threshold defaults to 0.4.
  verifyCitations?: boolean;
  citeMinRecall?: number;
  // PDF extraction — page cap shared between web-fetched PDFs and local
  // PDFs ingested via include[]. Defaults to 50.
  pdfMaxPages?: number;
  // Local files / dirs to ingest as pre-fetched sources. PDFs in this
  // list need pdfjs-dist installed; missing module → file is skipped.
  include?: string[];
  // Hostname-suffix filters applied between search and fetch.
  // - allow non-empty → URL must match at least one
  // - deny non-empty → URL must not match any
  // - both non-empty → allow takes precedence then deny is checked
  domainFilter?: DomainFilter;
  // Environment passed through to pricing.ts for the unknown-model
  // override case (DEEPDIVE_PRICE_INPUT_PER_MTOK / _OUTPUT_PER_MTOK).
  // Defaults to undefined — the price table covers known models.
  env?: Record<string, string | undefined>;
  // v0.14.0 — when true, the synthesizer leads with a one-paragraph TL;DR.
  // Opt-in (CLI --tldr); default off keeps output identical to v0.13.
  tldr?: boolean;
  // v0.15.0 — recency filter. When set, a fetched web source whose extracted
  // publication date is older than this epoch-ms cutoff is dropped (emits a
  // `stale` skip). Sources with no extractable date are kept (not penalized
  // for missing metadata). Does not apply to include[]/preKept sources.
  sinceMs?: number;
  // v0.17.0 — near-duplicate dedup. A fetched source whose extracted content
  // is ≥ `nearDupeThreshold` Jaccard-similar (word 5-gram shingles) to an
  // already-kept source is dropped with a `near-duplicate` skip — catches the
  // same article syndicated across hosts, which URL dedupe can't. Default ON
  // (the conservative 0.9 threshold only fires on genuine copies); disable
  // with dedupeNearDupes: false (CLI --no-dedupe).
  dedupeNearDupes?: boolean;
  nearDupeThreshold?: number;
  // #111 — domain-authority ranking of candidates at the keep stage. "prefer"
  // (default) ranks high-authority sources into the limited fetch slots first;
  // "strict" additionally drops known content farms (with a min-keep floor);
  // "off" keeps search order. Undefined is treated as "prefer".
  sourceAuthority?: SourceAuthorityMode;
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
  // v0.20.0 — a search call failed. The agent records it and moves on to the
  // next query instead of killing the run; when rateLimited it also skips the
  // round's remaining queries (they'd hit the same limiter).
  | { type: "search.error"; query: string; message: string; rateLimited: boolean }
  // v0.20.0 — the round's primary searches produced zero candidates and the
  // configured fallback adapter is about to re-run the round's queries.
  | { type: "search.fallback"; adapter: string; queries: string[] }
  // v0.21.0 — a fan-out (multi:) search succeeded but one or more of its
  // sub-adapters failed. Without this, a rate-limited backend hides inside
  // multi's partial-failure tolerance and the source pool thins silently.
  | { type: "search.degraded"; query: string; failures: SubAdapterFailure[] }
  | { type: "fetch.start"; url: string; cached: boolean }
  | {
      type: "fetch.done";
      url: string;
      ok: boolean;
      status: number;
      words: number;
      cached: boolean;
    }
  | {
      type: "fetch.skipped";
      url: string;
      reason:
        | "robots"
        | "pdf-no-extractor"
        | "pdf-extract-error"
        | "domain-deny"
        | "domain-not-allowed"
        | "stale"
        | "near-duplicate";
    }
  | { type: "include.done"; ingested: number; skipped: number }
  | { type: "synthesize.start"; sourceCount: number; round: number }
  | { type: "synthesize.done"; round: number }
  | { type: "critique.start"; round: number }
  | { type: "critique.done"; round: number; critique: Critique }
  | { type: "verify.done"; report: VerificationReport }
  | {
      type: "llm.call";
      phase: "plan" | "synth" | "critique";
      round: number;
      inputTokens: number;
      outputTokens: number;
      // v0.10.0 — the model actually used for this call. Will equal
      // config.llm.model for stages that don't override.
      model: string;
    };

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
  // Includes the full extracted content per source — needed by the
  // session-persistence path (so `deepdive resume <id>` can re-synthesize
  // without re-fetching). SourceWithContent extends Source, so existing
  // consumers reading `id` / `url` / `title` / `fetchedAt` are unaffected.
  sources: SourceWithContent[];
  answer: string;
  markdown: string;
  rounds: RoundTrace[];
  verification?: VerificationReport;
  // v0.10.0: MultiModelCostEstimate (extends CostEstimate). Library
  // consumers reading the existing `amountUsd` / `inputTokens` / etc.
  // fields keep working; the new `byModel` array is additive.
  cost: MultiModelCostEstimate;
  usage: {
    queries: number;
    fetched: number;
    kept: number;
    rounds: number;
    cacheHits: number;
    citationsTotal: number;
    citationsSupported: number;
    llm: {
      inputTokens: number;
      outputTokens: number;
      calls: number;
    };
    estimatedCostUsd: number;
  };
}

type Candidate = { url: string; title: string; snippet: string; query: string };

export interface SearchErrorInfo {
  query: string;
  message: string;
  rateLimited: boolean;
}

// v0.20.0 — thrown instead of synthesizing when zero sources survived the
// search + fetch + filter pipeline. Synthesizing over an empty source packet
// burns an LLM call to produce a guaranteed "unable to answer" (observed in
// the wild when DDG silently rate-limits a burst of queries). Failing loud
// with diagnostics is cheaper and more honest; the CLI renders a
// what-to-try-next message from the structured fields.
export class NoSourcesError extends Error {
  constructor(
    public readonly adapter: string,
    public readonly queries: string[],
    public readonly candidatesFound: number,
    public readonly searchErrors: SearchErrorInfo[],
  ) {
    const n = queries.length;
    super(
      candidatesFound === 0
        ? `no sources gathered: ${n} quer${n === 1 ? "y" : "ies"} via ${adapter} returned 0 usable results${
            searchErrors.some((e) => e.rateLimited) ? " (rate-limited)" : ""
          }`
        : `no sources gathered: ${candidatesFound} candidate(s) found but none could be fetched and extracted`,
    );
    this.name = "NoSourcesError";
  }
}

export async function runAgent(
  question: string,
  config: AgentConfig,
  signal?: AbortSignal,
): Promise<AgentResult> {
  // v0.10.0 — per-phase LLM config. Each falls back to the base model
  // when AgentConfig.models doesn't override that stage. The same auth /
  // base URL / wire format flows through; only `model` differs.
  const stageLLM: Record<"plan" | "synth" | "critique", LLMConfig> = {
    plan: withModel(config.llm, config.models?.plan ?? config.llm.model),
    synth: withModel(config.llm, config.models?.synth ?? config.llm.model),
    critique: withModel(config.llm, config.models?.critique ?? config.llm.model),
  };

  // Per-model usage accumulator (v0.10.0). Pre-v0.10.0 used a single
  // {inputTokens, outputTokens, calls} aggregator; the multi-model layer
  // is a strict superset — when all three stages use the same model the
  // map has one entry and reduces to the old shape.
  const llmTotalsByModel: Record<string, { inputTokens: number; outputTokens: number; calls: number }> = {};
  const totalsFor = (model: string) => {
    let bucket = llmTotalsByModel[model];
    if (!bucket) {
      bucket = { inputTokens: 0, outputTokens: 0, calls: 0 };
      llmTotalsByModel[model] = bucket;
    }
    return bucket;
  };
  // v0.11.0 — running tally of calls whose model contributed $0 to the
  // aggregate (no PRICE_TABLE entry AND no env override). Surfaced in
  // the BudgetExceededError so the user knows the cap was enforced
  // against the priced subset only.
  let unpricedCallCount = 0;

  const usageSinkFor =
    (phase: "plan" | "synth" | "critique", round: number) =>
    (u: { input_tokens: number; output_tokens: number }) => {
      const model = stageLLM[phase].model;
      const bucket = totalsFor(model);
      bucket.inputTokens += u.input_tokens ?? 0;
      bucket.outputTokens += u.output_tokens ?? 0;
      bucket.calls += 1;
      if (!priceFor(model, config.env)) unpricedCallCount += 1;
      emit(config, {
        type: "llm.call",
        phase,
        round,
        inputTokens: u.input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        model,
      });
      // v0.11.0 — budget check fires AFTER the event emits, so the
      // call that triggered the abort is still visible in the event
      // stream. Throws BudgetExceededError; the agent's outer try/catch
      // (or library consumer's) handles it.
      if (config.maxCostUsd !== undefined) {
        const running = estimateCostMultiModel(llmTotalsByModel, config.env);
        enforceBudget(running, config.maxCostUsd, unpricedCallCount);
      }
    };

  emit(config, { type: "plan.start", question });
  // Date-ground the planner (and disclose the --since window when set) so
  // recency-sensitive queries anchor to the actual current date instead of
  // the model's training-time sense of "recent" — see PlanContext.
  const plan = await planQueries(question, stageLLM.plan, signal, usageSinkFor("plan", 0), {
    sinceMs: config.sinceMs,
  });
  emit(config, { type: "plan.done", plan });

  const seenUrls = new Set<string>();
  const allCandidates: Candidate[] = [];
  const allQueries: string[] = [];
  const searchErrors: SearchErrorInfo[] = [];
  const keptSources: SourceWithContent[] = [];
  // Shingle sets for near-dup detection, lazily synced to keptSources so
  // include[]/preKept entries (pushed below without touching this array)
  // still participate as dedupe anchors.
  const keptShingles: Set<string>[] = [];
  const rounds: RoundTrace[] = [];

  // One pass of a round's queries through an adapter. Mutates the shared
  // candidate pool / seen-URL set / error log; used for the primary adapter
  // every round and for the optional fallback adapter when the primary
  // produced nothing.
  async function runSearchPass(
    adapter: SearchAdapter,
    queries: string[],
  ): Promise<void> {
    for (const query of queries) {
      if (signal?.aborted) throw new Error("aborted");
      emit(config, { type: "search.start", query });
      let results: SearchResult[];
      try {
        results = await adapter.search(query, config.resultsPerQuery, signal);
      } catch (err) {
        // A failed search shouldn't sink the round — record it, surface it
        // as an event, and move on. The zero-source guard below catches the
        // everything-failed case before any synthesis money is spent.
        if (signal?.aborted) throw err;
        const rateLimited = isRateLimitError(err);
        const message = err instanceof Error ? err.message : String(err);
        searchErrors.push({ query, message, rateLimited });
        emit(config, { type: "search.error", query, message, rateLimited });
        // The limiter that refused this query will refuse this pass's
        // remaining queries too — skip them rather than hammer it.
        if (rateLimited) break;
        continue;
      }
      // Partial degradation: a fan-out adapter that succeeded overall may
      // still have lost sub-adapters (duck-read — MultiSearch exposes
      // lastFailures; plain adapters don't have the field).
      const partials = (adapter as { lastFailures?: SubAdapterFailure[] }).lastFailures;
      if (Array.isArray(partials) && partials.length > 0) {
        emit(config, { type: "search.degraded", query, failures: [...partials] });
      }
      const fresh = dedupeByUrl(results).filter((r) => !seenUrls.has(r.url));
      let kept = 0;
      for (const r of fresh) {
        seenUrls.add(r.url);
        if (config.domainFilter) {
          const verdict = classifyUrl(r.url, config.domainFilter);
          if (verdict !== "allow") {
            emit(config, {
              type: "fetch.skipped",
              url: r.url,
              reason:
                verdict === "deny-listed" ? "domain-deny" : "domain-not-allowed",
            });
            continue;
          }
        }
        allCandidates.push({
          url: r.url,
          title: r.title,
          snippet: r.snippet,
          query,
        });
        kept++;
      }
      emit(config, { type: "search.done", query, count: kept });
    }
  }

  // Local file ingestion: pre-fetched sources are placed at the head of
  // the kept-sources list so they get the lowest [N] citation ids and
  // are most prominent to the synthesizer.
  if (config.include && config.include.length > 0) {
    const local = await ingestLocalPaths(config.include, {
      pdfMaxPages: config.pdfMaxPages,
      maxWordsPerSource: config.maxWordsPerSource,
    });
    for (const s of local.sources) {
      if (keptSources.length >= config.maxSources) break;
      keptSources.push({ id: keptSources.length + 1, ...s });
      seenUrls.add(s.url);
    }
    emit(config, {
      type: "include.done",
      ingested: local.sources.length,
      skipped: local.skipped.length,
    });
  }

  // v0.12.0 — session continuation. Pre-fetched sources from a saved
  // session are placed in the kept-sources pool with their original
  // content intact, and their URLs added to seenUrls so the fetch loop
  // doesn't re-fetch what we already have. They appear in the synth's
  // source packet alongside any new sources the planner brings in.
  //
  // preKept comes AFTER `include[]` so local-file ingestion takes
  // precedence if both are set (rare, but the local-file path has
  // explicit user intent attached — they passed a path on this run).
  if (config.preKept && config.preKept.length > 0) {
    for (const s of config.preKept) {
      if (keptSources.length >= config.maxSources) break;
      if (seenUrls.has(s.url)) continue;
      keptSources.push({ ...s, id: keptSources.length + 1 });
      seenUrls.add(s.url);
    }
  }

  let browser: BrowserLike | null = null;
  let browserStarting: Promise<BrowserLike> | null = null;
  let answer = "";
  const makeBrowser =
    config.browserFactory ?? ((opts: BrowserOptions) => new BrowserSession(opts));

  async function ensureBrowser(): Promise<BrowserLike> {
    // Single-flight: every concurrent caller awaits the SAME start() promise, so
    // none can receive a browser that was assigned but not yet started. The
    // previous code returned `browser` from an `if (browser)` guard that could
    // fire while a first caller was still mid-`await browser.start()`. `browser`
    // is still set so the close() in the cleanup path can reach it.
    if (!browserStarting) {
      browserStarting = (async () => {
        const b = makeBrowser(config.browser);
        browser = b;
        await b.start();
        return b;
      })();
    }
    return browserStarting;
  }

  try {
    const maxRoundsTotal = 1 + Math.max(0, config.deepRounds);
    let queriesForRound = plan.queries;

    for (let round = 0; round < maxRoundsTotal; round++) {
      if (signal?.aborted) throw new Error("aborted");
      if (queriesForRound.length === 0) break;

      emit(config, { type: "round.start", round, queries: queriesForRound });
      allQueries.push(...queriesForRound);

      // #145 — content tokens of the question plus this round's queries drive
      // relevance-windowed capping below, so an over-budget source spends its
      // word budget on the spans that can actually answer, not its front
      // matter.
      const relevanceTerms = [
        ...new Set(
          [question, ...queriesForRound].flatMap((q) => extractKeywords(q)),
        ),
      ];

      const candidatesBefore = allCandidates.length;
      await runSearchPass(config.search, queriesForRound);
      // Recovery pass: zero candidates from the primary (throttled, down, or
      // genuinely empty) and a fallback is configured — re-run the round's
      // queries through it once. Runs ALL the round's queries, including any
      // the primary's rate-limit short-circuit skipped.
      if (allCandidates.length === candidatesBefore && config.fallbackSearch) {
        emit(config, {
          type: "search.fallback",
          adapter: config.fallbackSearch.name,
          queries: queriesForRound,
        });
        await runSearchPass(config.fallbackSearch, queriesForRound);
      }
      const candidatesFoundThisRound = allCandidates.length - candidatesBefore;

      const headroom = Math.max(0, config.maxSources - keptSources.length);
      // #111 — rank this round's candidates by domain authority before the
      // slot-limited selection, so authoritative/primary sources win the
      // limited fetch slots ahead of whatever search ranked first. "prefer"
      // (default) only reorders; "strict" may drop known farms; "off" is a
      // no-op. candidatesFoundThisRound is left intact for the round trace.
      const rankedCandidates = rankByAuthority(
        allCandidates.slice(candidatesBefore),
        (c) => c.url,
        config.sourceAuthority ?? "prefer",
      );
      const toFetch = rankedCandidates.slice(
        0,
        Math.min(headroom, rankedCandidates.length),
      );

      const fetched = await fetchMany(toFetch, config, ensureBrowser, signal);

      for (const f of fetched) {
        if (keptSources.length >= config.maxSources) break;
        if (!(f.page.status >= 200 && f.page.status < 400)) continue;

        const isPdf =
          f.page.bytes !== undefined &&
          looksLikePdf({
            url: f.page.url,
            finalUrl: f.page.finalUrl,
            contentType: f.page.mimeType,
          });

        let content: string;
        let title: string;
        if (isPdf) {
          try {
            const result = await extractPdfText(f.page.bytes!, {
              maxPages: config.pdfMaxPages,
            });
            content = result.text;
            title = f.candidate.title || basenameFromUrl(f.page.finalUrl || f.page.url);
          } catch (err) {
            // A genuine extraction failure (corrupt/unsupported PDF) used to
            // fall through to a bare `continue`, silently dropping the source.
            // Emit a skip event either way so the loss is visible.
            emit(config, {
              type: "fetch.skipped",
              url: f.page.url,
              reason:
                err instanceof PdfExtractorMissingError
                  ? "pdf-no-extractor"
                  : "pdf-extract-error",
            });
            continue;
          }
          // Apply the same word cap as web sources — relevance-windowed
          // (#145): a 129-page standard capped head-first is all title page,
          // authors, abstract, and ToC, and the synth correctly refuses to
          // answer from front matter.
          content = selectRelevantWindow(
            content,
            relevanceTerms,
            config.maxWordsPerSource,
          ).text;
        } else {
          if (f.words <= 50) continue;
          const extracted = extractContent(
            f.page.text,
            f.page.title || f.candidate.title,
            config.maxWordsPerSource,
            relevanceTerms,
          );
          if (extracted.text.length === 0) continue;
          content = extracted.text;
          title = f.page.title || f.candidate.title;
        }

        // Recency signal: try to recover the page's publication date from its
        // HTML (JSON-LD / meta / <time>). PDFs and cache hits without html
        // simply yield undefined — additive, never blocks keeping the source.
        const publishedAt = isPdf ? undefined : extractPublishedDate(f.page.html);

        // Recency filter (--since): drop a source dated before the cutoff.
        // Dateless sources pass (we don't penalize missing metadata).
        if (
          config.sinceMs !== undefined &&
          publishedAt !== undefined &&
          publishedAt < config.sinceMs
        ) {
          emit(config, {
            type: "fetch.skipped",
            url: f.page.finalUrl || f.page.url,
            reason: "stale",
          });
          continue;
        }

        // Near-duplicate dedup: drop a source whose content is shingle-
        // similar to one already kept (syndicated copy on another host).
        if (config.dedupeNearDupes !== false) {
          while (keptShingles.length < keptSources.length) {
            keptShingles.push(contentShingles(keptSources[keptShingles.length].content));
          }
          const candidateShingles = contentShingles(content);
          const dupOf = findNearDuplicate(
            candidateShingles,
            keptShingles,
            config.nearDupeThreshold ?? DEFAULT_NEAR_DUPE_THRESHOLD,
          );
          if (dupOf !== -1) {
            emit(config, {
              type: "fetch.skipped",
              url: f.page.finalUrl || f.page.url,
              reason: "near-duplicate",
            });
            continue;
          }
          keptShingles.push(candidateShingles);
        }

        keptSources.push({
          id: keptSources.length + 1,
          url: f.page.finalUrl || f.page.url,
          title,
          fetchedAt: f.page.fetchedAt,
          ...(publishedAt !== undefined ? { publishedAt } : {}),
          content,
        });
      }

      // Zero-source guard: synthesizing over an empty source packet would
      // burn an LLM call on a guaranteed "unable to answer". Throw with the
      // diagnostics instead. Only an issue at round 0 — later rounds can only
      // grow keptSources — but the guard is cheap, so it's unconditional.
      if (keptSources.length === 0) {
        throw new NoSourcesError(
          config.search.name,
          allQueries,
          allCandidates.length,
          searchErrors,
        );
      }

      emit(config, {
        type: "synthesize.start",
        sourceCount: keptSources.length,
        round,
      });
      const tokenSink = config.onSynthesizeToken
        ? (chunk: string) => config.onSynthesizeToken!(chunk, round)
        : undefined;
      answer = await synthesize(question, keptSources, stageLLM.synth, signal, {
        onToken: tokenSink,
        onUsage: usageSinkFor("synth", round),
        tldr: config.tldr,
      });
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
        // Mid-loop citation verification — when enabled, surface weak
        // cites to the critic so the next round's queries can target the
        // exact sentences that lack authoritative support. The final
        // verifier pass still runs after the loop exits and produces the
        // user-facing report; this in-loop pass is purely advisory.
        let weakCites: { sentence: string; citedIds: number[] }[] = [];
        if (config.verifyCitations !== false && answer) {
          const inLoop = runVerify(answer, keptSources, {
            threshold: config.citeMinRecall ?? DEFAULT_CITE_MIN_RECALL,
          });
          weakCites = inLoop.unsupported.map((c) => ({
            sentence: c.sentence,
            citedIds: c.citedIds,
          }));
        }

        emit(config, { type: "critique.start", round });
        const crit = await critique(
          question,
          answer,
          allQueries,
          stageLLM.critique,
          signal,
          usageSinkFor("critique", round),
          weakCites,
          { sinceMs: config.sinceMs },
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

  let verification: VerificationReport | undefined;
  if (config.verifyCitations !== false && answer) {
    verification = runVerify(answer, keptSources, {
      threshold: config.citeMinRecall ?? DEFAULT_CITE_MIN_RECALL,
    });
    emit(config, { type: "verify.done", report: verification });
  }

  // v0.10.0 — sum cost across every model used. When all stages share
  // one model, this reduces to a single-model estimate (the pre-v0.10.0
  // shape) with one entry in `byModel`.
  const cost = estimateCostMultiModel(llmTotalsByModel, config.env);

  // Aggregate llm totals for the `usage.llm` summary (kept stable for
  // existing library consumers that read this shape).
  const llmTotals = { inputTokens: 0, outputTokens: 0, calls: 0 };
  for (const bucket of Object.values(llmTotalsByModel)) {
    llmTotals.inputTokens += bucket.inputTokens;
    llmTotals.outputTokens += bucket.outputTokens;
    llmTotals.calls += bucket.calls;
  }

  return {
    question,
    plan,
    sources: keptSources,
    answer,
    markdown,
    rounds,
    verification,
    cost,
    usage: {
      queries: allQueries.length,
      fetched: rounds.reduce((sum, r) => sum + r.fetched, 0),
      kept: keptSources.length,
      rounds: rounds.length,
      cacheHits: config.cache?.hits ?? 0,
      citationsTotal: verification?.totalCitations ?? 0,
      citationsSupported: verification?.supportedCitations ?? 0,
      llm: { ...llmTotals },
      estimatedCostUsd: cost.amountUsd,
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

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop();
    return last ? decodeURIComponent(last) : u.host;
  } catch {
    return url;
  }
}
