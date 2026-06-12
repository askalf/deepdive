// Multi-adapter fan-out search.

import { test } from "node:test";
import assert from "node:assert/strict";
import { MultiSearch, interleaveResults } from "../dist/search/multi.js";
import { resolveSearchAdapter, normalizeAdapterList } from "../dist/search.js";

const r = (url, rank = 1) => ({ url, title: "t", snippet: "", rank });

function fake(name, results, fail = false) {
  return {
    name,
    async search() {
      if (fail) throw new Error(`${name} down`);
      return results;
    },
  };
}

// ── interleaveResults (pure) ─────────────────────────────────────────────────

test("interleaveResults: round-robin in adapter order, dense re-rank", () => {
  const out = interleaveResults(
    [
      [r("https://a/1"), r("https://a/2")],
      [r("https://b/1"), r("https://b/2")],
    ],
    10,
  );
  assert.deepEqual(
    out.map((x) => x.url),
    ["https://a/1", "https://b/1", "https://a/2", "https://b/2"],
  );
  assert.deepEqual(out.map((x) => x.rank), [1, 2, 3, 4]);
});

test("interleaveResults: dedupes on normalized url across adapters", () => {
  const out = interleaveResults(
    [[r("https://x.com/page")], [r("https://x.com/page/"), r("https://y.com")]],
    10,
  );
  // trailing-slash variant of the same page deduped; first occurrence wins
  assert.deepEqual(out.map((x) => x.url), ["https://x.com/page", "https://y.com"]);
});

test("interleaveResults: respects limit and uneven list lengths", () => {
  const out = interleaveResults(
    [[r("https://a/1")], [r("https://b/1"), r("https://b/2"), r("https://b/3")]],
    3,
  );
  assert.deepEqual(
    out.map((x) => x.url),
    ["https://a/1", "https://b/1", "https://b/2"],
  );
});

test("interleaveResults: empty input → empty output", () => {
  assert.deepEqual(interleaveResults([], 5), []);
  assert.deepEqual(interleaveResults([[], []], 5), []);
});

// ── MultiSearch ──────────────────────────────────────────────────────────────

test("MultiSearch: name reflects the sub-adapters; <2 adapters throws", () => {
  const m = new MultiSearch([fake("a", []), fake("b", [])]);
  assert.equal(m.name, "multi(a,b)");
  assert.throws(() => new MultiSearch([fake("a", [])]), /at least two/);
});

test("MultiSearch: merges concurrent results", async () => {
  const m = new MultiSearch([
    fake("a", [r("https://a/1"), r("https://a/2")]),
    fake("b", [r("https://b/1")]),
  ]);
  const out = await m.search("q", 10);
  assert.deepEqual(
    out.map((x) => x.url),
    ["https://a/1", "https://b/1", "https://a/2"],
  );
});

test("MultiSearch: tolerates a failing sub-adapter", async () => {
  const m = new MultiSearch([fake("a", [], true), fake("b", [r("https://b/1")])]);
  const out = await m.search("q", 10);
  assert.deepEqual(out.map((x) => x.url), ["https://b/1"]);
});

test("MultiSearch: throws only when every sub-adapter fails, naming each", async () => {
  const m = new MultiSearch([fake("a", [], true), fake("b", [], true)]);
  await assert.rejects(() => m.search("q", 10), /every sub-adapter failed.*a: a down.*b: b down/);
});

// ── resolveSearchAdapter syntax ──────────────────────────────────────────────

test("resolveSearchAdapter: multi:ddg,wikipedia resolves with composite name", async () => {
  const a = await resolveSearchAdapter("multi:duckduckgo,wikipedia", {});
  assert.equal(a.name, "multi(duckduckgo,wikipedia)");
});

test("resolveSearchAdapter: bare multi / single-entry list / nesting are rejected", async () => {
  await assert.rejects(() => resolveSearchAdapter("multi", {}), /comma-separated adapter list/);
  await assert.rejects(() => resolveSearchAdapter("multi:duckduckgo", {}), /comma-separated adapter list/);
  await assert.rejects(
    () => resolveSearchAdapter("multi:duckduckgo,multi:arxiv,wiki", {}),
    /cannot nest/,
  );
});

test("resolveSearchAdapter: unknown sub-adapter inside multi surfaces its error", async () => {
  await assert.rejects(() => resolveSearchAdapter("multi:duckduckgo,bogus", {}), /unknown search adapter: bogus/);
});

test("resolveSearchAdapter: keyed sub-adapter inside multi still requires its key", async () => {
  await assert.rejects(() => resolveSearchAdapter("multi:duckduckgo,brave", {}), /DEEPDIVE_BRAVE_KEY/);
});

// ── normalizeAdapterList (pure) ──────────────────────────────────────────────

test("normalizeAdapterList: single name passes through", () => {
  assert.equal(normalizeAdapterList("wikipedia"), "wikipedia");
  assert.equal(normalizeAdapterList(" Wikipedia "), "wikipedia");
});

test("normalizeAdapterList: comma list gains the multi: prefix", () => {
  assert.equal(normalizeAdapterList("wikipedia,arxiv"), "multi:wikipedia,arxiv");
  assert.equal(normalizeAdapterList("a, b , c"), "multi:a,b,c");
});

test("normalizeAdapterList: existing multi: spelling is preserved", () => {
  assert.equal(normalizeAdapterList("multi:a,b"), "multi:a,b");
});

test("normalizeAdapterList: empty and comma-only input return undefined", () => {
  assert.equal(normalizeAdapterList(""), undefined);
  assert.equal(normalizeAdapterList("  "), undefined);
  assert.equal(normalizeAdapterList(",,"), undefined);
});
