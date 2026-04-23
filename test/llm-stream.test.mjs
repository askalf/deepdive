import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLLMStream, parseBlocks, parseSSE } from "../dist/llm-stream.js";
import { LLMError } from "../dist/llm.js";

// ──────── parseBlocks: SSE frame parser ────────────────────────────────────

test("parseBlocks: extracts JSON from single data: line", () => {
  const out = [...parseBlocks('event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}')];
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "content_block_delta");
  assert.equal(out[0].delta?.text, "hi");
});

test("parseBlocks: joins multiple data: lines with newline per SSE spec", () => {
  // SSE standard says multi-line data is concatenated with \n. Our parser
  // does exactly that, then JSON.parses the result. This test pins the
  // behavior for JSON payloads that happen to span two data: lines (rare
  // for Anthropic, but spec-compliant).
  const block = 'data: {"type":"message",\ndata:  "role":"assistant"}';
  const out = [...parseBlocks(block)];
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "message");
  assert.equal(out[0].role, "assistant");
});

test("parseBlocks: strips a single leading space after 'data:'", () => {
  // SSE per spec allows `data: value` OR `data:value` — leading space is
  // stripped if present, but only ONE space.
  const out = [...parseBlocks('data: {"type":"t"}')];
  assert.equal(out[0].type, "t");
});

test("parseBlocks: empty block yields nothing", () => {
  assert.deepEqual([...parseBlocks("")], []);
  assert.deepEqual([...parseBlocks("event: heartbeat")], []);
  assert.deepEqual([...parseBlocks(":comment-line")], []);
});

test("parseBlocks: [DONE] sentinel yields nothing (OpenAI-style streams)", () => {
  assert.deepEqual([...parseBlocks("data: [DONE]")], []);
});

test("parseBlocks: malformed JSON is silently dropped (not thrown)", () => {
  assert.deepEqual([...parseBlocks("data: not valid json")], []);
});

// ──────── parseSSE: stream reader ──────────────────────────────────────────

function streamOf(parts) {
  const encoder = new TextEncoder();
  const queue = parts.map((p) => encoder.encode(p));
  return new ReadableStream({
    start(controller) {
      for (const chunk of queue) controller.enqueue(chunk);
      controller.close();
    },
  });
}

test("parseSSE: yields events from multi-frame stream", async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start"}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hello"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const events = [];
  for await (const e of parseSSE(streamOf(frames))) events.push(e);
  assert.equal(events.length, 4);
  assert.equal(events[1].delta.text, "Hello");
  assert.equal(events[2].delta.text, " world");
});

test("parseSSE: handles frames split across chunk boundaries", async () => {
  // Split a single frame in the middle of the JSON payload.
  const half1 = 'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"te';
  const half2 = 'xt_delta","text":"split"}}\n\n';
  const events = [];
  for await (const e of parseSSE(streamOf([half1, half2]))) events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta.text, "split");
});

test("parseSSE: yields a trailing event with no final blank line on stream end", async () => {
  const events = [];
  for await (const e of parseSSE(streamOf(['data: {"type":"x"}']))) events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "x");
});

test("parseSSE: accepts CRLF line endings", async () => {
  const frame = 'event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"x"}}\r\n\r\n';
  const events = [];
  for await (const e of parseSSE(streamOf([frame]))) events.push(e);
  assert.equal(events.length, 1);
  assert.equal(events[0].delta.text, "x");
});

// ──────── callLLMStream: integration ───────────────────────────────────────

function makeSSEResponder(frames) {
  return (_req, res) => {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    for (const f of frames) res.write(f);
    res.end();
  };
}

function start(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("callLLMStream: delivers tokens in order, aggregates full text", async () => {
  const frames = [
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"world"}}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ];
  const server = http.createServer(makeSSEResponder(frames));
  const baseUrl = await start(server);
  const tokens = [];
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 5_000 },
      { onToken: (t) => tokens.push(t) },
    );
    assert.deepEqual(tokens, ["Hel", "lo ", "world"]);
    assert.equal(result.text, "Hello world");
    assert.equal(result.usage?.input_tokens, 5);
    assert.equal(result.usage?.output_tokens, 3);
  } finally {
    await stop(server);
  }
});

test("callLLMStream: initial 500 retries and succeeds", async () => {
  let calls = 0;
  const frames = [
    'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}\n\n',
  ];
  const server = http.createServer((req, res) => {
    calls++;
    if (calls === 1) {
      res.writeHead(500);
      res.end("flake");
      return;
    }
    makeSSEResponder(frames)(req, res);
  });
  const baseUrl = await start(server);
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 5_000, maxAttempts: 3 },
    );
    assert.equal(result.text, "ok");
    assert.equal(calls, 2);
  } finally {
    await stop(server);
  }
});

test("callLLMStream: 401 does NOT retry", async () => {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(401);
    res.end("unauth");
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLMStream(
        [{ role: "user", content: "hi" }],
        "sys",
        { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 5_000, maxAttempts: 5 },
      ),
      (err) => err instanceof LLMError && err.status === 401,
    );
    assert.equal(calls, 1);
  } finally {
    await stop(server);
  }
});

test("callLLMStream: non-text_delta events are ignored gracefully", async () => {
  const frames = [
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"a"}}\n\n',
    // A tool-use delta variant — not text, should be skipped by the streaming synthesizer.
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"input_json_delta","partial_json":"{}"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"b"}}\n\n',
  ];
  const server = http.createServer(makeSSEResponder(frames));
  const baseUrl = await start(server);
  const tokens = [];
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 5_000 },
      { onToken: (t) => tokens.push(t) },
    );
    assert.deepEqual(tokens, ["a", "b"]);
    assert.equal(result.text, "ab");
  } finally {
    await stop(server);
  }
});
