// Zero-source guard + search error tolerance (v0.20.0).
//
// The agent must (a) survive individual search failures, (b) stop asking a
// rate-limited backend for the rest of the round, and (c) throw NoSourcesError
// BEFORE the synthesis LLM call when the pipeline gathered nothing — the
// observed failure mode was DDG silently rate-limiting a burst, leaving an
// all-zero round that still burned a synth call on "unable to answer".

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runAgent, NoSourcesError } from "../dist/agent.js";
import { SearchRateLimitError } from "../dist/search.js";
import { MultiSearch } from "../dist/search/multi.js";

function makeLLMServer(responseQueue) {
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push({ system: parsed.system, messages: parsed.messages });
      const text = responseQueue.shift() ?? "(no more canned responses)";
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          id: "msg_test",
          type: "message",
          role: "assistant",
          model: parsed.model,
          content: [{ type: "text", text }],
          usage: { input_tokens: 10, output_tokens: 10 },
        }),
      );
    });
  });
  return { server, calls };
}

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve(`http://127.0.0.1:${server.address().port}`);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function mockBrowserFactory(pagesByUrl) {
  return () => ({
    async start() {},
    async fetch(url) {
      const page = pagesByUrl[url];
      if (!page)
        return { url, finalUrl: url, status: 404, title: "", text: "", html: "", fetchedAt: Date.now() };
      return {
        url,
        finalUrl: url,
        status: 200,
        title: page.title ?? "",
        text: page.text,
        html: `<html>${page.text}</html>`,
        fetchedAt: Date.now(),
      };
    },
    async close() {},
  });
}

const LOREM =
  "This is a thoroughly fake page with enough real words to survive the fifty-word minimum. " +
  "It discusses rate limits, request headers, and the distinction between five-hour and seven-day billing buckets, " +
  "plus a couple of concrete facts so the paragraph looks meaningful to the extractor. " +
  "Even the chromeRe boilerplate dropper should leave this content alone because it is real prose.";

const BASE_CONFIG = {
  browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
  resultsPerQuery: 5,
  maxSources: 12,
  maxWordsPerSource: 2000,
  deepRounds: 0,
  concurrency: 2,
};

test("agent: all-zero search results throw NoSourcesError before the synth call", async () => {
  const planJson = '{"queries":["q1","q2"]}';
  const { server, calls } = makeLLMServer([planJson, "SHOULD NEVER BE REQUESTED"]);
  const baseUrl = await startServer(server);

  const search = { name: "empty", async search() { return []; } };

  try {
    let err;
    try {
      await runAgent("q", {
        ...BASE_CONFIG,
        llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        browserFactory: mockBrowserFactory({}),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof NoSourcesError, `expected NoSourcesError, got ${err}`);
    assert.equal(err.adapter, "empty");
    assert.deepEqual(err.queries, ["q1", "q2"]);
    assert.equal(err.candidatesFound, 0);
    assert.deepEqual(err.searchErrors, []);
    assert.equal(calls.length, 1, "plan call only — the synth call was never spent");
  } finally {
    await stopServer(server);
  }
});

test("agent: one failed query doesn't kill the run; search.error is emitted", async () => {
  const planJson = '{"queries":["broken","working"]}';
  const synthText = "Answer [1].";
  const { server, calls } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = {
    name: "flaky",
    async search(query) {
      if (query === "broken") throw new Error("backend exploded");
      return [{ url: "https://ex.com/good", title: "Good", snippet: "", rank: 1 }];
    },
  };
  const events = [];

  try {
    const result = await runAgent("q", {
      ...BASE_CONFIG,
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      browserFactory: mockBrowserFactory({ "https://ex.com/good": { text: LOREM, title: "Good" } }),
      onEvent: (e) => {
        if (e.type === "search.error") events.push(e);
      },
    });
    assert.equal(result.sources.length, 1, "the working query's source was kept");
    assert.equal(calls.length, 2, "plan + synth — run completed normally");
    assert.equal(events.length, 1);
    assert.equal(events[0].query, "broken");
    assert.equal(events[0].rateLimited, false);
    assert.match(events[0].message, /backend exploded/);
  } finally {
    await stopServer(server);
  }
});

test("agent: rate-limit short-circuits the round's remaining queries", async () => {
  const planJson = '{"queries":["q1","q2","q3"]}';
  const { server, calls } = makeLLMServer([planJson]);
  const baseUrl = await startServer(server);

  let searchCalls = 0;
  const search = {
    name: "throttled",
    async search() {
      searchCalls++;
      throw new SearchRateLimitError("throttled", "HTTP 403");
    },
  };

  try {
    let err;
    try {
      await runAgent("q", {
        ...BASE_CONFIG,
        llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        browserFactory: mockBrowserFactory({}),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof NoSourcesError);
    assert.equal(searchCalls, 1, "q2/q3 skipped — don't hammer a limiter that just refused");
    assert.equal(err.searchErrors.length, 1);
    assert.equal(err.searchErrors[0].rateLimited, true);
    assert.match(err.message, /rate-limited/);
    assert.equal(calls.length, 1, "no synth call spent");
  } finally {
    await stopServer(server);
  }
});

test("agent: preKept sources avert the zero-source abort", async () => {
  // `deepdive continue <id>` with a dead search backend should still
  // re-synthesize from the saved sources rather than abort.
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer from saved material [1].";
  const { server, calls } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = { name: "empty", async search() { return []; } };

  try {
    const result = await runAgent("q", {
      ...BASE_CONFIG,
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      preKept: [
        {
          id: 1,
          url: "https://ex.com/saved",
          title: "Saved",
          fetchedAt: Date.now() - 86400000,
          content: "previously fetched content",
        },
      ],
      browserFactory: mockBrowserFactory({}),
    });
    assert.equal(result.sources.length, 1);
    assert.equal(calls.length, 2, "plan + synth — saved sources are enough to proceed");
  } finally {
    await stopServer(server);
  }
});

test("agent: candidates found but none fetchable → NoSourcesError names the fetch side", async () => {
  const planJson = '{"queries":["q1"]}';
  const { server, calls } = makeLLMServer([planJson]);
  const baseUrl = await startServer(server);

  const search = {
    name: "mock",
    async search() {
      return [{ url: "https://ex.com/dead", title: "Dead", snippet: "", rank: 1 }];
    },
  };

  try {
    let err;
    try {
      await runAgent("q", {
        ...BASE_CONFIG,
        llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        browserFactory: mockBrowserFactory({}), // every fetch 404s
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof NoSourcesError);
    assert.equal(err.candidatesFound, 1);
    assert.match(err.message, /none could be fetched/);
    assert.equal(calls.length, 1);
  } finally {
    await stopServer(server);
  }
});

test("multi: all sub-adapters rate-limited classifies as a rate limit", async () => {
  const limited = (name) => ({
    name,
    async search() {
      throw new SearchRateLimitError(name, "HTTP 429");
    },
  });
  const multi = new MultiSearch([limited("a"), limited("b")]);
  await assert.rejects(
    () => multi.search("q", 5),
    (err) => err instanceof SearchRateLimitError,
  );
});

test("multi: mixed failures stay a plain error", async () => {
  const limited = {
    name: "a",
    async search() {
      throw new SearchRateLimitError("a", "HTTP 429");
    },
  };
  const broken = {
    name: "b",
    async search() {
      throw new Error("parse failure");
    },
  };
  const multi = new MultiSearch([limited, broken]);
  await assert.rejects(
    () => multi.search("q", 5),
    (err) => !(err instanceof SearchRateLimitError) && /every sub-adapter failed/.test(err.message),
  );
});
