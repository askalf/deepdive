import { test } from "node:test";
import assert from "node:assert/strict";
import { mapPubMedSummary, PubMedSearch } from "../dist/search/pubmed.js";
import { resolveSearchAdapter } from "../dist/search.js";

const RESULT = {
  uids: ["111", "222"],
  "111": {
    uid: "111",
    title: "A study of widgets.",
    pubdate: "2024 Mar 15",
    source: "Nature",
    authors: [{ name: "Doe J" }, { name: "Roe A" }, { name: "Poe B" }, { name: "Moe C" }],
  },
  "222": { uid: "222", title: "Another paper", pubdate: "2023", source: "Cell", authors: [{ name: "Smith K" }] },
};

test("mapPubMedSummary: builds abstract URL, trims trailing period, snippet", () => {
  const out = mapPubMedSummary(RESULT, ["111", "222"], 10);
  assert.equal(out[0].url, "https://pubmed.ncbi.nlm.nih.gov/111/");
  assert.equal(out[0].title, "A study of widgets"); // trailing . trimmed
  assert.match(out[0].snippet, /Doe J, Roe A, Poe B, et al\./); // >3 authors → et al.
  assert.match(out[0].snippet, /Nature/);
  assert.match(out[0].snippet, /2024 Mar 15/);
  assert.equal(out[1].snippet.includes("Smith K"), true);
});

test("mapPubMedSummary: preserves esearch id order + 1-based rank", () => {
  const out = mapPubMedSummary(RESULT, ["222", "111"], 10);
  assert.deepEqual(out.map((r) => r.url.match(/\/(\d+)\//)[1]), ["222", "111"]);
  assert.deepEqual(out.map((r) => r.rank), [1, 2]);
});

test("mapPubMedSummary: skips ids missing from the result map; respects limit", () => {
  const out = mapPubMedSummary(RESULT, ["111", "999", "222"], 1);
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://pubmed.ncbi.nlm.nih.gov/111/");
});

test("resolveSearchAdapter: pubmed resolves keyless", async () => {
  assert.equal((await resolveSearchAdapter("pubmed", {})).name, "pubmed");
});

test("PubMedSearch.search: esearch → esummary two-step", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    calls.push(u);
    if (u.includes("esearch")) {
      return new Response(JSON.stringify({ esearchresult: { idlist: ["111", "222"] } }), { status: 200 });
    }
    return new Response(JSON.stringify({ result: RESULT }), { status: 200 });
  };
  try {
    const out = await new PubMedSearch().search("crispr off-target", 5);
    assert.match(calls[0], /esearch\.fcgi/);
    assert.match(calls[0], /term=crispr\+off-target/);
    assert.match(calls[1], /esummary\.fcgi/);
    assert.match(calls[1], /id=111%2C222|id=111,222/);
    assert.equal(out.length, 2);
  } finally {
    globalThis.fetch = orig;
  }
});

test("PubMedSearch.search: empty id list short-circuits (no esummary call)", async () => {
  let calls = 0;
  const orig = globalThis.fetch;
  globalThis.fetch = async () => {
    calls++;
    return new Response(JSON.stringify({ esearchresult: { idlist: [] } }), { status: 200 });
  };
  try {
    const out = await new PubMedSearch().search("zzz no hits", 5);
    assert.deepEqual(out, []);
    assert.equal(calls, 1, "only esearch, no esummary");
  } finally {
    globalThis.fetch = orig;
  }
});

test("PubMedSearch.search: throws on esearch non-2xx", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("x", { status: 429, statusText: "Too Many Requests" });
  try {
    await assert.rejects(() => new PubMedSearch().search("q", 5), /pubmed esearch 429/);
  } finally {
    globalThis.fetch = orig;
  }
});
