// DDG rate-limit detection (v0.20.0). The HTML endpoint signals throttling
// as 202/403/429 or as a 200 bot-challenge page with zero results — both must
// surface as SearchRateLimitError instead of a silent empty list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { DuckDuckGoSearch, looksLikeDdgChallenge } from "../dist/search/duckduckgo.js";
import { SearchRateLimitError, isRateLimitError } from "../dist/search.js";

const RESULTS_FIXTURE = `
<html><body>
  <div class="result results_links">
    <a class="result__a" href="https://direct.example.org/page">Direct Link</a>
    <a class="result__snippet" href="#">A snippet.</a>
  </div>
</body></html>
`;

const CHALLENGE_FIXTURE = `
<html><body>
  <div class="anomaly-modal__modal">
    <p>Unfortunately, bots use DuckDuckGo too. Please complete the challenge.</p>
    <form class="challenge-form"></form>
  </div>
</body></html>
`;

function stubFetch(t, impl) {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  t.after(() => {
    globalThis.fetch = original;
  });
}

function withDelayEnv(t, value) {
  const original = process.env.DEEPDIVE_DDG_DELAY_MS;
  process.env.DEEPDIVE_DDG_DELAY_MS = value;
  t.after(() => {
    if (original === undefined) delete process.env.DEEPDIVE_DDG_DELAY_MS;
    else process.env.DEEPDIVE_DDG_DELAY_MS = original;
  });
}

test("ddg: HTTP 403 throws SearchRateLimitError", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response("", { status: 403, statusText: "Forbidden" }));
  const ddg = new DuckDuckGoSearch();
  await assert.rejects(
    () => ddg.search("q", 5),
    (err) => {
      assert.ok(err instanceof SearchRateLimitError);
      assert.ok(isRateLimitError(err));
      assert.equal(err.adapter, "duckduckgo");
      assert.match(err.message, /HTTP 403/);
      return true;
    },
  );
});

test("ddg: HTTP 202 and 429 also classify as rate limits", async (t) => {
  withDelayEnv(t, "0");
  for (const status of [202, 429]) {
    stubFetch(t, async () => new Response("", { status, statusText: "x" }));
    const ddg = new DuckDuckGoSearch();
    await assert.rejects(
      () => ddg.search("q", 5),
      (err) => isRateLimitError(err),
      `status ${status} should be a rate-limit error`,
    );
  }
});

test("ddg: 200 + challenge page (zero results) throws SearchRateLimitError", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response(CHALLENGE_FIXTURE, { status: 200 }));
  const ddg = new DuckDuckGoSearch();
  await assert.rejects(
    () => ddg.search("q", 5),
    (err) => isRateLimitError(err) && /challenge page/.test(err.message),
  );
});

test("ddg: 200 + normal results parses fine (no false positive)", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response(RESULTS_FIXTURE, { status: 200 }));
  const ddg = new DuckDuckGoSearch();
  const results = await ddg.search("q", 5);
  assert.equal(results.length, 1);
  assert.equal(results[0].url, "https://direct.example.org/page");
});

test("ddg: 200 + genuinely empty page (no challenge markers) returns []", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response("<html><body>no results here</body></html>", { status: 200 }));
  const ddg = new DuckDuckGoSearch();
  assert.deepEqual(await ddg.search("q", 5), []);
});

test("ddg: other HTTP errors stay plain errors (500 is not a rate limit)", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response("", { status: 500, statusText: "boom" }));
  const ddg = new DuckDuckGoSearch();
  await assert.rejects(
    () => ddg.search("q", 5),
    (err) => !isRateLimitError(err) && /500/.test(err.message),
  );
});

test("ddg: consecutive requests on one instance are spaced out", async (t) => {
  withDelayEnv(t, "80");
  stubFetch(t, async () => new Response(RESULTS_FIXTURE, { status: 200 }));
  const ddg = new DuckDuckGoSearch();
  const start = Date.now();
  await ddg.search("first", 5);
  await ddg.search("second", 5);
  const elapsed = Date.now() - start;
  // Second call must have waited ~80ms after the first. Allow timer jitter.
  assert.ok(elapsed >= 70, `expected >=70ms spacing, got ${elapsed}ms`);
});

test("ddg: DEEPDIVE_DDG_DELAY_MS=0 disables spacing", async (t) => {
  withDelayEnv(t, "0");
  stubFetch(t, async () => new Response(RESULTS_FIXTURE, { status: 200 }));
  const ddg = new DuckDuckGoSearch();
  const start = Date.now();
  await ddg.search("first", 5);
  await ddg.search("second", 5);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 500, `expected no deliberate spacing, got ${elapsed}ms`);
});

test("looksLikeDdgChallenge: detects each marker, ignores normal pages", () => {
  assert.equal(looksLikeDdgChallenge('<div class="anomaly-modal__title">'), true);
  assert.equal(looksLikeDdgChallenge('<form class="challenge-form">'), true);
  assert.equal(looksLikeDdgChallenge("Unfortunately, Bots use DuckDuckGo Too."), true);
  assert.equal(looksLikeDdgChallenge(RESULTS_FIXTURE), false);
  assert.equal(looksLikeDdgChallenge(""), false);
});

test("isRateLimitError: duck-types a foreign error with rateLimited=true", () => {
  const foreign = Object.assign(new Error("throttled"), { rateLimited: true });
  assert.equal(isRateLimitError(foreign), true);
  assert.equal(isRateLimitError(new Error("plain")), false);
  assert.equal(isRateLimitError("not an error"), false);
});
