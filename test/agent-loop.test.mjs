// End-to-end test of the agent loop with mocked search, browser, and LLM.
// Spins up a tiny HTTP server that speaks enough of the Anthropic Messages
// API to satisfy callLLM, then drives the full pipeline — including the
// deep-mode critic loop — without Playwright or a real LLM.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent.js";
import { createCache } from "../dist/cache.js";

function makeLLMServer(responseQueue) {
  // responseQueue: array of strings to hand out in order, one per request.
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push({ system: parsed.system, messages: parsed.messages });
      const text = responseQueue.shift() ?? "(no more canned responses)";
      const payload = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: parsed.model,
        content: [{ type: "text", text }],
        usage: { input_tokens: 10, output_tokens: 10 },
      };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    });
  });
  return { server, calls };
}

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

// Minimal mock search adapter. Maps query → result list.
function mockSearch(resultsByQuery) {
  return {
    name: "mock",
    async search(query, limit) {
      const hits = resultsByQuery[query] ?? [];
      return hits.slice(0, limit).map((r, i) => ({ ...r, rank: i + 1 }));
    },
  };
}

// Minimal mock browser. Maps URL → FetchedPage.
function mockBrowserFactory(pagesByUrl, tracker = { opened: 0, fetched: [] }) {
  return (_opts) => {
    const session = {
      async start() {
        tracker.opened++;
      },
      async fetch(url) {
        tracker.fetched.push(url);
        const page = pagesByUrl[url];
        if (!page)
          return {
            url,
            finalUrl: url,
            status: 404,
            title: "",
            text: "",
            html: "",
            fetchedAt: Date.now(),
          };
        return {
          url,
          finalUrl: page.finalUrl ?? url,
          status: page.status ?? 200,
          title: page.title ?? "",
          text: page.text,
          html: page.html ?? `<html>${page.text}</html>`,
          fetchedAt: Date.now(),
        };
      },
      async close() {
        /* no-op */
      },
    };
    return session;
  };
}

const LOREM =
  "This is a thoroughly fake page with enough real words to survive the fifty-word minimum. " +
  "It discusses rate limits, request headers, and the distinction between five-hour and seven-day billing buckets, " +
  "plus a couple of concrete facts so the paragraph looks meaningful to the extractor. " +
  "Even the chromeRe boilerplate dropper should leave this content alone because it is real prose.";

test("agent: single-pass mode runs plan → search → fetch → synth", async () => {
  const planJson =
    '{"reasoning":"split into two facets","queries":["claude rate limit headers","anthropic 5h vs 7d bucket"]}';
  const synthText = "The rate limiter uses rolling 5h/7d buckets [1][2].";
  const { server, calls } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    "claude rate limit headers": [
      { url: "https://ex.com/a", title: "A", snippet: "..." },
    ],
    "anthropic 5h vs 7d bucket": [
      { url: "https://ex.com/b", title: "B", snippet: "..." },
    ],
  });
  const pages = {
    "https://ex.com/a": { text: LOREM, title: "A page" },
    "https://ex.com/b": { text: LOREM, title: "B page" },
  };
  const tracker = { opened: 0, fetched: [] };

  try {
    const result = await runAgent("how does the rate limiter work", {
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages, tracker),
    });

    assert.equal(result.rounds.length, 1, "exactly one round in single-pass");
    assert.equal(result.rounds[0].round, 0);
    assert.equal(result.sources.length, 2);
    assert.equal(result.usage.rounds, 1);
    assert.equal(result.usage.fetched, 2);
    assert.equal(result.usage.kept, 2);
    assert.equal(calls.length, 2, "one LLM call for plan, one for synth");
    assert.match(result.markdown, /rate limiter uses rolling/);
    assert.match(result.markdown, /## Sources/);
    assert.equal(tracker.opened, 1, "browser started exactly once");
    assert.equal(tracker.fetched.length, 2);
  } finally {
    await stopServer(server);
  }
});

test("agent: --deep runs critic + follow-up round", async () => {
  const planJson =
    '{"reasoning":"initial pass","queries":["q1","q2"]}';
  const synth1 = "First draft citing [1].";
  const critiqueJson =
    '{"done": false, "reasoning": "need more on q3", "queries": ["q3"]}';
  const synth2 = "Improved answer citing [1][2][3].";
  const { server, calls } = makeLLMServer([
    planJson,
    synth1,
    critiqueJson,
    synth2,
  ]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/1", title: "1", snippet: "" }],
    q2: [{ url: "https://ex.com/2", title: "2", snippet: "" }],
    q3: [{ url: "https://ex.com/3", title: "3", snippet: "" }],
  });
  const pages = {
    "https://ex.com/1": { text: LOREM, title: "1" },
    "https://ex.com/2": { text: LOREM, title: "2" },
    "https://ex.com/3": { text: LOREM, title: "3" },
  };

  try {
    const result = await runAgent("deep question", {
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 1,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });

    assert.equal(result.rounds.length, 2, "initial round + one follow-up");
    assert.equal(result.rounds[0].critique?.done, false);
    assert.deepEqual(result.rounds[0].critique?.queries, ["q3"]);
    assert.equal(result.sources.length, 3, "all three sources kept");
    assert.equal(
      calls.length,
      4,
      "plan + synth + critique + synth = 4 LLM calls",
    );
    assert.match(result.answer, /Improved answer/);
  } finally {
    await stopServer(server);
  }
});

