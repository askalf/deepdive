// Retry-with-backoff helper. Pure over its inputs — injectable `sleep` and
// `random` make it deterministic in tests.
//
// Default policy is "retry any thrown error with exponential backoff + jitter"
// — callers pass a `shouldRetry` predicate to narrow that (e.g. llm.ts only
// retries on 5xx / 429 / network errors, never on 4xx).

export interface RetryOptions {
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: number; // 0..1 fraction of baseDelay added/subtracted per attempt
  shouldRetry?: (err: unknown, attempt: number) => boolean;
  onRetry?: (err: unknown, attempt: number, delayMs: number) => void;
  signal?: AbortSignal;
  // Test hooks.
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const DEFAULTS: Omit<RetryOptions, "shouldRetry" | "onRetry" | "signal" | "sleep" | "random"> = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  jitter: 0.25,
};

export async function retry<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOptions> = {},
): Promise<T> {
  const cfg = { ...DEFAULTS, ...opts };
  const sleep = opts.sleep ?? defaultSleep;
  const random = opts.random ?? Math.random;
  let lastErr: unknown;

  for (let attempt = 1; attempt <= cfg.attempts; attempt++) {
    if (opts.signal?.aborted) throw new Error("aborted");
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isLast = attempt >= cfg.attempts;
      if (isLast) throw err;
      if (opts.shouldRetry && !opts.shouldRetry(err, attempt)) throw err;
      const delay = backoffDelay(attempt, cfg, random);
      opts.onRetry?.(err, attempt, delay);
      await sleep(delay, opts.signal);
    }
  }
  // Unreachable — loop either returns or throws — but TS wants a concrete value.
  throw lastErr;
}

// Exported for unit tests.
export function backoffDelay(
  attempt: number,
  cfg: { baseDelayMs: number; maxDelayMs: number; jitter: number },
  random: () => number = Math.random,
): number {
  const exp = Math.min(cfg.maxDelayMs, cfg.baseDelayMs * Math.pow(2, attempt - 1));
  if (cfg.jitter <= 0) return Math.floor(exp);
  const spread = exp * cfg.jitter;
  const delta = (random() * 2 - 1) * spread;
  return Math.max(0, Math.floor(exp + delta));
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(new Error("aborted"));
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}
