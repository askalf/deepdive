// Minimal worker-pool concurrency helper. Runs `fn` across `items` with at
// most `concurrency` in flight at once. Preserves input order in the result
// array. Aborts early if `signal` fires, rejecting with the abort reason.
//
// Kept separate from agent.ts so it's reusable and trivially testable.

export async function runConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  if (concurrency < 1) throw new Error(`concurrency must be >= 1 (got ${concurrency})`);
  if (items.length === 0) return [];

  const results: R[] = new Array(items.length);
  let next = 0;
  let aborted = false;

  const abortCheck = () => {
    if (signal?.aborted) aborted = true;
  };

  async function worker(): Promise<void> {
    while (true) {
      abortCheck();
      if (aborted) return;
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }

  const workers: Promise<void>[] = [];
  const n = Math.min(concurrency, items.length);
  for (let i = 0; i < n; i++) workers.push(worker());
  await Promise.all(workers);

  if (aborted) throw new Error("aborted");
  return results;
}
