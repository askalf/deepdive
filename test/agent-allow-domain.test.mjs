// #147 — --allow-domain recovery paths.
//
// The planner's semantic queries routinely don't surface the allowed host, so
// the domain filter drops the whole round and identical invocations flip
// between a full answer and exit 3. The agent must (a) retry the round's
// queries once with the allowed host(s) appended as a search hint before
// giving up, (b) skip a fallback pass whose adapter can only serve domains
// the allow list rejects — instead of burning calls on a guaranteed-empty
// outcome — and (c) say in NoSourcesError what actually happened (results
// dropped by the filter ≠ "returned 0 usable results").

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { runAgent, NoSourcesError } from "../dist/agent.js";
import { SearchRateLimitError } from "../dist/search.js";

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

test("agent: empty-post-filter round retries once with the allowed host appended", async () => {
  const planJson = '{"queries":["q1","q2"]}';
  const synthText = "Hinted answer [1].";
  const { server, calls } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  // Plain queries surface only off-allow results; only a query carrying the
  // host token surfaces the allowed domain — the live #147 shape (a raw
  // probe with the host name found the target at rank 1 while the planner's
  // semantic queries never did).
  const queried = [];
  const search = {
    name: "mock",
    async search(query) {
      queried.push(query);
      if (query.includes("nvlpubs.nist.gov")) {
        return [{ url: "https://nvlpubs.nist.gov/target.pdf", title: "Target", snippet: "", rank: 1 }];
      }
      return [{ url: "https://seo-farm.example.com/page", title: "Farm", snippet: "", rank: 1 }];
    },
  };
  const events = [];

  try {
    const result = await runAgent("q", {
      ...BASE_CONFIG,
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search,
      domainFilter: { allow: ["nvlpubs.nist.gov"], deny: [] },
      browserFactory: mockBrowserFactory({
        "https://nvlpubs.nist.gov/target.pdf": { text: LOREM, title: "Target" },
      }),
      onEvent: (e) => {
        if (e.type === "search.hinted") events.push(e);
      },
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, "https://nvlpubs.nist.gov/target.pdf");
    assert.equal(calls.length, 2, "plan + synth — the hinted retry recovered the run");
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].hosts, ["nvlpubs.nist.gov"]);
    assert.deepEqual(events[0].queries, ["q1 nvlpubs.nist.gov", "q2 nvlpubs.nist.gov"]);
    assert.deepEqual(
      queried,
      ["q1", "q2", "q1 nvlpubs.nist.gov", "q2 nvlpubs.nist.gov"],
      "one plain pass, one hinted pass, nothing more",
    );
  } finally {
    await stopServer(server);
  }
});

test("agent: no hinted retry without an allow list", async () => {
  const planJson = '{"queries":["q1"]}';
  const { server } = makeLLMServer([planJson]);
  const baseUrl = await startServer(server);

  const queried = [];
  const search = {
    name: "empty",
    async search(query) {
      queried.push(query);
      return [];
    },
  };
  const events = [];

  try {
    await assert.rejects(
      () =>
        runAgent("q", {
          ...BASE_CONFIG,
          llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
          search,
          browserFactory: mockBrowserFactory({}),
          onEvent: (e) => {
            if (e.type === "search.hinted") events.push(e);
          },
        }),
      (err) => err instanceof NoSourcesError,
    );
    assert.deepEqual(queried, ["q1"], "no second pass — there is no host to hint with");
    assert.equal(events.length, 0);
  } finally {
    await stopServer(server);
  }
});

test("agent: rate-limited primary suppresses the hinted retry", async () => {
  const planJson = '{"queries":["q1","q2"]}';
  const { server } = makeLLMServer([planJson]);
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
    await assert.rejects(
      () =>
        runAgent("q", {
          ...BASE_CONFIG,
          llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
          search,
          domainFilter: { allow: ["nvlpubs.nist.gov"], deny: [] },
          browserFactory: mockBrowserFactory({}),
        }),
      (err) => err instanceof NoSourcesError,
    );
    assert.equal(searchCalls, 1, "hinting a limiter that just refused would dig the hole deeper");
  } finally {
    await stopServer(server);
  }
});

