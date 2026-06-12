// Query planning — decompose a user question into 3–5 sub-queries suitable
// for web search. Pure over its inputs; wraps one LLM call.
//
// Also exports critique() for iterative deep research: given a draft answer
// and the queries already tried, the critic proposes 0–3 follow-up queries
// that would fill the gaps — or declares the answer done.

import { callLLM, type LLMConfig, type LLMResult } from "./llm.js";

export type UsageSink = (usage: NonNullable<LLMResult["usage"]>) => void;

export interface Plan {
  queries: string[];
  reasoning: string;
}

export interface Critique {
  done: boolean;
  reasoning: string;
  queries: string[];
}

/**
 * Date grounding for the planner/critic prompts. Without it the model
 * anchors "recent"/"latest" to its TRAINING-time sense of now and writes
 * stale queries — and when `--since` is in play, the recency filter then
 * culls most of what those stale queries return (the v0.23.0 bench
 * "recent" failure: 1 source kept against a 3-source minimum).
 */
export interface PlanContext {
  /** Epoch ms for "today". Defaults to Date.now(); injectable for tests. */
  now?: number;
  /**
   * Resolved `--since` cutoff (epoch ms). When set, the prompts disclose
   * that sources published before it are dropped, so queries get shaped
   * to the surviving window instead of the model's idea of "recent".
   */
  sinceMs?: number;
}

function fmtDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Shared between planner and critic. Two failure modes balance here:
// relative recency words ("latest") rank stale evergreen pages because
// search engines match text, not intent — but bare year tokens distort
// keyword-matched sources (arXiv/OpenAlex/code search), measured as a
// 0.68 → 0.44 citation-support drop on the bench's scholarly question
// when every sub-query got year-anchored. So: anchor event-shaped
// sub-queries only, keep conceptual ones timeless.
function recencyRules(now: number, sinceMs?: number): string {
  let s = `- For sub-queries about time-bound events (releases, announcements, news, versions, "what changed"), use absolute dates derived from today's date — the current year, month + year, or the window's endpoints — instead of relative words like "latest" or "recent", which rank stale evergreen pages.
- Keep conceptual, scholarly, and how-does-X-work sub-queries timeless: bare year tokens distort keyword-matched scholarly and code search, so do not append years to them.`;
  // Firm wording is safe here: this line only fires when the user passed
  // --since, i.e. explicitly demanded freshness — unlike the rules above,
  // it can't leak year tokens into runs that never asked for recency.
  if (sinceMs !== undefined) {
    s += `\n- A freshness filter will DROP every source published before ${fmtDay(sinceMs)}. Shape every sub-query to surface content published after that date.`;
  }
  return s;
}

// Exported for unit tests.
export function plannerSystem(ctx: PlanContext = {}): string {
  const now = ctx.now ?? Date.now();
  return `You are a research planner. Given a user's question, produce 3-5 specific, searchable sub-queries that together will gather the evidence needed to answer it well.

Today's date: ${fmtDay(now)}.

Rules:
- Each sub-query must be a concrete phrase someone would type into a search engine.
- Cover distinct facets of the question (definition, how it works, pros/cons, recent changes, alternatives, etc.) — do not list near-duplicates.
- Prefer specific terminology over vague phrasing.
- Do not include the user's exact question verbatim unless it is already search-engine-shaped.
${recencyRules(now, ctx.sinceMs)}

Output FORMAT (strict): one JSON object, no prose before or after, matching:
{"reasoning": "<1-2 sentences on your decomposition>", "queries": ["q1", "q2", ...]}`;
}

export async function planQueries(
  question: string,
  config: LLMConfig,
  signal?: AbortSignal,
  onUsage?: UsageSink,
  ctx: PlanContext = {},
): Promise<Plan> {
  const { text, usage } = await callLLM(
    [{ role: "user", content: question }],
    plannerSystem(ctx),
    config,
    signal,
  );
  if (usage && onUsage) onUsage(usage);
  return parsePlan(text);
}

