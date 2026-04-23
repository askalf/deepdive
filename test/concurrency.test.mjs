import test from "node:test";
import assert from "node:assert/strict";
import { runConcurrent } from "../dist/concurrency.js";

test("preserves input order in results", async () => {
  const items = [1, 2, 3, 4, 5];
  const out = await runConcurrent(items, 2, async (x) => x * 10);
  assert.deepEqual(out, [10, 20, 30, 40, 50]);
});

test("caps in-flight workers at concurrency", async () => {
  let inFlight = 0;
  let peak = 0;
  const items = [1, 2, 3, 4, 5, 6, 7, 8];
  await runConcurrent(items, 3, async (x) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return x;
  });
  assert.equal(peak, 3);
});

test("empty input returns empty output without running fn", async () => {
  let called = false;
  const out = await runConcurrent([], 4, async () => {
    called = true;
    return 1;
  });
  assert.deepEqual(out, []);
  assert.equal(called, false);
});

test("concurrency=1 serializes", async () => {
  const order = [];
  await runConcurrent([1, 2, 3], 1, async (x) => {
    order.push("start-" + x);
    await new Promise((r) => setTimeout(r, 2));
    order.push("end-" + x);
    return x;
  });
  assert.deepEqual(order, [
    "start-1",
    "end-1",
    "start-2",
    "end-2",
    "start-3",
    "end-3",
  ]);
});

test("concurrency < 1 rejects", async () => {
  await assert.rejects(() => runConcurrent([1], 0, async (x) => x), />= 1/);
});

test("abort signal interrupts the pool", async () => {
  const ac = new AbortController();
  const items = [1, 2, 3, 4, 5, 6];
  const runs = { started: 0 };
  const p = runConcurrent(
    items,
    2,
    async (x) => {
      runs.started++;
      if (x === 2) ac.abort();
      await new Promise((r) => setTimeout(r, 2));
      return x;
    },
    ac.signal,
  );
  await assert.rejects(p, /aborted/);
  assert.ok(runs.started < items.length, `should have stopped early, got ${runs.started}`);
});

test("concurrency > items.length caps at items.length", async () => {
  const items = [1, 2];
  let started = 0;
  await runConcurrent(items, 100, async (x) => {
    started++;
    return x;
  });
  assert.equal(started, 2);
});

test("propagates a worker rejection", async () => {
  const items = [1, 2, 3];
  await assert.rejects(
    runConcurrent(items, 2, async (x) => {
      if (x === 2) throw new Error("boom");
      return x;
    }),
    /boom/,
  );
});
