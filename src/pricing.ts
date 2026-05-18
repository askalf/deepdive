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
//
// PRICE_TABLE_VERIFIED_AT records when the table was last spot-checked.
// `deepdive doctor` warns when the table is more than ~90 days stale,
// keeping the maintainer honest about audit cadence — drift is intentional
// (a PR is the right way to update prices), but undeclared drift is not.
export const PRICE_TABLE: Record<string, ModelPrice> = {
  "claude-sonnet-4-6": { inputPerMTok: 3, outputPerMTok: 15 },
  "claude-opus-4-7": { inputPerMTok: 15, outputPerMTok: 75 },
  "claude-haiku-4-5": { inputPerMTok: 0.8, outputPerMTok: 4 },
};

export const PRICE_TABLE_VERIFIED_AT = "2026-05-05";

// Threshold in days at which doctor flips the pricing check from "ok"
// to "warn". Exposed so tests can override.
export const PRICE_TABLE_STALE_AFTER_DAYS = 90;

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

/**
 * Multi-model cost estimate (v0.10.0).
 *
 * Sums `estimateCost` across a per-model usage map — used when the run
 * spread requests across models (per-stage model overrides). The aggregate
 * `amountUsd` is the sum of priced costs. `knownModel` is true only when
 * **every** model with non-zero usage is priced (known table entry or
 * env-var override). Unknown models contribute $0 (same as the single-
 * model case) and flip `knownModel` to false; the CLI renders `$?` in
 * that situation rather than understating the bill.
 *
 * `byModel` retains the per-model breakdown so the CLI can render a
 * multi-line cost summary when more than one model was used.
 */
export interface MultiModelCostEstimate extends CostEstimate {
  byModel: Array<{ model: string; estimate: CostEstimate }>;
}

export function estimateCostMultiModel(
  usageByModel: Record<string, TokenUsage & { calls: number }>,
  env?: Record<string, string | undefined>,
): MultiModelCostEstimate {
  const byModel: Array<{ model: string; estimate: CostEstimate }> = [];
  let totalAmount = 0;
  let totalIn = 0;
  let totalOut = 0;
  let totalCalls = 0;
  let allKnown = true;

  // Stable ordering by model name keeps the rendered cost summary
  // deterministic across runs.
  for (const model of Object.keys(usageByModel).sort()) {
    const usage = usageByModel[model];
    if (!usage || (usage.inputTokens === 0 && usage.outputTokens === 0 && usage.calls === 0)) continue;
    const est = estimateCost(usage, model, env);
    byModel.push({ model, estimate: est });
    totalAmount += est.amountUsd;
    totalIn += est.inputTokens;
    totalOut += est.outputTokens;
    totalCalls += est.calls;
    if (!est.knownModel) allKnown = false;
  }

  return {
    amountUsd: totalAmount,
    knownModel: allKnown && byModel.length > 0,
    inputTokens: totalIn,
    outputTokens: totalOut,
    calls: totalCalls,
    byModel,
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

// Whole-day delta between an ISO date string ("YYYY-MM-DD") and `now`.
// Returns NaN for malformed input. Exported for tests.
export function daysAgo(isoDate: string, now: number = Date.now()): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return NaN;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (!Number.isFinite(t)) return NaN;
  return Math.floor((now - t) / 86_400_000);
}

function parseDollars(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const trimmed = s.trim();
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < 0) return undefined;
  return n;
}
