import { test } from "node:test";
import assert from "node:assert/strict";
import { mapHNHits, HackerNewsSearch } from "../dist/search/hackernews.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapHNHits: maps url/title/snippet with points + comments", () => {
  const out = mapHNHits(
    [{ objectID: "1", title: "Cool thing", url: "https://x.com/y", points: 320, num_comments: 88, author: "pg" }],
    10,
  );
  assert.equal(out[0].url, "https://x.com/y");
  assert.equal(out[0].title, "Cool thing");
  assert.match(out[0].snippet, /320 points/);
  assert.match(out[0].snippet, /88 comments/);
  assert.match(out[0].snippet, /by pg/);
});

test("mapHNHits: Ask/Show HN (null url) falls back to the HN thread", () => {
  const out = mapHNHits([{ objectID: "42", title: "Ask HN: X?", url: null, points: 10 }], 10);
  assert.equal(out[0].url, "https://news.ycombinator.com/item?id=42");
});

test("mapHNHits: drops hits with no title or no link/objectID", () => {
  const out = mapHNHits([{ objectID: "1" }, { title: "ok", url: "https://a.com" }], 10);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ok");
});

test("mapHNHits: respects limit + 1-based rank", () => {
  const hits = Array.from({ length: 5 }, (_, i) => ({ objectID: String(i), title: "t" + i, url: `https://a/${i}` }));
  const out = mapHNHits(hits, 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.rank), [1, 2]);
});

test("resolveSearchAdapter: hackernews + hn alias resolve keyless", async () => {
  assert.equal((await resolveSearchAdapter("hackernews", {})).name, "hackernews");
  assert.equal((await resolveSearchAdapter("hn", {})).name, "hackernews");
});

test("HackerNewsSearch.search: hits the Algolia API with tags=story", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ hits: [{ objectID: "1", title: "T", url: "https://a.com", points: 5 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const out = await new HackerNewsSearch().search("rust async", 5);
    assert.match(calls[0], /hn\.algolia\.com\/api\/v1\/search/);
    assert.match(calls[0], /tags=story/);
    assert.match(calls[0], /query=rust\+async/);
    assert.equal(out[0].url, "https://a.com");
  } finally {
    globalThis.fetch = orig;
  }
});

test("HackerNewsSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 503, statusText: "Unavailable" });
  try {
    await assert.rejects(() => new HackerNewsSearch().search("q", 5), /hackernews 503/);
  } finally {
    globalThis.fetch = orig;
  }
});
