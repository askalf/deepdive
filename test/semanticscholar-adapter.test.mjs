import { test } from "node:test";
import assert from "node:assert/strict";
import { mapS2Papers, SemanticScholarSearch } from "../dist/search/semanticscholar.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapS2Papers: maps url/title/snippet with citations + year + authors", () => {
  const out = mapS2Papers(
    [{ paperId: "abc", title: "Attention Is All You Need", url: "https://s2.org/p/abc", citationCount: 90000, year: 2017, authors: [{ name: "Vaswani A" }, { name: "Shazeer N" }, { name: "Parmar N" }, { name: "Uszkoreit J" }], abstract: "The dominant models..." }],
    10,
  );
  assert.equal(out[0].url, "https://s2.org/p/abc");
  assert.equal(out[0].title, "Attention Is All You Need");
  assert.match(out[0].snippet, /90000 citations/);
  assert.match(out[0].snippet, /2017/);
  assert.match(out[0].snippet, /Vaswani A, Shazeer N, Parmar N, et al\./);
  assert.match(out[0].snippet, /dominant models/);
});

test("mapS2Papers: falls back to the S2 page when url is missing", () => {
  const out = mapS2Papers([{ paperId: "xyz", title: "T", citationCount: 1 }], 10);
  assert.equal(out[0].url, "https://www.semanticscholar.org/paper/xyz");
});

test("mapS2Papers: drops untitled / link-less; respects limit + rank", () => {
  const out = mapS2Papers([{ paperId: "1" }, { title: "ok", url: "https://a.com" }, { title: "b", url: "https://b.com" }], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ok");
  assert.equal(out[0].rank, 1);
});

test("resolveSearchAdapter: semanticscholar + s2 alias resolve keyless", async () => {
  assert.equal((await resolveSearchAdapter("semanticscholar", {})).name, "semanticscholar");
  assert.equal((await resolveSearchAdapter("s2", {})).name, "semanticscholar");
});

test("SemanticScholarSearch.search: hits the graph API, adds x-api-key with a key", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(JSON.stringify({ data: [{ paperId: "1", title: "T", url: "https://a", citationCount: 2 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await new SemanticScholarSearch().search("transformers", 5);
    assert.match(calls[0].url, /api\.semanticscholar\.org\/graph\/v1\/paper\/search/);
    assert.match(calls[0].url, /query=transformers/);
    assert.equal(calls[0].headers["x-api-key"], undefined);
    await new SemanticScholarSearch("k2").search("x", 5);
    assert.equal(calls[1].headers["x-api-key"], "k2");
  } finally {
    globalThis.fetch = orig;
  }
});

test("SemanticScholarSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 429, statusText: "Too Many Requests" });
  try {
    await assert.rejects(() => new SemanticScholarSearch().search("q", 5), /semanticscholar 429/);
  } finally {
    globalThis.fetch = orig;
  }
});
