// Query planning — decompose a user question into 3–5 sub-queries suitable
// for web search. Pure over its inputs; wraps one LLM call.
//
// Also exports critique() for iterative deep research: given a draft answer
// and the queries already tried, the critic proposes 0–3 follow-up queries
// that would fill the gaps — or declares the answer done.

import { callLLM, type LLMConfig } from "./llm.js";

export interface Plan {
  queries: string[];
  reasoning: string;
}

export interface Critique {
  done: boolean;
  reasoning: string;
  queries: string[];
}

const PLANNER_SYSTEM = `You are a research planner. Given a user's question, produce 3-5 specific, searchable sub-queries that together will gather the evidence needed to answer it well.

Rules:
- Each sub-query must be a concrete phrase someone would type into a search engine.
- Cover distinct facets of the question (definition, how it works, pros/cons, recent changes, alternatives, etc.) — do not list near-duplicates.
- Prefer specific terminology over vague phrasing.
- Do not include the user's exact question verbatim unless it is already search-engine-shaped.

Output FORMAT (strict): one JSON object, no prose before or after, matching:
{"reasoning": "<1-2 sentences on your decomposition>", "queries": ["q1", "q2", ...]}`;

export async function planQueries(
  question: string,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<Plan> {
  const { text } = await callLLM(
    [{ role: "user", content: question }],
    PLANNER_SYSTEM,
    config,
    signal,
  );
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

const CRITIC_SYSTEM = `You are a research critic reviewing a draft answer to a user's question.

You will receive:
1. The original question.
2. The current draft answer with inline [N] citations.
3. The list of search queries already run.

Your job: identify the most important gaps in the draft answer — aspects of the question not answered, answered weakly, or answered with insufficient sourcing — and propose 0 to 3 additional search queries that would fill those gaps in the next round.

Rules:
- If the draft answer is already complete and well-sourced, set "done": true and return no queries.
- Do not repeat queries similar to ones already searched. The list of prior queries is provided.
- Queries must be concrete, search-engine-shaped phrases a user would type.
- Prefer queries targeting specific unanswered facts over generic re-searches.
- Keep the number of new queries minimal — fewer, sharper queries beat more, vaguer ones.

Output FORMAT (strict): one JSON object, no prose before or after, matching:
{"done": bool, "reasoning": "<1-2 sentences>", "queries": ["q1", "q2", ...]}`;

export async function critique(
  question: string,
  draftAnswer: string,
  priorQueries: string[],
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<Critique> {
  const userMessage =
    `Question: ${question}\n\n` +
    `Draft answer:\n${draftAnswer}\n\n` +
    `Queries already run (${priorQueries.length}):\n` +
    priorQueries.map((q) => `- ${q}`).join("\n") +
    `\n\nReview the draft and propose follow-up queries if needed.`;
  const { text } = await callLLM(
    [{ role: "user", content: userMessage }],
    CRITIC_SYSTEM,
    config,
    signal,
  );
  return parseCritique(text);
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
