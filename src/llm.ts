// Minimal Anthropic Messages-compatible client.
// Default target is dario at http://localhost:3456, but any Anthropic-compat
// endpoint works. The only header dario cares about is Authorization / x-api-key.

export interface LLMConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
}

export interface LLMMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LLMResult {
  text: string;
  usage?: { input_tokens: number; output_tokens: number };
}

export async function callLLM(
  messages: LLMMessage[],
  system: string,
  config: LLMConfig,
  signal?: AbortSignal,
): Promise<LLMResult> {
  const url = `${config.baseUrl.replace(/\/+$/, "")}/v1/messages`;
  const body = {
    model: config.model,
    max_tokens: config.maxTokens,
    system,
    messages,
  };

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "anthropic-version": "2023-06-01",
      "x-api-key": config.apiKey,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LLM ${res.status} ${res.statusText}: ${detail.slice(0, 500)}`);
  }

  const json = (await res.json()) as {
    content: { type: string; text?: string }[];
    usage?: { input_tokens: number; output_tokens: number };
  };

  const text = json.content
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text!)
    .join("");

  return { text, usage: json.usage };
}
