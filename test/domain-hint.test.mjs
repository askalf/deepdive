// #157 — adapter-aware allow-domain hints. The v0.29.0 live receipt showed a
// bare host token appended to the query cannot steer an aggregator's ranking
// (hinted retries fired ×3, zero allowed-host results); engine-syntax
// backends now express the hint as a site: directive, and the token form
// gains the host's leading label (which is what tokenizing engines match).

import { test } from "node:test";
import assert from "node:assert/strict";
import { siteOperatorQuery, domainHintTokens } from "../dist/search.js";
import { SearXNGSearch } from "../dist/search/searxng.js";
import { DuckDuckGoSearch } from "../dist/search/duckduckgo.js";
import { BraveSearch } from "../dist/search/brave.js";
import { AutoSearch } from "../dist/search/auto.js";
import { StackExchangeSearch } from "../dist/search/stackexchange.js";

// ── query formatters ─────────────────────────────────────────────────────────

test("siteOperatorQuery: single host, OR form for several, identity for none", () => {
  assert.equal(
    siteOperatorQuery("password rotation", ["nvlpubs.nist.gov"]),
    "password rotation site:nvlpubs.nist.gov",
  );
  assert.equal(
    siteOperatorQuery("q", ["a.com", "b.org"]),
    "q (site:a.com OR site:b.org)",
  );
  assert.equal(siteOperatorQuery("q", []), "q");
});

test("domainHintTokens: appends host + leading label; skips www/short/duplicate labels", () => {
  assert.equal(
    domainHintTokens("q", ["nvlpubs.nist.gov"]),
    "q nvlpubs.nist.gov nvlpubs",
  );
  // www label is noise; a ≤2-char label carries no signal
  assert.equal(domainHintTokens("q", ["www.example.com"]), "q www.example.com");
  assert.equal(domainHintTokens("q", ["ab.example.com"]), "q ab.example.com");
  // the same label from two hosts appears once
  assert.equal(
    domainHintTokens("q", ["nginx.org", "nginx.com"]),
    "q nginx.org nginx nginx.com",
  );
  assert.equal(domainHintTokens("q", []), "q");
});

// ── leaf adapters format site: through their own search ─────────────────────

for (const [label, make] of [
  ["searxng", () => new SearXNGSearch("http://searx.local")],
  ["duckduckgo", () => new DuckDuckGoSearch()],
  ["brave", () => new BraveSearch("key")],
]) {
  test(`${label}: searchHinted delegates to search with the site: form`, async () => {
    const adapter = make();
    const sent = [];
    adapter.search = async (query, limit) => {
      sent.push({ query, limit });
      return [];
    };
    await adapter.searchHinted("q", { hosts: ["nvlpubs.nist.gov"] }, 7);
    assert.deepEqual(sent, [{ query: "q site:nvlpubs.nist.gov", limit: 7 }]);
  });
}

test("auto: searchHinted rides the same primary→fallback path with the site: form", async () => {
  const asked = [];
  const primary = {
    name: "ddg",
    async search(query) {
      asked.push(["ddg", query]);
      return [];
    },
  };
  const fallback = {
    name: "brave",
    async search(query) {
      asked.push(["brave", query]);
      return [{ url: "https://nvlpubs.nist.gov/x", title: "t", snippet: "", rank: 1 }];
    },
  };
  const auto = new AutoSearch(primary, fallback);
  const results = await auto.searchHinted("q", { hosts: ["nvlpubs.nist.gov"] }, 5);
  assert.equal(results.length, 1);
  assert.deepEqual(asked, [
    ["ddg", "q site:nvlpubs.nist.gov"],
    ["brave", "q site:nvlpubs.nist.gov"],
  ]);
});

// ── stackexchange declares its one-site serving set (#157 structural skip) ──

test("stackexchange: servesDomains maps flagship sites to their own domains", () => {
  assert.deepEqual(new StackExchangeSearch().servesDomains, ["stackoverflow.com"]);
  assert.deepEqual(new StackExchangeSearch("serverfault").servesDomains, ["serverfault.com"]);
  assert.deepEqual(new StackExchangeSearch("mathoverflow").servesDomains, ["mathoverflow.net"]);
  assert.deepEqual(new StackExchangeSearch("unix").servesDomains, ["unix.stackexchange.com"]);
});
