import { test } from "node:test";
import assert from "node:assert/strict";
import { AutoSearch } from "../dist/search/auto.js";
import { resolveSearchAdapter } from "../dist/search.js";

function makeAdapter(name, impl) {
  return { name, search: impl };
}

test("AutoSearch: primary success returns primary results", async () => {
  let secondaryCalled = false;
  const primary = makeAdapter("primary", async () => [
    { url: "https://p.example/x", title: "P", snippet: "", rank: 1 },
  ]);
  const secondary = makeAdapter("secondary", async () => {
    secondaryCalled = true;
    return [];
  });
  const auto = new AutoSearch(primary, secondary);
  const r = await auto.search("q", 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, "https://p.example/x");
  assert.equal(secondaryCalled, false);
});

test("AutoSearch: primary error falls back to secondary", async () => {
  const primary = makeAdapter("primary", async () => {
    throw new Error("primary 429 Too Many Requests");
  });
  const secondary = makeAdapter("secondary", async () => [
    { url: "https://s.example/x", title: "S", snippet: "", rank: 1 },
  ]);
  const auto = new AutoSearch(primary, secondary);
  const r = await auto.search("q", 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, "https://s.example/x");
});

test("AutoSearch: primary empty result falls back to secondary", async () => {
  const primary = makeAdapter("primary", async () => []);
  const secondary = makeAdapter("secondary", async () => [
    { url: "https://s.example/x", title: "S", snippet: "", rank: 1 },
  ]);
  const auto = new AutoSearch(primary, secondary);
  const r = await auto.search("q", 5);
  assert.equal(r.length, 1);
  assert.equal(r[0].url, "https://s.example/x");
});

test("AutoSearch: primary error with no secondary rethrows primary error", async () => {
  const primary = makeAdapter("primary", async () => {
    throw new Error("primary boom");
  });
  const auto = new AutoSearch(primary, null);
  await assert.rejects(() => auto.search("q", 5), /primary boom/);
});

test("AutoSearch: primary empty with no secondary throws zero-results error", async () => {
  const primary = makeAdapter("primary", async () => []);
  const auto = new AutoSearch(primary, null);
  await assert.rejects(() => auto.search("q", 5), /returned 0 results/);
});

test("AutoSearch: passes signal and limit to primary", async () => {
  const seen = {};
  const primary = makeAdapter("primary", async (q, limit, signal) => {
    seen.q = q;
    seen.limit = limit;
    seen.signal = signal;
    return [{ url: "https://p.example/x", title: "P", snippet: "", rank: 1 }];
  });
  const ctrl = new AbortController();
  const auto = new AutoSearch(primary, null);
  await auto.search("hello", 7, ctrl.signal);
  assert.equal(seen.q, "hello");
  assert.equal(seen.limit, 7);
  assert.equal(seen.signal, ctrl.signal);
});

test("AutoSearch: aborted signal skips secondary fallback", async () => {
  let secondaryCalled = false;
  const primary = makeAdapter("primary", async () => {
    throw new Error("primary failed");
  });
  const secondary = makeAdapter("secondary", async () => {
    secondaryCalled = true;
    return [];
  });
  const ctrl = new AbortController();
  ctrl.abort();
  const auto = new AutoSearch(primary, secondary);
  await assert.rejects(() => auto.search("q", 5, ctrl.signal), /primary failed/);
  assert.equal(secondaryCalled, false);
});

test("resolveSearchAdapter: auto resolves without DEEPDIVE_BRAVE_KEY (degrades to DDG-only)", async () => {
  const adapter = await resolveSearchAdapter("auto", {});
  assert.equal(adapter.name, "auto");
  assert.ok(adapter instanceof AutoSearch);
});

test("resolveSearchAdapter: auto resolves with DEEPDIVE_BRAVE_KEY", async () => {
  const adapter = await resolveSearchAdapter("auto", {
    DEEPDIVE_BRAVE_KEY: "test-brave-key",
  });
  assert.equal(adapter.name, "auto");
  assert.ok(adapter instanceof AutoSearch);
});
