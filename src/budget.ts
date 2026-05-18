// Budget cap (v0.11.0).
//
// The agent emits an `llm.call` event after every LLM call completes. We
// tally per-model cost from those tokens (already in pricing.ts as
// `estimateCostMultiModel`); the budget cap layer sits on top: after each
// call, the agent asks `enforceBudget(currentCost, cap)`, which throws a
// `BudgetExceededError` when the accumulated spend has crossed the cap.
//
// Semantics — the check fires AFTER each call, not before. So the cap
// is a guarantee about "we will not start a NEXT call that would push us
// past X" — not "we will not exceed X by a single token." A synth call
// that runs long is still allowed to complete; the run aborts before the
// next critique or next round's plan. This matches the precedent of
// dario's overage-guard: detect on the response, halt before the next
// request. Tradeoff: we slightly over-spend on a single hot call rather
// than try to predict token-cost mid-stream (which is impossible without
// streaming usage callbacks that don't exist on all wire formats).
//
// Unknown models — when any model in the run isn't priced (no PRICE_TABLE
// entry AND no DEEPDIVE_PRICE_*_PER_MTOK env override), the cost
// estimator returns $0 for that model. The cap STILL enforces against
// the priced subset, but the user sees a one-line warning in the abort
// message: "cap enforcement may be incomplete — N call(s) on unpriced
// models contributed $0 to the running total." That's the honest signal.
//
// Pure: no I/O, no LLM, no network. Testable without a browser or LLM.

import type { MultiModelCostEstimate } from "./pricing.js";

/**
 * Parse a `--max-cost` flag value or DEEPDIVE_MAX_COST env var into a
 * dollar number. Accepts:
 *   - "$0.50"   →  0.50
 *   - "0.50"    →  0.50
 *   - "$5"      →  5
 *   - "5"       →  5
 *   - ".25"     →  0.25
 *
 * Rejects: negative, non-numeric, scientific notation, currency suffixes
 * other than leading "$". Returns undefined for invalid input — callers
 * decide whether that's a hard error (CLI) or just "no cap" (env).
 */
export function parseMaxCost(raw: string | undefined): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (trimmed === "") return undefined;
  // Strip a single optional leading "$".
  const stripped = trimmed.startsWith("$") ? trimmed.slice(1) : trimmed;
  // Allow "5", "5.5", ".5". Disallow scientific, negatives, trailing junk.
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(stripped)) return undefined;
  const n = Number(stripped);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

/**
 * Format a cost cap for inclusion in a user-visible error / log.
 *   formatMaxCost(0.5)   → "$0.500"
 *   formatMaxCost(5)     → "$5.00"
 *   formatMaxCost(0.001) → "$0.0010"
 */
export function formatMaxCost(amount: number): string {
  if (amount === 0) return "$0.000";
  if (amount < 0.01) return "$" + amount.toFixed(4);
  if (amount < 1) return "$" + amount.toFixed(3);
  return "$" + amount.toFixed(2);
}

/**
 * Thrown by `enforceBudget` when the running cost has crossed the cap.
 * The agent's outer try/catch surfaces this with a clear stderr message
 * and a distinct exit code, so wrapping scripts can branch on "we hit
 * the cap" vs "actual error".
 *
 * Carries: `spentUsd` (running aggregate at the moment of detection),
 * `capUsd` (the cap the run was started with), and `unpricedCalls` (calls
 * that contributed $0 because their model wasn't priced — surfaced so
 * the user knows the cap was enforced against the priced subset only).
 */
export class BudgetExceededError extends Error {
  readonly spentUsd: number;
  readonly capUsd: number;
  readonly unpricedCalls: number;
  constructor(spentUsd: number, capUsd: number, unpricedCalls: number) {
    const msg = unpricedCalls > 0
      ? `budget cap exceeded: spent ${formatMaxCost(spentUsd)} of ${formatMaxCost(capUsd)} (${unpricedCalls} call(s) on unpriced models contributed \$0 to the running total — cap enforcement is incomplete)`
      : `budget cap exceeded: spent ${formatMaxCost(spentUsd)} of ${formatMaxCost(capUsd)}`;
    super(msg);
    this.name = "BudgetExceededError";
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
    this.unpricedCalls = unpricedCalls;
  }
}

/**
 * Check whether the running cost has crossed the cap. Throws
 * `BudgetExceededError` if so; returns silently otherwise. Caller is
 * the agent's per-call usage sink — called after each `llm.call` event
 * is emitted (so the event itself appears in the stream even when the
 * call that pushed us over the cap is the one that triggers the abort).
 *
 * The `unpricedCallCount` argument is the running tally of calls whose
 * model contributed $0 to the aggregate — used for the warn message,
 * not for the threshold check itself.
 */
export function enforceBudget(
  cost: MultiModelCostEstimate,
  capUsd: number | undefined,
  unpricedCallCount: number,
): void {
  if (capUsd === undefined) return;
  if (cost.amountUsd <= capUsd) return;
  throw new BudgetExceededError(cost.amountUsd, capUsd, unpricedCallCount);
}
