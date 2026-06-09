// Final answer synthesis — takes the original question and the collected
// sources, asks the LLM to produce a cited markdown answer. Sources are
// passed as a numbered list so the model can cite them inline as [1], [2].
//
// When `onToken` is provided, uses the streaming variant so tokens land in
// front of the user as the model writes them instead of after a 30+s wait.

import { callLLM, type LLMConfig, type LLMResult } from "./llm.js";
import { callLLMStream } from "./llm-stream.js";
import type { Source } from "./citations.js";
import type { UsageSink } from "./plan.js";

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
- Some sources carry a "(published YYYY-MM-DD)" marker. When sources conflict or recency matters, prefer the more recent source and note when a claim comes from an older one.
- Length: match the complexity of the question. A one-line question can get a paragraph; a comparison question may need headers and a table.`;

// Appended to the system prompt when the caller asks for a leading summary.
const TLDR_RULE = `\n- Begin the answer with a line that starts with "**TL;DR:**" giving a direct 2-3 sentence answer to the question, then a blank line, then the full detailed answer. The TL;DR must still cite its claims with [N].`;

export interface SynthesizeOptions {
  onToken?: (text: string) => void;
  onUsage?: UsageSink;
  // When true, instruct the model to lead with a one-paragraph TL;DR.
  tldr?: boolean;
}

export async function synthesize(
  question: string,
  sources: SourceWithContent[],
  config: LLMConfig,
  signal?: AbortSignal,
  opts: SynthesizeOptions = {},
): Promise<string> {
  if (sources.length === 0) {
    return "_No sources could be fetched or extracted. Unable to answer._";
  }
  const { onToken, onUsage, tldr } = opts;
  const system = tldr ? SYNTH_SYSTEM + TLDR_RULE : SYNTH_SYSTEM;
  const packet = buildSourcePacket(sources);
  const userMessage =
    `Question: ${question}\n\n` +
    `Sources (${sources.length}):\n\n${packet}\n\n` +
    `Write the cited markdown answer now.`;
  const messages = [{ role: "user" as const, content: userMessage }];
  let result: LLMResult;
  if (onToken) {
    result = await callLLMStream(messages, system, config, { onToken }, signal);
  } else {
    result = await callLLM(messages, system, config, signal);
  }
  if (result.usage && onUsage) onUsage(result.usage);
  return result.text;
}

// Exported for unit tests. Source header carries the publication date when one
// was extracted, so the model can weigh recency without a separate prompt.
export function buildSourcePacket(sources: SourceWithContent[]): string {
  return sources
    .map((s) => {
      const published =
        typeof s.publishedAt === "number"
          ? ` (published ${new Date(s.publishedAt).toISOString().slice(0, 10)})`
          : "";
      const header = `[${s.id}] ${s.title || "(untitled)"}${published} — ${s.url}`;
      return `${header}\n\n${s.content}`;
    })
    .join("\n\n---\n\n");
}
