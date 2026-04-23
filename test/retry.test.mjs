import test from "node:test";
import assert from "node:assert/strict";
import { retry, backoffDelay } from "../dist/retry.js";

test("backoffDelay: exponential with jitter=0 is deterministic", () => {
  const cfg = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: 0 };
  assert.equal(backoffDelay(1, cfg), 100);
  assert.equal(backoffDelay(2, cfg), 200);
  assert.equal(backoffDelay(3, cfg), 400);
  assert.equal(backoffDelay(4, cfg), 800);
});

test("backoffDelay: capped at maxDelayMs", () => {
  const cfg = { baseDelayMs: 100, maxDelayMs: 300, jitter: 0 };
  assert.equal(backoffDelay(5, cfg), 300);
  assert.equal(backoffDelay(10, cfg), 300);
});

test("backoffDelay: jitter widens the range", () => {
  const cfg = { baseDelayMs: 1000, maxDelayMs: 10_000, jitter: 0.5 };
  // random()=0 → -jitter, random()=1 → +jitter
  assert.equal(backoffDelay(1, cfg, () => 0), 500);
  assert.equal(backoffDelay(1, cfg, () => 1), 1500);
  assert.equal(backoffDelay(1, cfg, () => 0.5), 1000);
});

test("backoffDelay: never negative", () => {
  const cfg = { baseDelayMs: 100, maxDelayMs: 10_000, jitter: 2 };
  // huge jitter at random=0 could go very negative → clamped to 0
  assert.ok(backoffDelay(1, cfg, () => 0) >= 0);
});

test("retry: returns on first success without sleeping", async () => {
  let slept = 0;
  const out = await retry(async () => 42, { sleep: async (ms) => { slept += ms; } });
  assert.equal(out, 42);
  assert.equal(slept, 0);
});

test("retry: eventually succeeds after N transient failures", async () => {
  let attempts = 0;
  const sleeps = [];
  const out = await retry(
    async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    },
    {
      attempts: 5,
      sleep: async (ms) => { sleeps.push(ms); },
      random: () => 0.5, // deterministic jitter
    },
  );
  assert.equal(out, "ok");
  assert.equal(attempts, 3);
  assert.equal(sleeps.length, 2); // sleeps happen between attempts
});

test("retry: throws last error after attempts exhausted", async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts++;
        throw new Error(`fail ${attempts}`);
      },
      { attempts: 3, sleep: async () => {} },
    ),
    /fail 3/,
  );
  assert.equal(attempts, 3);
});

test("retry: shouldRetry=false stops immediately", async () => {
  let attempts = 0;
  await assert.rejects(
    retry(
      async () => {
        attempts++;
        const e = new Error("permanent");
        throw e;
      },
      {
        attempts: 5,
        shouldRetry: () => false,
        sleep: async () => {},
      },
    ),
    /permanent/,
  );
  assert.equal(attempts, 1);
});

test("retry: shouldRetry gets called with the error and attempt number", async () => {
  const calls = [];
  await assert.rejects(
    retry(
      async () => {
        throw new Error("bang");
      },
      {
        attempts: 4,
        shouldRetry: (err, attempt) => {
          calls.push({ msg: err.message, attempt });
          return attempt < 2; // retry once, then bail
        },
        sleep: async () => {},
      },
    ),
    /bang/,
  );
  assert.deepEqual(calls, [
    { msg: "bang", attempt: 1 },
    { msg: "bang", attempt: 2 },
  ]);
});

test("retry: onRetry fires with error, attempt, and computed delay", async () => {
  const events = [];
  await retry(
    async () => {
      if (events.length < 2) throw new Error("transient");
      return "ok";
    },
    {
      attempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitter: 0,
      sleep: async () => {},
      onRetry: (err, attempt, delay) => {
        events.push({ msg: err.message, attempt, delay });
      },
    },
  );
  assert.equal(events.length, 2);
  assert.equal(events[0].delay, 100);
  assert.equal(events[1].delay, 200);
});

test("retry: aborted signal short-circuits before any attempt", async () => {
  const ac = new AbortController();
  ac.abort();
  let called = false;
  await assert.rejects(
    retry(
      async () => {
        called = true;
        return "should not get here";
      },
      { signal: ac.signal, sleep: async () => {} },
    ),
    /aborted/,
  );
  assert.equal(called, false);
});

test("retry: abort during sleep cancels cleanly", async () => {
  const ac = new AbortController();
  let sleepCalls = 0;
  const p = retry(
    async () => {
      throw new Error("flaky");
    },
    {
      attempts: 5,
      signal: ac.signal,
      sleep: async (_ms, signal) => {
        sleepCalls++;
        if (sleepCalls === 1) ac.abort();
        if (signal?.aborted) throw new Error("aborted");
      },
    },
  );
  await assert.rejects(p, /aborted/);
});