test("agent: critic can terminate the loop early with done=true", async () => {
  const planJson = '{"queries":["only-query"]}';
  const synth1 = "Answer with [1].";
  const critiqueJson = '{"done": true, "reasoning": "complete", "queries": []}';
  const { server, calls } = makeLLMServer([planJson, synth1, critiqueJson]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    "only-query": [{ url: "https://ex.com/x", title: "X", snippet: "" }],
  });
  const pages = { "https://ex.com/x": { text: LOREM, title: "X" } };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 3,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });

    assert.equal(result.rounds.length, 1);
    assert.equal(result.rounds[0].critique?.done, true);
    assert.equal(
      calls.length,
      3,
      "critic says done — no second synth call",
    );
  } finally {
    await stopServer(server);
  }
});

test("agent: cache hit avoids opening the browser on re-run", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "deepdive-agent-cache-"));
  try {
    const planJson = '{"queries":["q1"]}';
    const synth = "Answer [1].";
    const pages = { "https://ex.com/1": { text: LOREM, title: "1" } };
    const search = mockSearch({
      q1: [{ url: "https://ex.com/1", title: "1", snippet: "" }],
    });

    // First run: browser gets opened + fetched.
    const first = makeLLMServer([planJson, synth]);
    const firstBase = await startServer(first.server);
    const firstTracker = { opened: 0, fetched: [] };
    const cache = createCache({ dir: cacheDir, ttlMs: 60_000 });
    try {
      const r1 = await runAgent("q", {
        llm: { baseUrl: firstBase, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
        resultsPerQuery: 5,
        maxSources: 12,
        maxWordsPerSource: 2000,
        deepRounds: 0,
        concurrency: 2,
        cache,
        browserFactory: mockBrowserFactory(pages, firstTracker),
      });
      assert.equal(firstTracker.opened, 1);
      assert.equal(firstTracker.fetched.length, 1);
      assert.equal(r1.usage.cacheHits, 0);
    } finally {
      await stopServer(first.server);
    }

    // Second run: cache hit, browser should NOT open.
    const second = makeLLMServer([planJson, synth]);
    const secondBase = await startServer(second.server);
    const secondTracker = { opened: 0, fetched: [] };
    const cache2 = createCache({ dir: cacheDir, ttlMs: 60_000 });
    try {
      const r2 = await runAgent("q", {
        llm: { baseUrl: secondBase, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
        resultsPerQuery: 5,
        maxSources: 12,
        maxWordsPerSource: 2000,
        deepRounds: 0,
        concurrency: 2,
        cache: cache2,
        browserFactory: mockBrowserFactory(pages, secondTracker),
      });
      assert.equal(secondTracker.opened, 0, "browser never opened on all-cached run");
      assert.equal(secondTracker.fetched.length, 0);
      assert.equal(r2.usage.cacheHits, 1);
    } finally {
      await stopServer(second.server);
    }
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("agent: maxSources caps the kept-source count", async () => {
  const planJson = '{"queries":["q1"]}';
  const synth = "Answer.";
  const { server } = makeLLMServer([planJson, synth]);
  const baseUrl = await startServer(server);

  const urls = Array.from({ length: 10 }, (_, i) => `https://ex.com/${i}`);
  const search = mockSearch({
    q1: urls.map((url, i) => ({ url, title: `T${i}`, snippet: "" })),
  });
  const pages = Object.fromEntries(
    urls.map((url) => [url, { text: LOREM, title: "T" }]),
  );

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 10,
      maxSources: 3,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 3);
  } finally {
    await stopServer(server);
  }
});

test("agent: survives a failed fetch (mock 500) without crashing", async () => {
  const planJson = '{"queries":["q1"]}';
  const synth = "Answer [1].";
  const { server } = makeLLMServer([planJson, synth]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [
      { url: "https://ex.com/good", title: "good", snippet: "" },
      { url: "https://ex.com/broken", title: "broken", snippet: "" },
    ],
  });
  const pages = {
    "https://ex.com/good": { text: LOREM, title: "good" },
    "https://ex.com/broken": { text: "", title: "", status: 500 },
  };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 1, "broken source dropped");
    assert.equal(result.sources[0].url, "https://ex.com/good");
  } finally {
    await stopServer(server);
  }
});