// Exported for unit tests.
export function parsePlan(raw: string): Plan {
  const json = extractFirstJsonObject(raw);
  if (!json) throw new Error(`planner did not return JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(json) as { reasoning?: string; queries?: unknown };
  if (!Array.isArray(parsed.queries) || parsed.queries.length === 0) {
    throw new Error(`planner returned no queries: ${raw.slice(0, 200)}`);
  }
  const queries = parsed.queries
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim())
    .filter((q) => q.length > 0)
    .slice(0, 8);
  if (queries.length === 0) throw new Error("planner queries were all empty");
  return {
    queries,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
  };
}

// Exported for unit tests.
export function criticSystem(ctx: PlanContext = {}): string {
  const now = ctx.now ?? Date.now();
  return `You are a research critic reviewing a draft answer to a user's question.

Today's date: ${fmtDay(now)}.

You will receive:
1. The original question.
2. The current draft answer with inline [N] citations.
3. The list of search queries already run.
4. (Optional) A list of sentences whose [N] citations are weakly supported by their cited source — these are top-priority gaps to fill in the next round.

Your job: identify the most important gaps in the draft answer — aspects of the question not answered, answered weakly, or answered with insufficient sourcing — and propose 0 to 3 additional search queries that would fill those gaps in the next round.

Rules:
- If the draft answer is already complete and well-sourced, set "done": true and return no queries.
- Do not repeat queries similar to ones already searched. The list of prior queries is provided.
- Queries must be concrete, search-engine-shaped phrases a user would type.
- Prefer queries targeting specific unanswered facts over generic re-searches.
- When weakly-supported sentences are flagged, prioritize queries that would find authoritative sources for those exact claims.
- Keep the number of new queries minimal — fewer, sharper queries beat more, vaguer ones.
${recencyRules(now, ctx.sinceMs)}

Output FORMAT (strict): one JSON object, no prose before or after, matching:
{"done": bool, "reasoning": "<1-2 sentences>", "queries": ["q1", "q2", ...]}`;
}

export interface WeakCite {
  sentence: string;
  citedIds: number[];
}

export async function critique(
  question: string,
  draftAnswer: string,
  priorQueries: string[],
  config: LLMConfig,
  signal?: AbortSignal,
  onUsage?: UsageSink,
  weakCites: WeakCite[] = [],
  ctx: PlanContext = {},
): Promise<Critique> {
  const weakSection =
    weakCites.length > 0
      ? `\n\nSentences with weak citations (top-priority gaps):\n` +
        weakCites
          .map(
            (w) =>
              `- "${truncateForPrompt(w.sentence)}" — cited [${w.citedIds.join(", ")}]`,
          )
          .join("\n")
      : "";
  const userMessage =
    `Question: ${question}\n\n` +
    `Draft answer:\n${draftAnswer}\n\n` +
    `Queries already run (${priorQueries.length}):\n` +
    priorQueries.map((q) => `- ${q}`).join("\n") +
    weakSection +
    `\n\nReview the draft and propose follow-up queries if needed.`;
  const { text, usage } = await callLLM(
    [{ role: "user", content: userMessage }],
    criticSystem(ctx),
    config,
    signal,
  );
  if (usage && onUsage) onUsage(usage);
  return parseCritique(text);
}

function truncateForPrompt(s: string): string {
  const trimmed = s.trim().replace(/\s+/g, " ");
  return trimmed.length <= 200 ? trimmed : trimmed.slice(0, 197) + "…";
}

// Exported for unit tests.
export function parseCritique(raw: string): Critique {
  const json = extractFirstJsonObject(raw);
  if (!json) throw new Error(`critic did not return JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(json) as {
    done?: unknown;
    reasoning?: unknown;
    queries?: unknown;
  };
  const queries = Array.isArray(parsed.queries)
    ? parsed.queries
        .filter((q): q is string => typeof q === "string")
        .map((q) => q.trim())
        .filter((q) => q.length > 0)
        .slice(0, 3)
    : [];
  const done =
    typeof parsed.done === "boolean" ? parsed.done : queries.length === 0;
  return {
    done,
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    queries,
  };
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (c === "\\" && inString) {
      escape = true;
      continue;
    }
    if (c === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}
