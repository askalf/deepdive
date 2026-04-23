// Minimal Anthropic Messages-compatible client with retry + per-call timeout.
//
// Default target is dario at http://localhost:3456, but any Anthropic-compat
// endpoint works. A single deep-research query can fire 30+ LLM calls; at a
// 1% per-call failure rate the overall success rate would be 74%. Retries
// with exponential backoff bring that above 99%.
//
// Retry policy: 3 attempts total, retries fetch-level errors (network,
// timeout) and HTTP 5xx / 429. Never retries 4xx (other than 429) — those
// indicate malformed requests, not transient failures.

import { trimTrailingSlashes } from "./url-util.js";
import { retry } from "./retry.js";

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs?: number;
  maxAttempts?: number;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMResult {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export class LLMError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly detail: string = "",
  ) {
    super(message);
    this.name = "LLMError";
  }
  get retriable(): boolean {
    return this.status === 429 || (this.status >= 500 && this.status <= 599);
  }
}

export const DEFAULT_LLM_TIMEOUT_MS = 120_000;
export const DEFAULT_LLM_ATTEMPTS = 3;

export async function callLLM(
  messages: LLMMessage[],
  system: string,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<LLMResult> {
  const url = `${trimTrailingSlashes(config.baseUrl)}/v1/messages`;
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages,
  };
  const timeoutMs = config.timeoutMs ?? DEFAULT_LLM_TIMEOUT_MS;
  const attempts = Math.max(1, config.maxAttempts ?? DEFAULT_LLM_ATTEMPTS);

  return retry(
    async () => {
      const combined = makeTimeoutSignal(timeoutMs, signal);
      let res: Response;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": config.apiKey,
          },
          body: JSON.stringify(body),
          signal: combined,
        });
      } catch (err) {
        // Fetch-level errors (network, DNS, timeout) bubble through retry.
        throw err;
      }

      if (!res.ok) {
        const detail = await safeReadText(res);
        throw new LLMError(
          res.status,
          `LLM ${res.status} ${res.statusText}: ${clip(detail, 500)}`,
          detail,
        );
      }

      const json = (await res.json()) as {
        content: { type: string; text?: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };

      const text = json.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text!)
        .join("");

      return { text, usage: json.usage };
    },
    {
      attempts,
      baseDelayMs: 500,
      maxDelayMs: 8_000,
      jitter: 0.25,
      signal,
      shouldRetry: (err) => {
        if (err instanceof LLMError) return err.retriable;
        // Fetch errors (TypeError "fetch failed", AbortError from timeout) —
        // retriable. User-initiated aborts (signal fires) raise "aborted"
        // and we want those to NOT retry.
        if (isUserAbort(err, signal)) return false;
        return true;
      },
    },
  );
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

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}
