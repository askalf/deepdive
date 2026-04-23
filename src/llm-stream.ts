// Streaming Anthropic Messages client.
//
// Used by the synthesizer so tokens land on stdout as the model writes them
// instead of making the user stare at a blank terminal for 30+ seconds on a
// deep query. Retry applies to the initial connect only — mid-stream
// failures propagate because we've already emitted bytes to the caller.

import { trimTrailingSlashes } from "./url-util.js";
import { retry } from "./retry.js";
import {
  LLMError,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_LLM_ATTEMPTS,
  type LLMConfig,
  type LLMMessage,
  type LLMResult,
} from "./llm.js";

export interface StreamOptions {
  onToken?: (text: string) => void;
}

export async function callLLMStream(
  messages: LLMMessage[],
  system: string,
  config: LLMConfig,
  opts: StreamOptions = {},
  signal?: AbortSignal,
): Promise<LLMResult> {
  const url = `${trimTrailingSlashes(config.baseUrl)}/v1/messages`;
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages,
    stream: true,
  };
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const attempts = Math.max(1, config.maxAttempts ?? DEFAULT_LLM_ATTEMPTS);

  // Retry wraps the initial connect only. Once we start emitting tokens
  // through onToken, a mid-stream failure can't be undone, so we let it
  // surface to the caller instead of silently retrying.
  const res = await retry(
    async () => {
      const combined = makeTimeoutSignal(timeoutMs, signal);
      const r = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": config.apiKey,
          accept: "text/event-stream",
        },
        body: JSON.stringify(body),
        signal: combined,
      });
      if (!r.ok) {
        const detail = await r.text().catch(() => "");
        throw new LLMError(
          r.status,
          `LLM ${r.status} ${r.statusText}: ${clip(detail, 500)}`,
          detail,
        );
      }
      return r;
    },
    {
      attempts,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      jitter: 0.25,
      signal,
      shouldRetry: (err) => {
        if (err instanceof LLMError) return err.retriable;
        if (isUserAbort(err, signal)) return false;
        return true;
      },
    },
  );

  if (!res.body) {
    throw new Error("LLM response has no stream body");
  }

  let text = "";
  let usage: LLMResult["usage"];

  for await (const event of parseSSE(res.body, signal)) {
    const type = event.type;
    if (type === "content_block_delta" && event.delta?.type === "text_delta") {
      const chunk = event.delta.text ?? "";
      if (chunk) {
        text += chunk;
        opts.onToken?.(chunk);
      }
    } else if (type === "message_delta" && event.usage) {
      // The streaming API reports final output_tokens in message_delta; the
      // input_tokens arrived in message_start.
      usage = { ...(usage ?? { input_tokens: 0, output_tokens: 0 }), ...event.usage };
    } else if (type === "message_start" && event.message?.usage) {
      usage = {
        input_tokens: event.message.usage.input_tokens ?? 0,
        output_tokens: event.message.usage.output_tokens ?? 0,
      };
    }
  }

  return { text, usage };
}

interface SSEEvent {
  type?: string;
  delta?: { type?: string; text?: string };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
  usage?: { input_tokens?: number; output_tokens?: number };
  [key: string]: unknown;
}

// Exported for unit tests.
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await reader.read();
      if (done) {
        // Flush any trailing event without blank-line terminator.
        if (buffer.trim().length > 0) {
          for (const ev of parseBlocks(buffer)) yield ev;
        }
        return;
      }
      buffer += decoder.decode(value, { stream: true });
      let eventStart = 0;
      while (true) {
        // SSE frames are terminated by \n\n (or \r\n\r\n).
        const idx = indexOfBlankLine(buffer, eventStart);
        if (idx === -1) break;
        const block = buffer.slice(eventStart, idx);
        for (const ev of parseBlocks(block)) yield ev;
        eventStart = idx + (buffer[idx + 1] === "\r" ? 4 : 2);
      }
      if (eventStart > 0) buffer = buffer.slice(eventStart);
    }
  } finally {
    reader.releaseLock();
  }
}

function indexOfBlankLine(s: string, from: number): number {
  const a = s.indexOf("\n\n", from);
  const b = s.indexOf("\r\n\r\n", from);
  if (a === -1) return b;
  if (b === -1) return a;
  return Math.min(a, b);
}

// Exported for unit tests. Parses one SSE frame (which may be multi-line) and
// yields the decoded data payload(s). A frame with no `data:` line yields
// nothing.
export function* parseBlocks(block: string): Generator<SSEEvent> {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    // `event:` and other fields are ignored; the `data` payload's `type`
    // carries the semantic event name for our purposes.
  }
  if (dataLines.length === 0) return;
  const raw = dataLines.join("\n");
  if (raw === "[DONE]") return;
  try {
    yield JSON.parse(raw) as SSEEvent;
  } catch {
    // Malformed frame — silently ignore. SSE allows heartbeat-style `:` lines
    // and similar that shouldn't crash the stream.
  }
}

function makeTimeoutSignal(
  timeoutMs: number,
  userSignal?: AbortSignal,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!userSignal) return timeout;
  return AbortSignal.any([userSignal, timeout]);
}

function isUserAbort(err: unknown, userSignal?: AbortSignal): boolean {
  if (!userSignal?.aborted) return false;
  const msg = (err as Error)?.message ?? "";
  const name = (err as Error)?.name ?? "";
  return name === "AbortError" || /abort/i.test(msg);
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
