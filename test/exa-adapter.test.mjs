import { test } from "node:test";
import assert from "node:assert/strict";
import { mapExaResults, ExaSearch } from "../dist/search/exa.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapExaResults: maps url and title", () => {
  const out = mapExaResults(
    [{ url: "https://a.example/x", title: "A", highlights: ["snip"] }],
    10,
  );
  assert.equal(out[0].url, "https://a.example/x");
  assert.equal(out[0].title, "A");
});

test("mapExaResults: assigns 1-based rank", () => {
  const out = mapExaResults(
    [
      { url: "https://a.example/x", title: "A" },
      { url: "https://b.example/y", title: "B" },
    ],
    10,
  );
  assert.equal(out[0].rank, 1);
  assert.equal(out[1].rank, 2);
});

test("mapExaResults: respects limit", () => {
  const out = mapExaResults(
    [
      { url: "https://a.example/x", title: "A" },
      { url: "https://b.example/y", title: "B" },
      { url: "https://c.example/z", title: "C" },
    ],
    2,
  );
  assert.equal(out.length, 2);
});

test("mapExaResults: missing title becomes empty string", () => {
  const out = mapExaResults([{ url: "https://a.example/x" }], 10);
  assert.equal(out[0].title, "");
});

test("mapExaResults: snippet prefers highlights when present", () => {
  const out = mapExaResults(
    [
      {
        url: "https://a.example/x",
        title: "A",
        highlights: ["first hit", "second hit"],
        text: "long body text that should not be used",
        summary: "summary that should not be used",
      },
    ],
    10,
  );
  assert.match(out[0].snippet, /first hit/);
  assert.match(out[0].snippet, /second hit/);
});

test("mapExaResults: snippet falls back to text when highlights missing", () => {
  const body = "x".repeat(1200);
  const out = mapExaResults(
    [{ url: "https://a.example/x", title: "A", text: body, summary: "ignored" }],
    10,
  );
  assert.equal(out[0].snippet.length, 500);
});

test("mapExaResults: snippet falls back to summary when text and highlights missing", () => {
  const out = mapExaResults(
    [{ url: "https://a.example/x", title: "A", summary: "summary fallback" }],
    10,
  );
  assert.equal(out[0].snippet, "summary fallback");
});

test("mapExaResults: snippet is empty string when nothing is present", () => {
  const out = mapExaResults([{ url: "https://a.example/x", title: "A" }], 10);
  assert.equal(out[0].snippet, "");
});

test("mapExaResults: empty input returns empty array", () => {
  assert.deepEqual(mapExaResults([], 10), []);
});

test("resolveSearchAdapter: exa requires DEEPDIVE_EXA_KEY", async () => {
  await assert.rejects(
    () => resolveSearchAdapter("exa", {}),
    /DEEPDIVE_EXA_KEY/,
  );
});

test("resolveSearchAdapter: exa resolves to ExaSearch when key set", async () => {
  const adapter = await resolveSearchAdapter("exa", {
    DEEPDIVE_EXA_KEY: "test-key",
  });
  assert.equal(adapter.name, "exa");
  assert.ok(adapter instanceof ExaSearch);
});

test("ExaSearch.search: posts to api.exa.ai with x-api-key and integration header", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(
      JSON.stringify({
        results: [
          { url: "https://a.example/x", title: "A", highlights: ["hi"] },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const adapter = new ExaSearch("secret-key");
    const results = await adapter.search("test query", 5);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.exa.ai/search");
    assert.equal(calls[0].init.method, "POST");
    assert.equal(calls[0].init.headers["x-api-key"], "secret-key");
    assert.equal(calls[0].init.headers["x-exa-integration"], "deepdive");
    const body = JSON.parse(calls[0].init.body);
    assert.equal(body.query, "test query");
    assert.equal(body.numResults, 5);
    assert.equal(results.length, 1);
    assert.equal(results[0].url, "https://a.example/x");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExaSearch.search: throws on non-2xx response", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("rate limited", { status: 429, statusText: "Too Many Requests" });
  try {
    const adapter = new ExaSearch("k");
    await assert.rejects(() => adapter.search("q", 5), /exa 429/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("ExaSearch.search: caps numResults at 100 even if limit higher", async () => {
  let body;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  };
  try {
    const adapter = new ExaSearch("k");
    await adapter.search("q", 500);
    assert.equal(body.numResults, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
