import { test } from "node:test";
import assert from "node:assert/strict";
import { mapStackExchangeItems, StackExchangeSearch } from "../dist/search/stackexchange.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapStackExchangeItems: maps link/title/score, decodes entities", () => {
  const out = mapStackExchangeItems(
    [{ title: "How to &quot;escape&quot; a string &amp; more", link: "https://so.com/q/1", score: 42, answer_count: 3, is_answered: true }],
    10,
  );
  assert.equal(out[0].url, "https://so.com/q/1");
  assert.equal(out[0].title, 'How to "escape" a string & more');
  assert.match(out[0].snippet, /score 42/);
  assert.match(out[0].snippet, /3 answers/);
  assert.match(out[0].snippet, /accepted/);
});

test("mapStackExchangeItems: numeric entity decoded", () => {
  const out = mapStackExchangeItems([{ title: "don&#39;t", link: "https://a.com" }], 10);
  assert.equal(out[0].title, "don't");
});

test("mapStackExchangeItems: drops items with no link, respects limit", () => {
  const items = [{ title: "no link" }, { title: "a", link: "https://a" }, { title: "b", link: "https://b" }];
  const out = mapStackExchangeItems(items, 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://a");
});

test("resolveSearchAdapter: stackexchange/so aliases + custom site", async () => {
  assert.equal((await resolveSearchAdapter("stackexchange", {})).name, "stackexchange");
  assert.equal((await resolveSearchAdapter("so", {})).name, "stackexchange");
  assert.equal((await resolveSearchAdapter("stackexchange", { DEEPDIVE_STACKEXCHANGE_SITE: "serverfault" })).name, "stackexchange");
});

test("StackExchangeSearch.search: hits the API with site + q", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [{ title: "Q", link: "https://so.com/q", score: 1 }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const out = await new StackExchangeSearch("serverfault").search("nginx 502", 5);
    assert.match(calls[0], /api\.stackexchange\.com\/2\.3\/search\/advanced/);
    assert.match(calls[0], /site=serverfault/);
    assert.match(calls[0], /q=nginx\+502/);
    assert.equal(out[0].url, "https://so.com/q");
  } finally {
    globalThis.fetch = orig;
  }
});

test("StackExchangeSearch.search: verbatim hit makes exactly one call (no ladder)", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [{ title: "Q", link: "https://so.com/q" }] }), { status: 200 });
  };
  try {
    const out = await new StackExchangeSearch().search("nginx 502 upstream", 5);
    assert.equal(calls.length, 1);
    assert.equal(out.length, 1);
  } finally {
    globalThis.fetch = orig;
  }
});

test("StackExchangeSearch.search: zero-result NL query walks the keyword ladder (#131)", async () => {
  // The real niche-ops bench question: verbatim returns zero (SE literal
  // match), the 4-keyword variant hits. Mirrors the #86 wikipedia fix.
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    const q = new URL(String(url)).searchParams.get("q");
    const items =
      q === "nginx return 502 upstream" ? [{ title: "fix", link: "https://serverfault.com/q/1" }] : [];
    return new Response(JSON.stringify({ items }), { status: 200 });
  };
  try {
    const out = await new StackExchangeSearch("serverfault").search(
      "why does nginx return 502 with an upstream sent too big header error and how do you fix it",
      5,
    );
    assert.equal(calls.length, 2); // verbatim (zero) + first ladder variant (hit)
    assert.match(calls[1], /q=nginx\+return\+502\+upstream/);
    assert.equal(out[0].url, "https://serverfault.com/q/1");
  } finally {
    globalThis.fetch = orig;
  }
});

test("StackExchangeSearch.search: all-zero returns [] after exhausting the ladder", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ items: [] }), { status: 200 });
  };
  try {
    const out = await new StackExchangeSearch().search("why does nginx return 502 errors", 5);
    assert.equal(out.length, 0);
    assert.ok(calls.length > 1 && calls.length <= 4, `verbatim + ≤3 ladder calls, got ${calls.length}`);
  } finally {
    globalThis.fetch = orig;
  }
});

test("StackExchangeSearch.search: surfaces API error_message", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error_message: "too many requests" }), { status: 200 });
  try {
    await assert.rejects(() => new StackExchangeSearch().search("q", 5), /too many requests/);
  } finally {
    globalThis.fetch = orig;
  }
});

test("StackExchangeSearch.search: throws on non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 400, statusText: "Bad Request" });
  try {
    await assert.rejects(() => new StackExchangeSearch().search("q", 5), /stackexchange 400/);
  } finally {
    globalThis.fetch = orig;
  }
});
