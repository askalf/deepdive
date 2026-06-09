import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapWikipediaResults,
  wikipediaArticleUrl,
  WikipediaSearch,
} from "../dist/search/wikipedia.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("wikipediaArticleUrl: spaces become underscores, lang respected", () => {
  assert.equal(
    wikipediaArticleUrl("en", "Rate limiting"),
    "https://en.wikipedia.org/wiki/Rate_limiting",
  );
  assert.equal(
    wikipediaArticleUrl("de", "Berlin"),
    "https://de.wikipedia.org/wiki/Berlin",
  );
});

test("wikipediaArticleUrl: special chars are percent-encoded", () => {
  assert.match(wikipediaArticleUrl("en", "C# (programming)"), /C%23_\(programming\)/);
});

test("mapWikipediaResults: builds url + strips searchmatch tags + entities", () => {
  const out = mapWikipediaResults(
    [
      {
        title: "Token bucket",
        snippet: 'A <span class="searchmatch">token</span> bucket &amp; leaky bucket',
        pageid: 1,
      },
    ],
    "en",
    10,
  );
  assert.equal(out[0].url, "https://en.wikipedia.org/wiki/Token_bucket");
  assert.equal(out[0].title, "Token bucket");
  assert.equal(out[0].snippet, "A token bucket & leaky bucket");
  assert.equal(out[0].rank, 1);
});

test("mapWikipediaResults: respects limit and assigns ranks", () => {
  const items = [{ title: "A" }, { title: "B" }, { title: "C" }];
  const out = mapWikipediaResults(items, "en", 2);
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((r) => r.rank), [1, 2]);
});

test("resolveSearchAdapter: wikipedia resolves keyless, honors lang env", async () => {
  const a = await resolveSearchAdapter("wikipedia", {});
  assert.equal(a.name, "wikipedia");
  assert.ok(a instanceof WikipediaSearch);
  const b = await resolveSearchAdapter("wiki", { DEEPDIVE_WIKIPEDIA_LANG: "fr" });
  assert.equal(b.name, "wikipedia");
});

test("WikipediaSearch.search: hits the lang api.php with list=search", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(
      JSON.stringify({ query: { search: [{ title: "X", snippet: "y" }] } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    const out = await new WikipediaSearch("en").search("token bucket", 5);
    assert.match(calls[0], /en\.wikipedia\.org\/w\/api\.php/);
    assert.match(calls[0], /list=search/);
    assert.match(calls[0], /srsearch=token\+bucket/);
    assert.equal(out[0].url, "https://en.wikipedia.org/wiki/X");
  } finally {
    globalThis.fetch = orig;
  }
});

test("WikipediaSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("nope", { status: 503, statusText: "Unavailable" });
  try {
    await assert.rejects(() => new WikipediaSearch("en").search("q", 5), /wikipedia 503/);
  } finally {
    globalThis.fetch = orig;
  }
});
