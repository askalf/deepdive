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
import type { SearchAdapter } from "./search.js";
import { dedupeByUrl } from "./search.js";
import { planQueries, critique, type Plan, type Critique } from "./plan.js";
import { BrowserSession, type BrowserOptions, type FetchedPage } from "./browser.js";
import { extractContent } from "./extract.js";
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
  | {
      type: "fetch.skipped";
      url: string;
      reason: "robots" | "pdf-no-extractor" | "domain-deny" | "domain-not-allowed";
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
  const plan = await planQueries(question, stageLLM.plan, signal, usageSinkFor("plan", 0));
  emit(config, { type: "plan.done", plan });

  const seenUrls = new Set<string>();
  const allCandidates: Candidate[] = [];
  const allQueries: string[] = [];
  const keptSources: SourceWithContent[] = [];
  const rounds: RoundTrace[] = [];

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
      const candidatesFoundThisRound = allCandidates.length - candidatesBefore;

      const headroom = Math.max(0, config.maxSources - keptSources.length);
      const toFetch = allCandidates
        .slice(candidatesBefore)
        .slice(0, Math.max(headroom, candidatesFoundThisRound));

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
            if (err instanceof PdfExtractorMissingError) {
              emit(config, {
                type: "fetch.skipped",
                url: f.page.url,
                reason: "pdf-no-extractor",
              });
            }
            continue;
          }
          // Apply the same word cap as web sources.
          const words = content.split(/\s+/).filter(Boolean);
          if (words.length > config.maxWordsPerSource) {
            content = words.slice(0, config.maxWordsPerSource).join(" ") + " …";
          }
        } else {
          if (f.words <= 50) continue;
          const extracted = extractContent(
            f.page.text,
            f.page.title || f.candidate.title,
            config.maxWordsPerSource,
          );
          if (extracted.text.length === 0) continue;
          content = extracted.text;
          title = f.page.title || f.candidate.title;
        }

        keptSources.push({
          id: keptSources.length + 1,
          url: f.page.finalUrl || f.page.url,
          title,
          fetchedAt: f.page.fetchedAt,
          content,
        });
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
        stageLLM.synth,
        signal,
        tokenSink,
        usageSinkFor("synth", round),
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
