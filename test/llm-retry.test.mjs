import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLLM, LLMError } from "../dist/llm.js";

function makeServer(responder) {
  const server = http.createServer(responder);
  return server;
}

function start(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

function okPayload() {
  return JSON.stringify({
    id: "m",
    type: "message",
    role: "assistant",
    model: "test",
    content: [{ type: "text", text: "hi" }],
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

test("LLMError: retriable for 429 + 5xx, not for 4xx", () => {
  assert.equal(new LLMError(500, "x").retriable, true);
  assert.equal(new LLMError(502, "x").retriable, true);
  assert.equal(new LLMError(599, "x").retriable, true);
  assert.equal(new LLMError(429, "x").retriable, true);
  assert.equal(new LLMError(400, "x").retriable, false);
  assert.equal(new LLMError(401, "x").retriable, false);
  assert.equal(new LLMError(403, "x").retriable, false);
  assert.equal(new LLMError(404, "x").retriable, false);
});

test("callLLM: succeeds on first try", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(okPayload());
  });
  const baseUrl = await start(server);
  try {
    const out = await callLLM(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 1, timeoutMs: 5_000 },
    );
    assert.equal(out.text, "hi");
    assert.equal(calls, 1);
  } finally {
    await stop(server);
  }
});

test("callLLM: retries on 500 and eventually succeeds", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    if (calls < 3) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("upstream flake");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(okPayload());
  });
  const baseUrl = await start(server);
  try {
    const out = await callLLM(
      [{ role: "user", content: "hi" }],
      "sys",
      {
        baseUrl,
        apiKey: "t",
        model: "test",
        maxTokens: 1,
        timeoutMs: 5_000,
        maxAttempts: 5,
      },
    );
    assert.equal(out.text, "hi");
    assert.equal(calls, 3);
  } finally {
    await stop(server);
  }
});

test("callLLM: retries on 429", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    if (calls < 2) {
      res.writeHead(429, { "content-type": "text/plain" });
      res.end("too many requests");
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(okPayload());
  });
  const baseUrl = await start(server);
  try {
    await callLLM(
      [{ role: "user", content: "hi" }],
      "sys",
      {
        baseUrl,
        apiKey: "t",
        model: "test",
        maxTokens: 1,
        timeoutMs: 5_000,
        maxAttempts: 3,
      },
    );
    assert.equal(calls, 2);
  } finally {
    await stop(server);
  }
});

test("callLLM: does NOT retry on 400", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    res.writeHead(400, { "content-type": "text/plain" });
    res.end("malformed request");
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLM(
        [{ role: "user", content: "hi" }],
        "sys",
        {
          baseUrl,
          apiKey: "t",
          model: "test",
          maxTokens: 1,
          timeoutMs: 5_000,
          maxAttempts: 5,
        },
      ),
      (err) => err instanceof LLMError && err.status === 400,
    );
    assert.equal(calls, 1, "4xx should not retry");
  } finally {
    await stop(server);
  }
});

test("callLLM: does NOT retry on 401 (bad API key)", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    res.writeHead(401, { "content-type": "text/plain" });
    res.end("unauthenticated");
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLM(
        [{ role: "user", content: "hi" }],
        "sys",
        {
          baseUrl,
          apiKey: "t",
          model: "test",
          maxTokens: 1,
          timeoutMs: 5_000,
          maxAttempts: 5,
        },
      ),
      (err) => err instanceof LLMError && err.status === 401,
    );
    assert.equal(calls, 1, "401 should not retry");
  } finally {
    await stop(server);
  }
});

test("callLLM: throws LLMError after maxAttempts of 5xx", async () => {
  let calls = 0;
  const server = makeServer((_req, res) => {
    calls++;
    res.writeHead(503, { "content-type": "text/plain" });
    res.end("permanently sad");
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLM(
        [{ role: "user", content: "hi" }],
        "sys",
        {
          baseUrl,
          apiKey: "t",
          model: "test",
          maxTokens: 1,
          timeoutMs: 5_000,
          maxAttempts: 3,
        },
      ),
      (err) => err instanceof LLMError && err.status === 503,
    );
    assert.equal(calls, 3, "should exhaust attempts");
  } finally {
    await stop(server);
  }
});

test("callLLM: per-call timeout fires on hung server", async () => {
  // Server never responds. timeoutMs should kick in.
  const server = makeServer((_req, _res) => {
    // hang
  });
  const baseUrl = await start(server);
  try {
    const p = callLLM(
      [{ role: "user", content: "hi" }],
      "sys",
      {
        baseUrl,
        apiKey: "t",
        model: "test",
        maxTokens: 1,
        timeoutMs: 200, // very short
        maxAttempts: 1, // one attempt so test finishes quickly
      },
    );
    await assert.rejects(p);
  } finally {
    await stop(server);
  }
});

test("callLLM: user signal short-circuits retry loop", async () => {
  let calls = 0;
  const ac = new AbortController();
  const server = makeServer((_req, res) => {
    calls++;
    // fail once, then abort
    if (calls === 1) ac.abort();
    res.writeHead(500);
    res.end();
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLM(
        [{ role: "user", content: "hi" }],
        "sys",
        {
          baseUrl,
          apiKey: "t",
          model: "test",
          maxTokens: 1,
          timeoutMs: 5_000,
          maxAttempts: 5,
        },
        ac.signal,
      ),
    );
    // user-triggered abort should stop retries fast.
    assert.ok(calls < 3, `expected fewer than 3 calls, got ${calls}`);
  } finally {
    await stop(server);
  }
});