test("agent: fallback whose serving set fails the allow list is skipped, and the error says so", async () => {
  const planJson = '{"queries":["q1"]}';
  const { server, calls } = makeLLMServer([planJson]);
  const baseUrl = await startServer(server);

  // Primary finds results the filter drops (so the hinted retry also runs and
  // comes up empty); the wikipedia-shaped fallback can only ever serve
  // wikipedia.org — structurally useless under allow=nvlpubs.nist.gov.
  const search = {
    name: "mock",
    async search(query) {
      return [{ url: `https://seo-farm.example.com/${encodeURIComponent(query)}`, title: "Farm", snippet: "", rank: 1 }];
    },
  };
  let fallbackCalls = 0;
  const fallback = {
    name: "wikipedia",
    servesDomains: ["wikipedia.org"],
    async search() {
      fallbackCalls++;
      return [];
    },
  };
  const events = [];

  try {
    let err;
    try {
      await runAgent("q", {
        ...BASE_CONFIG,
        llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        fallbackSearch: fallback,
        domainFilter: { allow: ["nvlpubs.nist.gov"], deny: [] },
        browserFactory: mockBrowserFactory({}),
        onEvent: (e) => {
          if (e.type === "search.fallback-skipped") events.push(e);
        },
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof NoSourcesError, `expected NoSourcesError, got ${err}`);
    assert.equal(fallbackCalls, 0, "the structural no-op was never run");
    assert.equal(events.length, 1);
    assert.equal(events[0].adapter, "wikipedia");
    assert.deepEqual(events[0].allow, ["nvlpubs.nist.gov"]);
    assert.equal(err.fallbackSkipped, "wikipedia");
    assert.equal(err.droppedByDomainFilter, 2, "plain pass + hinted pass, one dropped result each");
    assert.match(err.message, /domain filter dropped every one/);
    assert.equal(calls.length, 1, "no synth call spent");
  } finally {
    await stopServer(server);
  }
});

test("agent: fallback runs when its serving set overlaps the allow list (either suffix direction)", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Recovered [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const empty = { name: "empty", async search() { return []; } };
  const fallbackQueried = [];
  const fallback = {
    name: "wikipedia",
    servesDomains: ["wikipedia.org"],
    async search(query) {
      fallbackQueried.push(query);
      return [{ url: "https://en.wikipedia.org/wiki/Thing", title: "Thing", snippet: "", rank: 1 }];
    },
  };

  try {
    // allow list names a HOST UNDER the serving domain — the adapter can
    // still produce en.wikipedia.org URLs that pass, so the pass must run.
    const result = await runAgent("q", {
      ...BASE_CONFIG,
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search: empty,
      fallbackSearch: fallback,
      domainFilter: { allow: ["en.wikipedia.org"], deny: [] },
      browserFactory: mockBrowserFactory({
        "https://en.wikipedia.org/wiki/Thing": { text: LOREM, title: "Thing" },
      }),
    });
    assert.equal(result.sources.length, 1);
    assert.ok(fallbackQueried.length > 0, "overlapping serving set — fallback consulted");
  } finally {
    await stopServer(server);
  }
});

test("agent: open-web fallback (no servesDomains) still runs under an allow list", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Recovered [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const empty = { name: "empty", async search() { return []; } };
  let fallbackCalls = 0;
  const fallback = {
    name: "open-web",
    async search() {
      fallbackCalls++;
      return [{ url: "https://nvlpubs.nist.gov/doc.pdf", title: "Doc", snippet: "", rank: 1 }];
    },
  };

  try {
    const result = await runAgent("q", {
      ...BASE_CONFIG,
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
      search: empty,
      fallbackSearch: fallback,
      domainFilter: { allow: ["nvlpubs.nist.gov"], deny: [] },
      browserFactory: mockBrowserFactory({
        "https://nvlpubs.nist.gov/doc.pdf": { text: LOREM, title: "Doc" },
      }),
    });
    assert.ok(fallbackCalls > 0, "unknown serving set — can't prove the pass useless, so it runs");
    assert.equal(result.sources.length, 1);
  } finally {
    await stopServer(server);
  }
});

test("agent: deny-only filter dropping everything is named in the error, without a hinted retry", async () => {
  const planJson = '{"queries":["q1"]}';
  const { server } = makeLLMServer([planJson]);
  const baseUrl = await startServer(server);

  const queried = [];
  const search = {
    name: "mock",
    async search(query) {
      queried.push(query);
      return [{ url: "https://pinterest.com/pin", title: "Pin", snippet: "", rank: 1 }];
    },
  };

  try {
    let err;
    try {
      await runAgent("q", {
        ...BASE_CONFIG,
        llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 512 },
        search,
        domainFilter: { allow: [], deny: ["pinterest.com"] },
        browserFactory: mockBrowserFactory({}),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err instanceof NoSourcesError);
    assert.deepEqual(queried, ["q1"], "deny-only filter has no host to hint with");
    assert.equal(err.droppedByDomainFilter, 1);
    assert.match(err.message, /domain filter dropped every one/);
  } finally {
    await stopServer(server);
  }
});
