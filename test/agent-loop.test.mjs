// End-to-end test of the agent loop with mocked search, browser, and LLM.
// Spins up a tiny HTTP server that speaks enough of the Anthropic Messages
// API to satisfy callLLM, then drives the full pipeline — including the
// deep-mode critic loop — without Playwright or a real LLM.

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../dist/agent.js";
import { createCache } from "../dist/cache.js";

function makeLLMServer(responseQueue, usageQueue) {
  // responseQueue: array of strings to hand out in order, one per request.
  // usageQueue (optional): per-call {input_tokens, output_tokens}; defaults
  // to {10,10} when not provided so existing tests keep working.
  const calls = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      const parsed = JSON.parse(body);
      calls.push({ system: parsed.system, messages: parsed.messages });
      const text = responseQueue.shift() ?? "(no more canned responses)";
      const usage = usageQueue?.shift() ?? { input_tokens: 10, output_tokens: 10 };
      const payload = {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: parsed.model,
        content: [{ type: "text", text }],
        usage,
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
          mimeType: page.mimeType,
          bytes: page.bytes,
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

test("agent: verification report flags a synthesized cite missing from source", async () => {
  // Source content is the LOREM rate-limit prose. Synth output cites [1] for
  // a sentence whose content tokens (jellyfish, mongoose) appear nowhere in
  // the source — so the verifier should flag it.
  const planJson = '{"queries":["q1"]}';
  const synthText =
    "The system uses a jellyfish-mongoose protocol for backpressure [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "" }],
  });
  const pages = { "https://ex.com/a": { text: LOREM, title: "A" } };

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
    assert.ok(result.verification, "verification report attached to result");
    assert.equal(result.verification.totalCitations, 1);
    assert.equal(result.verification.supportedCitations, 0);
    assert.equal(result.verification.unsupported.length, 1);
    assert.equal(result.usage.citationsTotal, 1);
    assert.equal(result.usage.citationsSupported, 0);
  } finally {
    await stopServer(server);
  }
});

test("agent: verifyCitations: false skips verification entirely", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Anything at all [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "" }],
  });
  const pages = { "https://ex.com/a": { text: LOREM, title: "A" } };

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
      verifyCitations: false,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.verification, undefined);
    assert.equal(result.usage.citationsTotal, 0);
  } finally {
    await stopServer(server);
  }
});

test("agent: accumulates LLM usage across plan + synth + critique calls", async () => {
  const planJson = '{"queries":["q1"]}';
  const synth1 = "Draft [1].";
  const critiqueJson = '{"done": false, "queries": ["q2"]}';
  const synth2 = "Final [1][2].";
  // 4 calls total: plan (100/20), synth (300/80), critique (50/30), synth (350/100)
  // totals: input 800, output 230
  // For claude-sonnet-4-6 (3/15 per MTok):
  //   800 * 3 / 1e6 = 0.0024
  //   230 * 15 / 1e6 = 0.00345
  //   total = 0.00585
  const usageQueue = [
    { input_tokens: 100, output_tokens: 20 },
    { input_tokens: 300, output_tokens: 80 },
    { input_tokens: 50, output_tokens: 30 },
    { input_tokens: 350, output_tokens: 100 },
  ];
  const { server } = makeLLMServer(
    [planJson, synth1, critiqueJson, synth2],
    usageQueue,
  );
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/1", title: "1", snippet: "" }],
    q2: [{ url: "https://ex.com/2", title: "2", snippet: "" }],
  });
  const pages = {
    "https://ex.com/1": { text: LOREM, title: "1" },
    "https://ex.com/2": { text: LOREM, title: "2" },
  };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 1,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.usage.llm.calls, 4);
    assert.equal(result.usage.llm.inputTokens, 800);
    assert.equal(result.usage.llm.outputTokens, 230);
    // Cost math at sonnet pricing (3/15 per MTok)
    assert.ok(
      Math.abs(result.usage.estimatedCostUsd - 0.00585) < 1e-9,
      `expected ~$0.00585, got ${result.usage.estimatedCostUsd}`,
    );
    assert.equal(result.cost.knownModel, true);
  } finally {
    await stopServer(server);
  }
});

