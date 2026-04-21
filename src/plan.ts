// Query planning — decompose a user question into 3–5 sub-queries suitable
// for web search. Pure over its inputs; wraps one LLM call.

import { callLLM, type LLMConfig } from "./llm.js";

export interface Plan {
  queries: string[];
  reasoning: string;
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
