// Final answer synthesis — takes the original question and the collected
// sources, asks the LLM to produce a cited markdown answer. Sources are
// passed as a numbered list so the model can cite them inline as [1], [2].
//
// When `onToken` is provided, uses the streaming variant so tokens land in
// front of the user as the model writes them instead of after a 30+s wait.

import { callLLM, type LLMConfig } from "./llm.js";
import { callLLMStream } from "./llm-stream.js";
import type { Source } from "./citations.js";

export interface SourceWithContent extends Source {
  content: string;
}

const SYNTH_SYSTEM = `You are a careful research assistant. You will be given:
1. The user's original question.
2. A numbered list of source documents with titles, URLs, and extracted text.

Your job: write a direct, factual, well-structured markdown answer to the question, citing sources inline as [N] where N matches the numbered source list.

Rules:
- Cite every non-trivial claim inline with [N] (multiple sources: [1][3]).
- Do not invent a source number that is not in the provided list.
- Do not cite general knowledge; cite the sources.
- Prefer concrete facts, dates, numbers, names, mechanisms over hedged prose.
- If the sources disagree, surface the disagreement.
- If the sources do not answer the question, say so — do not hallucinate.
- Do not include a "Sources" section yourself — the caller appends it.
- Length: match the complexity of the question. A one-line question can get a paragraph; a comparison question may need headers and a table.`;

export async function synthesize(
  question: string,
  sources: SourceWithContent[],
  config: LLMConfig,
  signal?: AbortSignal,
  onToken?: (text: string) => void,
): Promise<string> {
  if (sources.length === 0) {
    return "_No sources could be fetched or extracted. Unable to answer._";
  }
  const packet = buildSourcePacket(sources);
  const userMessage =
    `Question: ${question}\n\n` +
    `Sources (${sources.length}):\n\n${packet}\n\n` +
    `Write the cited markdown answer now.`;
  const messages = [{ role: "user" as const, content: userMessage }];
  if (onToken) {
    const { text } = await callLLMStream(
      messages,
      SYNTH_SYSTEM,
      config,
      { onToken },
      signal,
    );
    return text;
  }
  const { text } = await callLLM(messages, SYNTH_SYSTEM, config, signal);
  return text;
}

// Exported for unit tests.
export function buildSourcePacket(sources: SourceWithContent[]): string {
  return sources
    .map((s) => {
      const header = `[${s.id}] ${s.title || "(untitled)"} — ${s.url}`;
      return `${header}\n\n${s.content}`;
    })
    .join("\n\n---\n\n");
}
