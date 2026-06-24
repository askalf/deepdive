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

// ── lastFailures + benching (v0.21.0) ────────────────────────────────────────

function countingFake(name, behave) {
  const calls = { n: 0 };
  return {
    calls,
    adapter: {
      name,
      async search(q, limit) {
        calls.n++;
        return behave(q, limit, calls.n);
      },
    },
  };
}

test("MultiSearch: partial failure lands in lastFailures, others' results returned", async () => {
  const a = { name: "a", async search() { throw new Error("a exploded"); } };
  const b = fake("b", [r("https://b/1")]);
  const m = new MultiSearch([a, b]);
  const out = await m.search("q", 10);
  assert.equal(out.length, 1);
  assert.equal(m.lastFailures.length, 1);
  assert.equal(m.lastFailures[0].adapter, "a");
  assert.equal(m.lastFailures[0].rateLimited, false);
  assert.match(m.lastFailures[0].message, /a exploded/);
});

test("MultiSearch: plain failure is NOT benched — retried next query", async () => {
  const failing = countingFake("a", () => { throw new Error("flaky"); });
  const ok = fake("b", [r("https://b/1")]);
  const m = new MultiSearch([failing.adapter, ok]);
  await m.search("q1", 10);
  await m.search("q2", 10);
  assert.equal(failing.calls.n, 2, "plain failures keep getting retried");
});

test("MultiSearch: rate-limited sub-adapter is benched for the run's remainder", async () => {
  const { SearchRateLimitError } = await import("../dist/search.js");
  const limited = countingFake("ddg", () => { throw new SearchRateLimitError("ddg", "HTTP 403"); });
  const ok = fake("so", [r("https://so/1")]);
  const m = new MultiSearch([limited.adapter, ok]);

  const out1 = await m.search("q1", 10);
  assert.equal(out1.length, 1);
  assert.equal(limited.calls.n, 1);
  assert.equal(m.lastFailures[0].rateLimited, true);

  const out2 = await m.search("q2", 10);
  assert.equal(out2.length, 1);
  assert.equal(limited.calls.n, 1, "benched — not asked again");
  assert.equal(m.lastFailures.length, 1, "bench stays visible in lastFailures");
  assert.match(m.lastFailures[0].message, /rate-limited earlier/);
});

test("MultiSearch: every sub-adapter benched throws SearchRateLimitError", async () => {
  const { SearchRateLimitError } = await import("../dist/search.js");
  const lim = (name) => ({ name, async search() { throw new SearchRateLimitError(name, "429"); } });
  const m = new MultiSearch([lim("a"), lim("b")]);
  await assert.rejects(() => m.search("q1", 10), (e) => e instanceof SearchRateLimitError);
  await assert.rejects(
    () => m.search("q2", 10),
    (e) => e instanceof SearchRateLimitError && /every sub-adapter is rate-limited/.test(e.message),
  );
});

test("MultiSearch: lastFailures resets between calls", async () => {
  let fail = true;
  const flaky = { name: "a", async search() { if (fail) throw new Error("once"); return [r("https://a/1")]; } };
  const ok = fake("b", [r("https://b/1")]);
  const m = new MultiSearch([flaky, ok]);
  await m.search("q1", 10);
  assert.equal(m.lastFailures.length, 1);
  fail = false;
  await m.search("q2", 10);
  assert.equal(m.lastFailures.length, 0, "healthy call leaves no stale failures");
});

// ── #111 P4: search-side authority bias in interleaveResults ──────────────────
// Real domains from src/source-authority.ts: arxiv.org/redis.io = primary,
// gpt0x.com/aiflashreport.com/lmmarketcap.com/precisionaiacademy.com = low.

