import { test } from "node:test";
import assert from "node:assert/strict";
import { mapGitHubRepos, GitHubSearch } from "../dist/search/github.js";
import { resolveSearchAdapter } from "../dist/search.js";

test("mapGitHubRepos: maps url/title/snippet with star count", () => {
  const out = mapGitHubRepos(
    [
      {
        html_url: "https://github.com/a/b",
        full_name: "a/b",
        description: "a tool",
        stargazers_count: 12345,
      },
    ],
    10,
  );
  assert.equal(out[0].url, "https://github.com/a/b");
  assert.equal(out[0].title, "a/b");
  assert.match(out[0].snippet, /a tool/);
  assert.match(out[0].snippet, /★ 12k/);
  assert.equal(out[0].rank, 1);
});

test("mapGitHubRepos: handles missing description / no stars", () => {
  const out = mapGitHubRepos(
    [{ html_url: "https://github.com/a/b", full_name: "a/b", description: null }],
    10,
  );
  assert.equal(out[0].snippet, "");
});

test("mapGitHubRepos: drops items with no html_url", () => {
  const out = mapGitHubRepos(
    [{ full_name: "no/url" }, { html_url: "https://github.com/a/b", full_name: "a/b" }],
    10,
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].url, "https://github.com/a/b");
});

test("mapGitHubRepos: respects limit", () => {
  const items = Array.from({ length: 5 }, (_, i) => ({
    html_url: `https://github.com/x/${i}`,
    full_name: `x/${i}`,
  }));
  assert.equal(mapGitHubRepos(items, 3).length, 3);
});

test("resolveSearchAdapter: github resolves keyless and with token", async () => {
  const a = await resolveSearchAdapter("github", {});
  assert.equal(a.name, "github");
  assert.ok(a instanceof GitHubSearch);
  const b = await resolveSearchAdapter("github", { DEEPDIVE_GITHUB_TOKEN: "ghp_x" });
  assert.equal(b.name, "github");
});

test("GitHubSearch.search: sets UA + api-version; adds auth only with token", async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), headers: init.headers });
    return new Response(
      JSON.stringify({ items: [{ html_url: "https://github.com/a/b", full_name: "a/b" }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  try {
    await new GitHubSearch().search("postgres", 5);
    assert.match(calls[0].url, /api\.github\.com\/search\/repositories/);
    assert.match(calls[0].url, /q=postgres/);
    assert.ok(calls[0].headers["user-agent"]);
    assert.equal(calls[0].headers.authorization, undefined);

    await new GitHubSearch("ghp_secret").search("postgres", 5);
    assert.equal(calls[1].headers.authorization, "Bearer ghp_secret");
  } finally {
    globalThis.fetch = orig;
  }
});

test("GitHubSearch.search: throws on non-2xx (e.g. rate limit)", async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => new Response("rl", { status: 403, statusText: "Forbidden" });
  try {
    await assert.rejects(() => new GitHubSearch().search("q", 5), /github 403/);
  } finally {
    globalThis.fetch = orig;
  }
});
