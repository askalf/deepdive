// Cost telemetry — pure pricing math + a small registry of public list
// prices for well-known Anthropic models.
//
// Every LLM call in deepdive returns input/output token counts. We sum
// those across a run and turn them into an estimated dollar cost so the
// end-of-run summary shows what the same workload would have cost at API
// list prices — the cost-arbitrage angle the README leans on.
//
// This module is pure: no LLM, no network, no disk. Pricing constants
// live here as a hardcoded table. Drift is intentional: a PR is the right
// way to update prices, because that's also when we audit them. Users
// running unknown models can override via env vars.

export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CostEstimate {
  amountUsd: number;
  knownModel: boolean;
  inputTokens: number;
  outputTokens: number;
  calls: number;
}

// Anthropic public list pricing as of release. Verify against
// docs.anthropic.com/en/docs/about-claude/pricing before bumping.
export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4 },
};

// dario's default listening port — auto-detected to print the
// "$0 on Claude Max via dario" hint without claiming it for unrelated
// endpoints.
export const DARIO_DEFAULT_BASE_URL = "http://localhost:3456";

// Returns the price for `model`, or — if unknown — falls back to a pair
// of env-var overrides for self-hosted / unknown-named endpoints. Returns
// undefined when neither is available.
export function priceFor(
  model: string,
  env?: Record<string, string | undefined>,
): ModelPrice | undefined {
  const known = PRICE_TABLE[model];
  if (known) return known;
  if (!env) return undefined;
  const inputStr = env.DEEPDIVE_PRICE_INPUT_PER_MTOK;
  const outputStr = env.DEEPDIVE_PRICE_OUTPUT_PER_MTOK;
  const input = parseDollars(inputStr);
  const output = parseDollars(outputStr);
  if (input === undefined || output === undefined) return undefined;
  return { inputPerMTok: input, outputPerMTok: output };
}

export function estimateCost(
  usage: TokenUsage & { calls: number },
  model: string,
  env?: Record<string, string | undefined>,
): CostEstimate {
  const price = priceFor(model, env);
  if (!price) {
    return {
      amountUsd: 0,
      knownModel: false,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      calls: usage.calls,
    };
  }
  const amountUsd =
    (usage.inputTokens * price.inputPerMTok) / 1_000_000 +
    (usage.outputTokens * price.outputPerMTok) / 1_000_000;
  return {
    amountUsd,
    knownModel: model in PRICE_TABLE,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    calls: usage.calls,
  };
}

// Renders the one-line cost summary for the CLI. Two flavors:
//   ~$0.034 · 12.1k in / 4.2k out · 4 LLM calls · claude-sonnet-4-6
//   $? · 12.1k in / 4.2k out · 4 LLM calls · my-self-hosted
//   $0.000 · 0 in / 0 out · 0 LLM calls · claude-sonnet-4-6
// Caller appends the dario hint separately when relevant.
export function formatCostLine(estimate: CostEstimate, model: string): string {
  const cost = estimate.knownModel || estimate.amountUsd > 0
    ? "~" + formatUsd(estimate.amountUsd)
    : "$?";
  const inK = formatTokens(estimate.inputTokens);
  const outK = formatTokens(estimate.outputTokens);
  const callsLabel = estimate.calls === 1 ? "1 LLM call" : `${estimate.calls} LLM calls`;
  return `${cost} · ${inK} in / ${outK} out · ${callsLabel} · ${model}`;
}

// True when `baseUrl` points at the dario default. Used by the CLI to
// decide whether the "$0 on Claude Max via dario" hint is relevant.
export function looksLikeDario(baseUrl: string): boolean {
  return trim(baseUrl) === DARIO_DEFAULT_BASE_URL;
}

function trim(s: string): string {
  let end = s.length;
  while (end > 0 && s[end - 1] === "/") end--;
  return s.slice(0, end);
}

// Exported for tests.
export function formatUsd(amount: number): string {
  if (amount === 0) return "$0.000";
  if (amount < 0.01) return "$" + amount.toFixed(4);
  if (amount < 1) return "$" + amount.toFixed(3);
  return "$" + amount.toFixed(2);
}

// Exported for tests.
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return (n / 1000).toFixed(2) + "k";
  if (n < 1_000_000) return (n / 1000).toFixed(1) + "k";
  return (n / 1_000_000).toFixed(2) + "M";
}

function parseDollars(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