test("agent: emits llm.call events with phase + token counts", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1].";
  const usageQueue = [
    { input_tokens: 11, output_tokens: 22 },
    { input_tokens: 33, output_tokens: 44 },
  ];
  const { server } = makeLLMServer([planJson, synthText], usageQueue);
  const baseUrl = await startServer(server);
  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "" }],
  });
  const pages = { "https://ex.com/a": { text: LOREM, title: "A" } };

  const events = [];
  try {
    await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
      onEvent: (e) => {
        if (e.type === "llm.call") events.push(e);
      },
    });
    assert.equal(events.length, 2);
    assert.equal(events[0].phase, "plan");
    assert.equal(events[0].inputTokens, 11);
    assert.equal(events[0].outputTokens, 22);
    assert.equal(events[1].phase, "synth");
    assert.equal(events[1].inputTokens, 33);
    assert.equal(events[1].outputTokens, 44);
  } finally {
    await stopServer(server);
  }
});

test("agent: unknown model yields knownModel=false and amountUsd=0", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);
  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "" }],
  });
  const pages = { "https://ex.com/a": { text: LOREM, title: "A" } };
  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "self-hosted-mystery", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.cost.knownModel, false);
    assert.equal(result.cost.amountUsd, 0);
    // Tokens still accumulate even when there's no price.
    assert.ok(result.usage.llm.inputTokens > 0);
    assert.ok(result.usage.llm.outputTokens > 0);
  } finally {
    await stopServer(server);
  }
});

test("agent: --deep + verifier — weak cites land in the critic prompt", async () => {
  const planJson = '{"queries":["q1"]}';
  // Round 0 synth: cites [1] for content not in source 1's text
  // (LOREM is about rate limits; this draft mentions mongoose-jellyfish).
  const synth1 = "The system uses a jellyfish-mongoose protocol [1].";
  // We capture the critique request so we can inspect what reached the
  // LLM. The critique can return any reasonable JSON.
  const critiqueJson = '{"done": false, "queries": ["jellyfish mongoose protocol authoritative"]}';
  const synth2 = "Better answer [1][2].";
  const { server, calls } = makeLLMServer([
    planJson,
    synth1,
    critiqueJson,
    synth2,
  ]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "" }],
    "jellyfish mongoose protocol authoritative": [
      { url: "https://ex.com/b", title: "B", snippet: "" },
    ],
  });
  const pages = {
    "https://ex.com/a": { text: LOREM, title: "A" },
    "https://ex.com/b": { text: LOREM, title: "B" },
  };

  try {
    await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 1,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    // calls[2] is the critique LLM request. Its user message should
    // include the weakly-supported sentence flagged by the in-loop
    // verifier.
    const critiquePayload = calls[2];
    const userText = critiquePayload.messages[0].content;
    assert.match(
      userText,
      /Sentences with weak citations/,
      "critique message includes the weak-cite section",
    );
    assert.match(
      userText,
      /jellyfish-mongoose/,
      "the offending sentence is surfaced to the critic",
    );
  } finally {
    await stopServer(server);
  }
});

test("agent: domain deny-list drops matching candidates with fetch.skipped", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [
      { url: "https://pinterest.com/post/x", title: "P", snippet: "" },
      { url: "https://docs.anthropic.com/x", title: "D", snippet: "" },
    ],
  });
  const pages = {
    "https://docs.anthropic.com/x": { text: LOREM, title: "Docs" },
  };
  const events = [];
  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      domainFilter: { allow: [], deny: ["pinterest.com"] },
      browserFactory: mockBrowserFactory(pages),
      onEvent: (e) => {
        if (e.type === "fetch.skipped") events.push(e);
      },
    });
    assert.equal(result.sources.length, 1, "only the docs source was kept");
    assert.equal(result.sources[0].url, "https://docs.anthropic.com/x");
    assert.equal(events.length, 1);
    assert.equal(events[0].reason, "domain-deny");
    assert.equal(events[0].url, "https://pinterest.com/post/x");
  } finally {
    await stopServer(server);
  }
});

