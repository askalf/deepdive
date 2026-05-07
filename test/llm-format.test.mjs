// LLM format adapter — tests for Anthropic ↔ OpenAI translation.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  detectApiFormat,
  toOpenAIRequest,
  fromOpenAIResponse,
  openaiSSEToAnthropic,
  authHeadersFor,
  pathFor,
} from "../dist/llm-format.js";

// ── detectApiFormat ─────────────────────────────────────────────────────────

test("detectApiFormat: defaults to anthropic for dario / unknown URLs", () => {
  assert.equal(detectApiFormat("http://localhost:3456"), "anthropic");
  assert.equal(detectApiFormat("https://my-router.example.com"), "anthropic");
});

test("detectApiFormat: openai.com → openai", () => {
  assert.equal(detectApiFormat("https://api.openai.com"), "openai");
  assert.equal(detectApiFormat("https://api.openai.com/v1"), "openai");
});

test("detectApiFormat: Ollama default port 11434 → openai", () => {
  assert.equal(detectApiFormat("http://localhost:11434"), "openai");
  assert.equal(detectApiFormat("http://127.0.0.1:11434/v1"), "openai");
});

test("detectApiFormat: vLLM-conventional :8000 → openai", () => {
  assert.equal(detectApiFormat("http://localhost:8000"), "openai");
});

test("detectApiFormat: rejects URL spoofing api.openai.com in path/query", () => {
  // CodeQL caught the substring form: a URL like
  // http://evil.example/?api.openai.com would have matched. Hostname
  // parsing is the right defense.
  assert.equal(
    detectApiFormat("http://evil.example/?api.openai.com"),
    "anthropic",
  );
  assert.equal(
    detectApiFormat("https://evil.example/api.openai.com/v1"),
    "anthropic",
  );
});

test("detectApiFormat: malformed URL → anthropic (default)", () => {
  assert.equal(detectApiFormat("not a url"), "anthropic");
});

test("detectApiFormat: openai.com subdomains other than api → openai", () => {
  // A user pointing at a custom subdomain of openai.com (e.g. an
  // azure-fronted endpoint that resolves to oai-eus.openai.com) should
  // still be detected as openai-format.
  assert.equal(detectApiFormat("https://oai-eus.openai.com/v1"), "openai");
});

// ── toOpenAIRequest ─────────────────────────────────────────────────────────

test("toOpenAIRequest: prepends system as a role=system message", () => {
  const out = toOpenAIRequest({
    model: "gpt-4",
    max_tokens: 100,
    system: "you are a helpful assistant",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(out.model, "gpt-4");
  assert.equal(out.max_tokens, 100);
  assert.deepEqual(out.messages, [
    { role: "system", content: "you are a helpful assistant" },
    { role: "user", content: "hi" },
  ]);
});

test("toOpenAIRequest: drops empty system prompt", () => {
  const out = toOpenAIRequest({
    model: "gpt-4",
    max_tokens: 100,
    system: "",
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(out.messages, [{ role: "user", content: "hi" }]);
});

test("toOpenAIRequest: passes stream through", () => {
  const out = toOpenAIRequest({
    model: "x",
    max_tokens: 1,
    system: "",
    messages: [{ role: "user", content: "x" }],
    stream: true,
  });
  assert.equal(out.stream, true);
});

// ── fromOpenAIResponse ──────────────────────────────────────────────────────

test("fromOpenAIResponse: extracts text and translates usage", () => {
  const out = fromOpenAIResponse({
    choices: [{ message: { content: "hello world" } }],
    usage: { prompt_tokens: 12, completion_tokens: 7 },
  });
  assert.deepEqual(out, {
    content: [{ type: "text", text: "hello world" }],
    usage: { input_tokens: 12, output_tokens: 7 },
  });
});

test("fromOpenAIResponse: tolerates missing usage", () => {
  const out = fromOpenAIResponse({
    choices: [{ message: { content: "x" } }],
  });
  assert.deepEqual(out.usage, { input_tokens: 0, output_tokens: 0 });
});

test("fromOpenAIResponse: concatenates multiple choices' content", () => {
  // Some endpoints (Ollama in chat-mode) return fragmented choices.
  const out = fromOpenAIResponse({
    choices: [
      { message: { content: "part1 " } },
      { message: { content: "part2" } },
    ],
  });
  assert.equal(out.content[0].text, "part1 part2");
});

// ── openaiSSEToAnthropic ────────────────────────────────────────────────────

test("openaiSSEToAnthropic: text delta → content_block_delta", () => {
  const out = openaiSSEToAnthropic({
    choices: [{ delta: { content: "Hello" } }],
  });
  assert.deepEqual(out, {
    type: "content_block_delta",
    delta: { type: "text_delta", text: "Hello" },
  });
});

test("openaiSSEToAnthropic: usage frame → message_delta", () => {
  const out = openaiSSEToAnthropic({
    choices: [],
    usage: { prompt_tokens: 5, completion_tokens: 9 },
  });
  assert.deepEqual(out, {
    type: "message_delta",
    usage: { input_tokens: 5, output_tokens: 9 },
  });
});

test("openaiSSEToAnthropic: empty / role-only frames return null", () => {
  assert.equal(openaiSSEToAnthropic({ choices: [{ delta: {} }] }), null);
  assert.equal(openaiSSEToAnthropic({}), null);
});

// ── headers + path ──────────────────────────────────────────────────────────

test("authHeadersFor: openai → Bearer; anthropic → x-api-key + version", () => {
  const oa = authHeadersFor("openai", "sk-abc");
  assert.equal(oa.authorization, "Bearer sk-abc");
  assert.equal(oa["x-api-key"], undefined);
  const an = authHeadersFor("anthropic", "key");
  assert.equal(an["x-api-key"], "key");
  assert.equal(an["anthropic-version"], "2023-06-01");
  assert.equal(an.authorization, undefined);
});

test("pathFor: openai uses /v1/chat/completions; anthropic uses /v1/messages", () => {
  assert.equal(pathFor("openai"), "/v1/chat/completions");
  assert.equal(pathFor("anthropic"), "/v1/messages");
});
