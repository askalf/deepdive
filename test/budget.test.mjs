// Budget cap — pure tests for parseMaxCost + enforceBudget + the error class.
// No network, no LLM. Agent-loop integration (the error actually aborts a
// run) is covered by test/agent-loop.test.mjs.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseMaxCost,
  formatMaxCost,
  enforceBudget,
  BudgetExceededError,
} from "../dist/budget.js";

// ──────────────────────────────────────────────────────────────────────
test("parseMaxCost: accepts bare number", () => {
  assert.equal(parseMaxCost("0.50"), 0.5);
  assert.equal(parseMaxCost("5"), 5);
  assert.equal(parseMaxCost(".25"), 0.25);
});

test("parseMaxCost: accepts leading $", () => {
  assert.equal(parseMaxCost("$0.50"), 0.5);
  assert.equal(parseMaxCost("$5"), 5);
  assert.equal(parseMaxCost("$.25"), 0.25);
});

test("parseMaxCost: trims whitespace", () => {
  assert.equal(parseMaxCost("  $0.50  "), 0.5);
  assert.equal(parseMaxCost("\t$1\n"), 1);
});

test("parseMaxCost: rejects undefined / empty / null", () => {
  assert.equal(parseMaxCost(undefined), undefined);
  assert.equal(parseMaxCost(""), undefined);
  assert.equal(parseMaxCost("   "), undefined);
});

test("parseMaxCost: rejects zero and negatives", () => {
  assert.equal(parseMaxCost("0"), undefined);
  assert.equal(parseMaxCost("0.0"), undefined);
  assert.equal(parseMaxCost("-1"), undefined);
  assert.equal(parseMaxCost("$-1"), undefined);
});

test("parseMaxCost: rejects non-numeric junk", () => {
  assert.equal(parseMaxCost("abc"), undefined);
  assert.equal(parseMaxCost("$abc"), undefined);
  assert.equal(parseMaxCost("$0.50 USD"), undefined);
  assert.equal(parseMaxCost("$$5"), undefined);
  assert.equal(parseMaxCost("0.5 0.5"), undefined);
});

test("parseMaxCost: rejects scientific notation", () => {
  // We deliberately reject 1e-1 — error class for users, not a feature.
  assert.equal(parseMaxCost("1e2"), undefined);
  assert.equal(parseMaxCost("1.5e2"), undefined);
});

// ──────────────────────────────────────────────────────────────────────
test("formatMaxCost: standard ranges", () => {
  assert.equal(formatMaxCost(0), "$0.000");
  assert.equal(formatMaxCost(0.001), "$0.0010");
  assert.equal(formatMaxCost(0.5), "$0.500");
  assert.equal(formatMaxCost(5), "$5.00");
  assert.equal(formatMaxCost(125), "$125.00");
});

// ──────────────────────────────────────────────────────────────────────
function costEstimate(amountUsd, byModel = []) {
  return {
    amountUsd,
    knownModel: byModel.length > 0,
    inputTokens: 0,
    outputTokens: 0,
    calls: 0,
    byModel,
  };
}

test("enforceBudget: undefined cap is a no-op (no cap configured)", () => {
  assert.doesNotThrow(() => enforceBudget(costEstimate(1000), undefined, 0));
});

test("enforceBudget: spent < cap does not throw", () => {
  assert.doesNotThrow(() => enforceBudget(costEstimate(0.5), 1, 0));
  assert.doesNotThrow(() => enforceBudget(costEstimate(0.999), 1, 0));
});

test("enforceBudget: spent == cap does not throw (boundary)", () => {
  // <= cap is allowed; only strictly greater trips.
  assert.doesNotThrow(() => enforceBudget(costEstimate(1), 1, 0));
});

test("enforceBudget: spent > cap throws BudgetExceededError", () => {
  assert.throws(
    () => enforceBudget(costEstimate(1.01), 1, 0),
    (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.spentUsd, 1.01);
      assert.equal(err.capUsd, 1);
      assert.equal(err.unpricedCalls, 0);
      assert.match(err.message, /budget cap exceeded/);
      assert.match(err.message, /\$1\.01/);
      assert.match(err.message, /\$1\.00/);
      return true;
    },
  );
});

test("enforceBudget: unpriced calls > 0 mentions partial enforcement", () => {
  assert.throws(
    () => enforceBudget(costEstimate(1.5), 1, 3),
    (err) => {
      assert.ok(err instanceof BudgetExceededError);
      assert.equal(err.unpricedCalls, 3);
      assert.match(err.message, /3 call\(s\) on unpriced models/);
      assert.match(err.message, /cap enforcement is incomplete/);
      return true;
    },
  );
});

test("BudgetExceededError: name is set so callers can check instanceof OR by name", () => {
  const err = new BudgetExceededError(2, 1, 0);
  assert.equal(err.name, "BudgetExceededError");
  assert.ok(err instanceof Error);
});

// ──────────────────────────────────────────────────────────────────────
// Integration-shaped: feed enforceBudget the realistic estimate shape
// agent.ts produces.
test("enforceBudget: real-shape multi-model estimate trips correctly", () => {
  const realisticEstimate = {
    amountUsd: 0.0123,
    knownModel: true,
    inputTokens: 3500,
    outputTokens: 800,
    calls: 3,
    byModel: [
      { model: "claude-sonnet-4-6", estimate: { amountUsd: 0.012, knownModel: true, inputTokens: 3000, outputTokens: 700, calls: 2 } },
      { model: "claude-haiku-4-5", estimate: { amountUsd: 0.0003, knownModel: true, inputTokens: 500, outputTokens: 100, calls: 1 } },
    ],
  };
  // Under cap → ok
  assert.doesNotThrow(() => enforceBudget(realisticEstimate, 0.05, 0));
  // Over a $0.01 cap → fires
  assert.throws(() => enforceBudget(realisticEstimate, 0.01, 0), BudgetExceededError);
});