test("interleaveResults: default mode is unchanged plain round-robin", () => {
  // No third arg, and explicit "off", both preserve search order + dense rank.
  const lists = [[r("https://gpt0x.com/1"), r("https://lmmarketcap.com/3")], [r("https://arxiv.org/abs/1")]];
  const expected = ["https://gpt0x.com/1", "https://arxiv.org/abs/1", "https://lmmarketcap.com/3"];
  assert.deepEqual(interleaveResults(lists, 10).map((x) => x.url), expected);
  assert.deepEqual(interleaveResults(lists, 10, "off").map((x) => x.url), expected);
});

test("interleaveResults: prefer floats a low-ranked primary above farms before the cap", () => {
  // A general-web list of farms (ranked first by search) plus one primary that
  // search ranked LAST; with limit 3 the primary is truncated under plain
  // round-robin but survives once authority reorders the pool before the cap.
  const lists = [
    [
      r("https://gpt0x.com/1"),
      r("https://aiflashreport.com/2"),
      r("https://lmmarketcap.com/3"),
      r("https://arxiv.org/abs/2401.00001"),
    ],
    [r("https://precisionaiacademy.com/1")],
  ];
  // off: arxiv falls outside the top 3 (gpt0x, precisionaiacademy, aiflashreport).
  assert.ok(!interleaveResults(lists, 3, "off").some((x) => x.url === "https://arxiv.org/abs/2401.00001"));
  // prefer: arxiv (primary, 1.0) is reordered to the front and wins a slot.
  const preferred = interleaveResults(lists, 3, "prefer");
  assert.equal(preferred[0].url, "https://arxiv.org/abs/2401.00001");
  assert.deepEqual(preferred.map((x) => x.rank), [1, 2, 3]);
});

test("interleaveResults: prefer keeps search order stable within a tier", () => {
  // Two primaries — relative order must follow search order (stable sort);
  // the unknown-tier source sinks below both but is not dropped.
  const lists = [
    [r("https://example.com/x"), r("https://redis.io/docs/a"), r("https://arxiv.org/abs/9")],
  ];
  const out = interleaveResults(lists, 10, "prefer").map((x) => x.url);
  assert.deepEqual(out, ["https://redis.io/docs/a", "https://arxiv.org/abs/9", "https://example.com/x"]);
});

test("interleaveResults: strict drops known farms when a better source exists", () => {
  const lists = [
    [r("https://gpt0x.com/1"), r("https://aiflashreport.com/2"), r("https://redis.io/docs/x")],
  ];
  const out = interleaveResults(lists, 10, "strict").map((x) => x.url);
  assert.deepEqual(out, ["https://redis.io/docs/x"]);
});

test("interleaveResults: strict min-keep floor returns farms when nothing else surfaced", () => {
  // An all-farm round (recency/trending topic) must still return sources rather
  // than nothing — the floor keeps them, in plain search order.
  const lists = [[r("https://gpt0x.com/1")], [r("https://aiflashreport.com/2")]];
  const out = interleaveResults(lists, 5, "strict").map((x) => x.url);
  assert.deepEqual(out, ["https://gpt0x.com/1", "https://aiflashreport.com/2"]);
});

test("MultiSearch: threads its authority mode into the merged result order", async () => {
  const m = new MultiSearch(
    [
      fake("web", [r("https://gpt0x.com/1"), r("https://arxiv.org/abs/2")]),
      fake("docs", [r("https://aiflashreport.com/3")]),
    ],
    "prefer",
  );
  const out = await m.search("q", 2);
  // arxiv (primary) is reordered ahead of the farms regardless of search rank.
  assert.equal(out[0].url, "https://arxiv.org/abs/2");
});

test("MultiSearch: default (no mode) leaves plain round-robin order", async () => {
  const m = new MultiSearch([
    fake("web", [r("https://gpt0x.com/1"), r("https://arxiv.org/abs/2")]),
    fake("docs", [r("https://aiflashreport.com/3")]),
  ]);
  const out = await m.search("q", 10);
  assert.deepEqual(
    out.map((x) => x.url),
    ["https://gpt0x.com/1", "https://aiflashreport.com/3", "https://arxiv.org/abs/2"],
  );
});
