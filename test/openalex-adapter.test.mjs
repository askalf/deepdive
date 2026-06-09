import { test } from "node:test";
import assert from "node:assert/strict";
import { mapOpenAlexWorks, OpenAlexSearch } from "../dist/search/openalex.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapOpenAlexWorks: prefers the open landing page url", () => {
  const out = mapOpenAlexWorks(
    [{ display_name: "A work", primary_location: { landing_page_url: "https://journal.org/a" }, doi: "https://doi.org/10.1/x", publication_year: 2022, cited_by_count: 5, authorships: [{ author: { display_name: "Jane Doe" } }] }],
    10,
  );
  assert.equal(out[0].url, "https://journal.org/a");
  assert.equal(out[0].title, "A work");
  assert.match(out[0].snippet, /5 citations/);
  assert.match(out[0].snippet, /2022/);
  assert.match(out[0].snippet, /Jane Doe/);
});

test("mapOpenAlexWorks: falls back to the DOI url when no landing page", () => {
  const a = mapOpenAlexWorks([{ display_name: "T", primary_location: null, doi: "https://doi.org/10.1/x" }], 10);
  assert.equal(a[0].url, "https://doi.org/10.1/x");
  const b = mapOpenAlexWorks([{ display_name: "T", doi: "10.1/y" }], 10);
  assert.equal(b[0].url, "https://doi.org/10.1/y");
});

test("mapOpenAlexWorks: drops works with no url at all; respects limit", () => {
  const out = mapOpenAlexWorks(
    [{ display_name: "no url" }, { display_name: "ok", doi: "10.1/z" }, { display_name: "ok2", doi: "10.1/w" }],
    1,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].title, "ok");
});

test("resolveSearchAdapter: openalex resolves keyless", async () => {
  assert.equal((await resolveSearchAdapter("openalex", {})).name, "openalex");
});

test("OpenAlexSearch.search: hits the works API; adds mailto when set", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ results: [{ display_name: "T", doi: "10.1/x" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    await new OpenAlexSearch().search("crispr", 5);
    assert.match(calls[0], /api\.openalex\.org\/works/);
    assert.match(calls[0], /search=crispr/);
    assert.ok(!calls[0].includes("mailto="));
    await new OpenAlexSearch("me@x.com").search("crispr", 5);
    assert.match(calls[1], /mailto=me%40x\.com/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("OpenAlexSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 503, statusText: "Unavailable" });
  try {
    await assert.rejects(() => new OpenAlexSearch().search("q", 5), /openalex 503/);
  } finally {
    globalThis.fetch = orig;
  }
});
