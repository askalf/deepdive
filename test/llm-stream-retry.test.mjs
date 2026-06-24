import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { callLLMStream } from "../dist/llm-stream.js";

// Regression tests for #104: an intermittent upstream stall on the synthesis
// stream used to fast-fail the whole run (the streaming client retried only
// the initial connect). callLLMStream now wraps the whole connect+stream in
// retry, gated on whether any token has reached the user — so a stall recovers
// transparently in buffered mode and before the first visible token, while a
// healthy long generation is never aborted by the connect clock.

function start(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    );
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

function frame(text) {
  return `data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"${text}"}}\n\n`;
}

// ──────── buffered mode (the --json / non-TTY factual-lookup path) ──────────

test("callLLMStream: a buffered-mode stall retries and succeeds (#104)", async () => {
  // Attempt 1 emits a partial frame then hangs (the intermittent upstream
  // stall). With no onToken sink nothing reached a user, so the idle-deadline
  // TimeoutError is retriable. Attempt 2 streams a full answer and closes.
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      res.write(frame("partial-"));
      // hang: no end() → the stream stalls after the first frame.
      return;
    }
    res.write(frame("full-answer"));
    res.end();
  });
  const baseUrl = await start(server);
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 150, maxAttempts: 3 },
      // buffered: no onToken
    );
    assert.equal(calls, 2, "should have retried the stalled stream once");
    // Fresh buffer per attempt — the retry must NOT prepend attempt 1's
    // partial text.
    assert.equal(result.text, "full-answer");
  } finally {
    await stop(server);
  }
});

test("callLLMStream: buffered stall exhausts attempts then surfaces the TimeoutError", async () => {
  // Every attempt stalls — the run still fails (loud), just after the bounded
  // retries rather than on the first stall.
  let calls = 0;
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame("x"));
    // always hang
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLMStream(
        [{ role: "user", content: "hi" }],
        "sys",
        { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 80, maxAttempts: 3 },
      ),
      (err) => err?.name === "TimeoutError",
    );
    assert.equal(calls, 3, "should exhaust all attempts on a persistent stall");
  } finally {
    await stop(server);
  }
});

// ──────── interactive mode: gate is the first VISIBLE token ─────────────────

test("callLLMStream: a stall BEFORE the first token retries even with onToken (#104)", async () => {
  // Attempt 1 sends headers then stalls without ever emitting a token, so the
  // user has seen nothing — the gate (emittedToUser) is still false and the
  // stall is retriable. Attempt 2 streams normally.
  let calls = 0;
  const tokens = [];
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (calls === 1) {
      // headers only, then hang — no content frame.
      return;
    }
    res.write(frame("ok"));
    res.end();
  });
  const baseUrl = await start(server);
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 150, maxAttempts: 3 },
      { onToken: (t) => tokens.push(t) },
    );
    assert.equal(calls, 2, "pre-first-token stall should retry");
    assert.equal(result.text, "ok");
    assert.deepEqual(tokens, ["ok"], "only the successful attempt's token is surfaced");
  } finally {
    await stop(server);
  }
});

test("callLLMStream: a stall AFTER the first visible token does NOT retry", async () => {
  // Once a token has streamed to the user, re-issuing would duplicate visible
  // output — so the stall surfaces instead of retrying. (Mirrors the existing
  // mid-stream-stall test; kept here so the retry gate's two sides sit side by
  // side.)
  let calls = 0;
  const tokens = [];
  const server = http.createServer((_req, res) => {
    calls++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame("tok"));
    // hang after the first token.
  });
  const baseUrl = await start(server);
  try {
    await assert.rejects(
      callLLMStream(
        [{ role: "user", content: "hi" }],
        "sys",
        { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs: 150, maxAttempts: 3 },
        { onToken: (t) => tokens.push(t) },
      ),
      (err) => err?.name === "TimeoutError",
    );
    assert.deepEqual(tokens, ["tok"]);
    assert.equal(calls, 1, "no retry once a token is visible");
  } finally {
    await stop(server);
  }
});

// ──────── the connect clock must not abort a healthy long generation ────────

test("callLLMStream: a healthy generation longer than timeoutMs is not aborted (#104)", async () => {
  // Frames arrive with gaps shorter than the idle deadline, but the total
  // generation runs past timeoutMs. The connect timer is cleared once headers
  // land, so only the (never-tripped) idle deadline governs the body — the
  // stream completes. Under the pre-#104 connect-signal coupling this aborted
  // mid-body at timeoutMs.
  const timeoutMs = 300;
  const gap = 120; // < timeoutMs, so the idle deadline never fires
  const parts = ["a", "b", "c", "d"]; // last frame lands at ~360ms > timeoutMs
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(frame(parts[0]));
    let i = 1;
    const tick = () => {
      if (i < parts.length) {
        res.write(frame(parts[i++]));
        setTimeout(tick, gap);
      } else {
        res.end();
      }
    };
    setTimeout(tick, gap);
  });
  const baseUrl = await start(server);
  try {
    const result = await callLLMStream(
      [{ role: "user", content: "hi" }],
      "sys",
      { baseUrl, apiKey: "t", model: "test", maxTokens: 10, timeoutMs, maxAttempts: 1 },
    );
    assert.equal(result.text, "abcd", "the long-but-healthy stream finished in one pass");
  } finally {
    await stop(server);
  }
});
