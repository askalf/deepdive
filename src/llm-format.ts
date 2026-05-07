// API format adapters — translate between the Anthropic Messages shape
// (deepdive's canonical wire format) and the OpenAI Chat Completions
// shape exposed by OpenAI itself, vLLM, Ollama, LiteLLM in OpenAI mode,
// and many other tools.
//
// deepdive's pipeline is built around the Anthropic shape because that's
// dario's native protocol. To talk to an OpenAI-compat endpoint we
// re-wrap the request before sending and re-shape the response on the
// way back. Streaming gets the same treatment via parseSSE adapters.
//
// This module is pure: no network. Tested in isolation.

import type { LLMMessage } from "./llm.js";

export type ApiFormat = "anthropic" | "openai";

export interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system: string;
  messages: LLMMessage[];
  stream?: boolean;
}

export interface OpenAIRequestBody {
  model: string;
  max_tokens: number;
  messages: { role: "system" | "user" | "assistant"; content: string }[];
  stream?: boolean;
}

export interface AnthropicResponseShape {
  content: { type: string; text?: string }[];
  usage?: { input_tokens: number; output_tokens: number };
}

export interface OpenAIResponseShape {
  choices: { message?: { content?: string }; delta?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

// Auto-detect from base URL. Honors known patterns; defaults to anthropic.
// Exported for unit tests.
//
// We parse the URL properly and inspect the hostname / port rather than
// substring-matching the raw string. CodeQL flagged the substring form
// as an incomplete-URL-sanitization risk: a string like
// "http://evil.example/?api.openai.com" would have matched.
export function detectApiFormat(baseUrl: string): ApiFormat {
  let host: string;
  let port: string;
  try {
    const u = new URL(baseUrl);
    host = u.hostname.toLowerCase();
    port = u.port;
  } catch {
    return "anthropic";
  }
  // OpenAI's official API — exact host or any subdomain of openai.com.
  if (host === "api.openai.com" || host.endsWith(".openai.com")) {
    return "openai";
  }
  // Ollama default — exposes OpenAI-compat at /v1.
  if (port === "11434") return "openai";
  // Common vLLM port.
  if (port === "8000") return "openai";
  // LiteLLM proxies — convention is :4000 in their docs but it's not
  // dispositive. Default to anthropic to avoid false positives; users
  // can pass --api-format=openai explicitly.
  return "anthropic";
}

// Translate an Anthropic Messages request body into an OpenAI Chat
// Completions request body. The system prompt becomes the first message
// with role=system. Empty system prompts are dropped.
export function toOpenAIRequest(body: AnthropicRequestBody): OpenAIRequestBody {
  const messages: OpenAIRequestBody["messages"] = [];
  if (body.system && body.system.trim().length > 0) {
    messages.push({ role: "system", content: body.system });
  }
  for (const m of body.messages) {
    messages.push({ role: m.role, content: m.content });
  }
  const out: OpenAIRequestBody = {
    model: body.model,
    max_tokens: body.max_tokens,
    messages,
  };
  if (body.stream) out.stream = true;
  return out;
}

// Translate an OpenAI Chat Completions response into the Anthropic
// shape deepdive uses internally (just `content[].text` and `usage`).
export function fromOpenAIResponse(json: OpenAIResponseShape): AnthropicResponseShape {
  const text = (json.choices ?? [])
    .map((c) => c.message?.content ?? c.delta?.content ?? "")
    .join("");
  const u = json.usage ?? {};
  const input = u.prompt_tokens ?? u.input_tokens ?? 0;
  const output = u.completion_tokens ?? u.output_tokens ?? 0;
  return {
    content: [{ type: "text", text }],
    usage: { input_tokens: input, output_tokens: output },
  };
}

// Headers required to authenticate against each format. For OpenAI: a
// Bearer token. For Anthropic: an x-api-key + version pin.
export function authHeadersFor(
  format: ApiFormat,
  apiKey: string,
): Record<string, string> {
  if (format === "openai") {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    };
  }
  return {
    "content-type": "application/json",
    "anthropic-version": "2023-06-01",
    "x-api-key": apiKey,
  };
}

// The HTTP path each format expects. Both are stable industry conventions.
export function pathFor(format: ApiFormat): string {
  return format === "openai" ? "/v1/chat/completions" : "/v1/messages";
}

// Translate one streaming-event JSON payload from OpenAI's SSE shape
// into the Anthropic SSE event shape that callLLMStream's parser
// already understands. Only `choices[].delta.content` and final `usage`
// are translated; everything else passes through as a no-op event.
//
// The Anthropic stream uses these event types:
//  - message_start { message: { usage } }
//  - content_block_delta { delta: { type: "text_delta", text } }
//  - message_delta { usage: { input_tokens, output_tokens } }
export function openaiSSEToAnthropic(
  json: OpenAIStreamEvent,
): AnthropicSSEEvent | null {
  if (typeof json !== "object" || json === null) return null;
  const choice = (json.choices ?? [])[0];
  const text = choice?.delta?.content;
  if (typeof text === "string" && text.length > 0) {
    return {
      type: "content_block_delta",
      delta: { type: "text_delta", text },
    };
  }
  if (json.usage) {
    return {
      type: "message_delta",
      usage: {
        input_tokens:
          json.usage.prompt_tokens ?? json.usage.input_tokens ?? 0,
        output_tokens:
          json.usage.completion_tokens ?? json.usage.output_tokens ?? 0,
      },
    };
  }
  return null;
}

export interface OpenAIStreamEvent {
  choices?: { delta?: { content?: string } }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export interface AnthropicSSEEvent {
  type: string;
  delta?: { type?: string; text?: string };
  usage?: { input_tokens?: number; output_tokens?: number };
  message?: { usage?: { input_tokens?: number; output_tokens?: number } };
}
