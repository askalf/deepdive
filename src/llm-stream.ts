// Streaming Anthropic Messages client.
//
// Used by the synthesizer so tokens land on stdout as the model writes them
// instead of making the user stare at a blank terminal for 30+ seconds on a
// deep query. Retry wraps the initial connect only; once the stream flows a
// failure surfaces to the caller. The stream is bounded by an idle-token
// deadline so a stalled response fails fast instead of hanging.

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
import {
  authHeadersFor,
  detectApiFormat,
  openaiSSEToAnthropic,
  pathFor,
  toOpenAIRequest,
} from "./llm-format.js";

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
  const format = config.apiFormat ?? detectApiFormat(config.baseUrl);
  const url = `${trimTrailingSlashes(config.baseUrl)}${pathFor(format)}`;
  const anthropicBody = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages,
    stream: true,
  };
  const body =
    format === "openai" ? toOpenAIRequest(anthropicBody) : anthropicBody;
  // OpenAI's streaming endpoint requires `stream_options.include_usage`
  // to report token counts in the final SSE event.
  if (format === "openai") {
    (body as unknown as Record<string, unknown>).stream_options = {
      include_usage: true,
    };
  }
  const headers = {
    ...authHeadersFor(format, config.apiKey),
    accept: "text/event-stream",
  };
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const attempts = Math.max(1, config.maxAttempts ?? DEFAULT_LLM_ATTEMPTS);

  // Retry wraps the initial connect only. Once the stream is flowing we don't
  // retry: a mid-stream failure on this synthesis is (empirically, #104) a
  // persistent upstream stall, so re-issuing the request just burns the same
  // wall-clock again; the idle-token deadline below fails it fast instead.
  const res = await retry(
    async () => {
      const combined = makeTimeoutSignal(timeoutMs, signal);
      const r = await fetch(url, {
        method: "POST",
        headers,
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

  // Bound the stream by an idle-token deadline (#104). A healthy long
  // generation never idles between tokens, so it streams to completion even
  // past `timeoutMs`; a genuine stall (no token for `timeoutMs`) aborts here
  // instead of hanging until the global --max-runtime (or forever, if unset).
  for await (const raw of parseSSE(res.body, signal, timeoutMs)) {
    const event =
      format === "openai" ? openaiSSEToAnthropic(raw) ?? raw : raw;
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

// Exported for unit tests. `idleMs`, when set, bounds the gap between chunks:
// if no data arrives for that long the underlying stream is cancelled and the
// generator throws a TimeoutError, so a stalled response can't hang forever.
export async function* parseSSE(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleMs?: number,
): AsyncGenerator<SSEEvent> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) throw new Error("aborted");
      const { done, value } = await readChunk(reader, idleMs);
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

// Race a single read against an idle deadline. On timeout, cancel the stream
// so the pending read settles (a locked reader with a pending read can't
// releaseLock cleanly) and surface a TimeoutError to the generator.
async function readChunk(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  idleMs?: number,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (!idleMs) return reader.read();
  const read = reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const idle = new Promise<never>((_, reject) => {
    // NOT unref'd: while a stream is in flight this timer represents real
    // pending work (we want the loop kept alive to await the next token). It
    // is always cleared on a chunk or fires within idleMs, so it never holds
    // the process open beyond the read it guards.
    timer = setTimeout(
      () => reject(new DOMException(`stream idle for ${idleMs}ms`, "TimeoutError")),
      idleMs,
    );
  });
  try {
    return await Promise.race([read, idle]);
  } catch (err) {
    // Cancel so the still-pending read settles — a never-closing stream would
    // otherwise leave a dangling promise — then surface the timeout.
    await reader.cancel(err).catch(() => undefined);
    await read.catch(() => undefined);
    throw err;
  } finally {
    clearTimeout(timer);
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