test("agent: domain allow-list keeps only matching candidates", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [
      { url: "https://pinterest.com/post/x", title: "P", snippet: "" },
      { url: "https://api.github.com/x", title: "G", snippet: "" },
    ],
  });
  const pages = {
    "https://api.github.com/x": { text: LOREM, title: "GH" },
  };
  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      // Subdomain match — github.com pattern matches api.github.com.
      domainFilter: { allow: ["github.com"], deny: [] },
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 1);
    assert.equal(result.sources[0].url, "https://api.github.com/x");
  } finally {
    await stopServer(server);
  }
});

test("agent: --include ingests local files as pre-fetched sources", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Combined answer [1][2].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const dir = mkdtempSync(join(tmpdir(), "deepdive-include-"));
  try {
    const md = join(dir, "personal-note.md");
    writeFileSync(md, "# my notes\n\nspecific local-only fact about X");

    const search = mockSearch({
      q1: [{ url: "https://ex.com/web", title: "W", snippet: "" }],
    });
    const pages = { "https://ex.com/web": { text: LOREM, title: "web page" } };

    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      include: [md],
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 2, "1 local + 1 web source");
    // Local source comes first (id=1) — most prominent to the synthesizer.
    assert.equal(result.sources[0].title, "personal-note.md");
    assert.match(result.sources[0].url, /^file:/);
    assert.match(result.sources[0].content, /local-only fact about X/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    await stopServer(server);
  }
});

test("agent: preKept (v0.12.0 continue) seeds saved sources alongside fresh search results", async () => {
  // Simulates `deepdive continue <id> [<question>]` — the saved
  // session's sources are passed in as preKept; the agent still does a
  // full search/fetch round and they appear together in the synth
  // packet.
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer drawing on both [1] and [2].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/fresh", title: "Fresh", snippet: "" }],
  });
  const pages = { "https://ex.com/fresh": { text: LOREM, title: "fresh page" } };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      preKept: [
        {
          id: 99, // intentionally bogus — agent must re-id sequentially
          url: "https://ex.com/saved",
          title: "Saved page",
          fetchedAt: Date.now() - 86400000,
          content: "uniqueSavedTokenXYZ specific fact carried over",
        },
      ],
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 2, "preKept + 1 fresh fetched");
    // preKept comes after include[] but before search — so id=1 here
    // (no include[] in this run). Original bogus id=99 is replaced.
    assert.equal(result.sources[0].id, 1);
    assert.equal(result.sources[0].url, "https://ex.com/saved");
    assert.match(result.sources[0].content, /uniqueSavedTokenXYZ/);
    assert.equal(result.sources[1].id, 2);
    assert.equal(result.sources[1].url, "https://ex.com/fresh");
  } finally {
    await stopServer(server);
  }
});

test("agent: preKept dedupes against fresh search results (no re-fetch of saved URLs)", async () => {
  // Critical correctness property: a URL already in preKept must not
  // be re-fetched if the planner happens to surface it again. The
  // user already paid the fetch cost on the parent session.
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1][2].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  const tracker = { opened: 0, fetched: [] };
  const search = mockSearch({
    q1: [
      { url: "https://ex.com/saved", title: "Saved", snippet: "" }, // dupe
      { url: "https://ex.com/new", title: "New", snippet: "" },
    ],
  });
  const pages = {
    "https://ex.com/saved": { text: LOREM, title: "would-be re-fetch" },
    "https://ex.com/new": { text: LOREM, title: "new page" },
  };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      preKept: [
        {
          id: 1,
          url: "https://ex.com/saved",
          title: "Saved",
          fetchedAt: Date.now() - 86400000,
          content: "originalSavedContent",
        },
      ],
      browserFactory: mockBrowserFactory(pages, tracker),
    });
    assert.equal(result.sources.length, 2, "saved (preKept) + new (fetched)");
    // Saved URL must keep its ORIGINAL content (not a re-fetch).
    const saved = result.sources.find((s) => s.url === "https://ex.com/saved");
    assert.equal(saved.content, "originalSavedContent");
    // And the browser must not have touched the saved URL — the exact
    // fetched-URL list proves both that saved was skipped and that the
    // new URL was the only thing fetched.
    assert.deepEqual(tracker.fetched, ["https://ex.com/new"]);
  } finally {
    await stopServer(server);
  }
});

