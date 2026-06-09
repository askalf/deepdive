import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArxivAtom, ArxivSearch } from "../dist/search/arxiv.js";
import { resolveSearchAdapter } from "../dist/search.js";

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>http://arxiv.org/abs/1706.03762v7</id>
    <title>Attention Is All You
      Need</title>
    <summary>The dominant sequence transduction models are based on complex
      recurrent or convolutional neural networks.</summary>
  </entry>
  <entry>
    <id>http://arxiv.org/abs/1810.04805v2</id>
    <title>BERT: Pre-training of Deep Bidirectional Transformers</title>
    <summary>We introduce a new language representation model called BERT.</summary>
  </entry>
</feed>`;

test("parseArxivAtom: extracts url, title, summary; forces https", () => {
  const out = parseArxivAtom(SAMPLE, 10);
  assert.equal(out.length, 2);
  assert.equal(out[0].url, "https://arxiv.org/abs/1706.03762v7");
  assert.equal(out[0].title, "Attention Is All You Need"); // wrapped whitespace collapsed
  assert.match(out[0].snippet, /dominant sequence transduction/);
  assert.equal(out[0].rank, 1);
  assert.equal(out[1].rank, 2);
});

test("parseArxivAtom: respects limit", () => {
  assert.equal(parseArxivAtom(SAMPLE, 1).length, 1);
});

test("parseArxivAtom: skips entries whose id is not an arxiv.org abs url", () => {
  const xml = `<feed><entry><id>http://evil.com/x</id><title>T</title><summary>S</summary></entry></feed>`;
  assert.deepEqual(parseArxivAtom(xml, 10), []);
});

test("parseArxivAtom: decodes XML entities in the title", () => {
  const xml = `<feed><entry><id>http://arxiv.org/abs/1</id><title>A &amp; B &lt;x&gt;</title><summary>s</summary></entry></feed>`;
  assert.equal(parseArxivAtom(xml, 10)[0].title, "A & B <x>");
});

test("resolveSearchAdapter: arxiv resolves keyless", async () => {
  const a = await resolveSearchAdapter("arxiv", {});
  assert.equal(a.name, "arxiv");
  assert.ok(a instanceof ArxivSearch);
});

test("ArxivSearch.search: queries export.arxiv.org with all: prefix", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(SAMPLE, { status: 200 });
  };
  try {
    const out = await new ArxivSearch().search("transformers", 5);
    assert.match(calls[0], /export\.arxiv\.org\/api\/query/);
    assert.match(calls[0], /search_query=all%3Atransformers/);
    assert.equal(out.length, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("ArxivSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 500, statusText: "Err" });
  try {
    await assert.rejects(() => new ArxivSearch().search("q", 5), /arxiv 500/);
  } finally {
    globalThis.fetch = orig;
  }
});
