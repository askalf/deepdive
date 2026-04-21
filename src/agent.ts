// Main agent loop: plan → search → fetch → extract → synthesize.
//
// Intentionally single-pass for v0.1.0. A follow-up loop (read the answer,
// decide if more searches are needed) is the obvious next step and belongs
// behind a --deep flag so v1 stays cheap and predictable.

import type { LLMConfig } from "./llm.js";
import type { SearchAdapter } from "./search.js";
import { dedupeByUrl } from "./search.js";
import { planQueries, type Plan } from "./plan.js";
import { BrowserSession, type BrowserOptions, type FetchedPage } from "./browser.js";
import { extractContent } from "./extract.js";
import { buildSourceTable, renderAnswerMarkdown, type Source } from "./citations.js";
import { synthesize, type SourceWithContent } from "./synthesize.js";

export interface AgentConfig {
  llm: LLMConfig;
  search: SearchAdapter;
  browser: BrowserOptions;
  resultsPerQuery: number;
  maxSources: number;
  maxWordsPerSource: number;
  onEvent?: (event: AgentEvent) => void;
}

export type AgentEvent =
  | { type: "plan.start"; question: string }
  | { type: "plan.done"; plan: Plan }
  | { type: "search.start"; query: string }
  | { type: "search.done"; query: string; count: number }
  | { type: "fetch.start"; url: string }
  | { type: "fetch.done"; url: string; ok: boolean; status: number; words: number }
  | { type: "synthesize.start"; sourceCount: number }
  | { type: "synthesize.done" };

export interface AgentResult {
  question: string;
  plan: Plan;
  sources: Source[];
  markdown: string;
  usage: { queries: number; fetched: number; kept: number };
}

export async function runAgent(
  question: string,
  config: AgentConfig,
  signal?: AbortSignal,
): Promise<AgentResult> {
  emit(config, { type: "plan.start", question });
  const plan = await planQueries(question, config.llm, signal);
  emit(config, { type: "plan.done", plan });

  const seenUrls = new Set<string>();
  const candidates: { url: string; title: string; snippet: string; query: string }[] = [];

  for (const query of plan.queries) {
    if (signal?.aborted) throw new Error("aborted");
    emit(config, { type: "search.start", query });
    const results = await config.search.search(query, config.resultsPerQuery, signal);
    const fresh = dedupeByUrl(results).filter((r) => !seenUrls.has(r.url));
    for (const r of fresh) {
      seenUrls.add(r.url);
      candidates.push({ url: r.url, title: r.title, snippet: r.snippet, query });
    }
    emit(config, { type: "search.done", query, count: fresh.length });
  }

  const toFetch = candidates.slice(0, config.maxSources);

  const browser = new BrowserSession(config.browser);
  await browser.start();

  const fetched: (FetchedPage & { origTitle: string })[] = [];
  try {
    for (const c of toFetch) {
      if (signal?.aborted) throw new Error("aborted");
      emit(config, { type: "fetch.start", url: c.url });
      try {
        const page = await browser.fetch(c.url);
        const words = (page.text.match(/\S+/g) ?? []).length;
        emit(config, {
          type: "fetch.done",
          url: c.url,
          ok: page.status >= 200 && page.status < 400,
          status: page.status,
          words,
        });
        if (page.status >= 200 && page.status < 400 && words > 50) {
          fetched.push({ ...page, origTitle: c.title });
        }
      } catch (err) {
        emit(config, {
          type: "fetch.done",
          url: c.url,
          ok: false,
          status: 0,
          words: 0,
        });
      }
    }
  } finally {
    await browser.close();
  }

  const extracted: SourceWithContent[] = [];
  const sourceRows = buildSourceTable(
    fetched.map((f) => ({
      url: f.finalUrl || f.url,
      title: f.title || f.origTitle,
      fetchedAt: f.fetchedAt,
    })),
  );
  for (let i = 0; i < fetched.length; i++) {
    const f = fetched[i];
    const row = sourceRows[i];
    const ex = extractContent(f.text, f.title || f.origTitle, config.maxWordsPerSource);
    if (ex.text.length > 0) {
      extracted.push({ ...row, content: ex.text });
    }
  }

  emit(config, { type: "synthesize.start", sourceCount: extracted.length });
  const answer = await synthesize(question, extracted, config.llm, signal);
  emit(config, { type: "synthesize.done" });

  const markdown = renderAnswerMarkdown(question, answer, extracted);

  return {
    question,
    plan,
    sources: extracted,
    markdown,
    usage: {
      queries: plan.queries.length,
      fetched: toFetch.length,
      kept: extracted.length,
    },
  };
}

function emit(config: AgentConfig, event: AgentEvent): void {
  config.onEvent?.(event);
}