test("agent: routes PDF byte responses through the PDF extractor", async () => {
  const planJson = '{"queries":["q1"]}';
  const synthText = "Answer [1].";
  const { server } = makeLLMServer([planJson, synthText]);
  const baseUrl = await startServer(server);

  // Build a minimal valid PDF in-memory and feed it as the page bytes.
  const enc = new TextEncoder();
  const stream = "BT /F1 12 Tf 72 720 Td (PdfOnlyToken AbcDefGhi) Tj ET";
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Count 1/Kids[3 0 R]>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`,
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  let body = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    body += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  body += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  const pdfBytes = enc.encode(body);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/paper.pdf", title: "Paper", snippet: "" }],
  });
  const pages = {
    "https://ex.com/paper.pdf": {
      text: "",
      title: "",
      status: 200,
      bytes: pdfBytes,
      mimeType: "application/pdf",
    },
  };

  try {
    const result = await runAgent("q", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.equal(result.sources.length, 1, "PDF kept as source");
    assert.match(
      result.sources[0].content,
      /PdfOnlyToken/,
      "extracted text from the PDF reaches the synthesizer",
    );
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

// v0.11.0 — budget cap aborts a run mid-pipeline
test("agent: maxCostUsd aborts after the call that crosses the cap", async () => {
  const planJson =
    '{"reasoning":"two queries","queries":["q1","q2"]}';
  const synthText = "Final answer with [1][2].";
  // Use enough tokens that the plan + synth call BOTH bring the cost
  // above $0.001. With claude-sonnet-4-6 priced at $3/MTok input and
  // $15/MTok output, 100k in + 50k out = $0.30 + $0.75 = $1.05.
  // So setting maxCostUsd=0.5 means plan call (alone) is ~$1.05 → trips.
  const { server } = makeLLMServer(
    [planJson, synthText],
    [{ input_tokens: 100_000, output_tokens: 50_000 }, { input_tokens: 100, output_tokens: 100 }],
  );
  const baseUrl = await startServer(server);

  const search = mockSearch({ q1: [], q2: [] });
  const pages = {};

  try {
    let err;
    try {
      await runAgent("question", {
        llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
        maxCostUsd: 0.5,
        search,
        browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
        resultsPerQuery: 5,
        maxSources: 12,
        maxWordsPerSource: 2000,
        deepRounds: 0,
        concurrency: 2,
        browserFactory: mockBrowserFactory(pages),
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "agent should throw when cap is exceeded");
    assert.equal(err?.name, "BudgetExceededError");
    assert.ok(err.spentUsd > 0.5, `spentUsd should exceed cap (got ${err.spentUsd})`);
    assert.equal(err.capUsd, 0.5);
  } finally {
    await stopServer(server);
  }
});

test("agent: undefined maxCostUsd means no cap, run completes", async () => {
  // Same setup as above but no cap — should finish.
  const planJson =
    '{"reasoning":"one","queries":["q1"]}';
  const synthText = "answer [1]";
  const { server } = makeLLMServer(
    [planJson, synthText],
    [{ input_tokens: 100_000, output_tokens: 50_000 }, { input_tokens: 100, output_tokens: 100 }],
  );
  const baseUrl = await startServer(server);

  const search = mockSearch({
    q1: [{ url: "https://ex.com/a", title: "A", snippet: "..." }],
  });
  const pages = { "https://ex.com/a": { text: LOREM, title: "A" } };

  try {
    const result = await runAgent("question", {
      llm: { baseUrl, apiKey: "t", model: "claude-sonnet-4-6", maxTokens: 512 },
      // maxCostUsd: undefined  — no cap
      search,
      browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
      resultsPerQuery: 5,
      maxSources: 12,
      maxWordsPerSource: 2000,
      deepRounds: 0,
      concurrency: 2,
      browserFactory: mockBrowserFactory(pages),
    });
    assert.ok(result.cost.amountUsd > 0.5, "would have hit a cap if one was set");
    assert.match(result.markdown, /answer/);
  } finally {
    await stopServer(server);
  }
});
