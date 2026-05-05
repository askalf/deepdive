// Pricing module — pure tests for the price table, cost math, formatters,
// and the dario auto-detection heuristic.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  priceFor,
  estimateCost,
  formatCostLine,
  formatUsd,
  formatTokens,
  looksLikeDario,
  PRICE_TABLE,
  DARIO_DEFAULT_BASE_URL,
} from "../dist/pricing.js";

// ── price table ─────────────────────────────────────────────────────────────

test("PRICE_TABLE: contains the headline Anthropic models", () => {
  assert.ok(PRICE_TABLE["claude-sonnet-4-6"]);
  assert.ok(PRICE_TABLE["claude-opus-4-7"]);
  assert.ok(PRICE_TABLE["claude-haiku-4-5"]);
});

test("priceFor: returns the table entry for a known model", () => {
  const p = priceFor("claude-sonnet-4-6");
  assert.deepEqual(p, { inputPerMTok: 3, outputPerMTok: 15 });
});

test("priceFor: returns undefined for an unknown model with no env override", () => {
  assert.equal(priceFor("self-hosted-thing"), undefined);
});

test("priceFor: env override fills in for unknown models", () => {
  const p = priceFor("self-hosted-thing", {
    DEEPDIVE_PRICE_INPUT_PER_MTOK: "0.5",
    DEEPDIVE_PRICE_OUTPUT_PER_MTOK: "1.5",
  });
  assert.deepEqual(p, { inputPerMTok: 0.5, outputPerMTok: 1.5 });
});

test("priceFor: env override does NOT silently override a known model", () => {
  // Known model wins — the table is canonical for known names.
  const p = priceFor("claude-sonnet-4-6", {
    DEEPDIVE_PRICE_INPUT_PER_MTOK: "999",
    DEEPDIVE_PRICE_OUTPUT_PER_MTOK: "999",
  });
  assert.deepEqual(p, { inputPerMTok: 3, outputPerMTok: 15 });
});

test("priceFor: junky env values are ignored, returns undefined", () => {
  assert.equal(
    priceFor("x", {
      DEEPDIVE_PRICE_INPUT_PER_MTOK: "abc",
      DEEPDIVE_PRICE_OUTPUT_PER_MTOK: "1.0",
    }),
    undefined,
  );
  assert.equal(
    priceFor("x", {
      DEEPDIVE_PRICE_INPUT_PER_MTOK: "-1",
      DEEPDIVE_PRICE_OUTPUT_PER_MTOK: "1",
    }),
    undefined,
  );
});

// ── estimateCost ────────────────────────────────────────────────────────────

test("estimateCost: known model, basic math at 3/15 prices", () => {
  // 1M in @ $3 = $3.00; 100k out @ $15 = $1.50 → total $4.50
  const e = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 100_000, calls: 5 },
    "claude-sonnet-4-6",
  );
  assert.equal(e.knownModel, true);
  assert.equal(e.amountUsd, 4.5);
  assert.equal(e.inputTokens, 1_000_000);
  assert.equal(e.outputTokens, 100_000);
  assert.equal(e.calls, 5);
});

test("estimateCost: zero usage → $0", () => {
  const e = estimateCost(
    { inputTokens: 0, outputTokens: 0, calls: 0 },
    "claude-sonnet-4-6",
  );
  assert.equal(e.amountUsd, 0);
  assert.equal(e.knownModel, true);
});

test("estimateCost: unknown model + no env → amount 0, knownModel false", () => {
  const e = estimateCost(
    { inputTokens: 1000, outputTokens: 1000, calls: 1 },
    "self-hosted-mystery",
  );
  assert.equal(e.amountUsd, 0);
  assert.equal(e.knownModel, false);
});

test("estimateCost: unknown model + env override → uses env price", () => {
  // 1M in @ $0.5 = $0.50; 1M out @ $1.0 = $1.00 → total $1.50
  const e = estimateCost(
    { inputTokens: 1_000_000, outputTokens: 1_000_000, calls: 2 },
    "self-hosted",
    {
      DEEPDIVE_PRICE_INPUT_PER_MTOK: "0.5",
      DEEPDIVE_PRICE_OUTPUT_PER_MTOK: "1.0",
    },
  );
  assert.equal(e.amountUsd, 1.5);
  assert.equal(e.knownModel, false, "knownModel reflects table membership, not env");
});

// ── formatters ──────────────────────────────────────────────────────────────

test("formatUsd: tiers — $0 / sub-cent / sub-dollar / dollar", () => {
  assert.equal(formatUsd(0), "$0.000");
  assert.equal(formatUsd(0.0034), "$0.0034");
  assert.equal(formatUsd(0.42), "$0.420");
  assert.equal(formatUsd(4.5), "$4.50");
});

test("formatTokens: scales <1k / k / M cleanly", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(42), "42");
  assert.equal(formatTokens(999), "999");
  assert.equal(formatTokens(1_000), "1.00k");
  assert.equal(formatTokens(1_234), "1.23k");
  assert.equal(formatTokens(12_500), "12.5k");
  assert.equal(formatTokens(1_500_000), "1.50M");
});

test("formatCostLine: known model, multi-call run", () => {
  const out = formatCostLine(
    {
      amountUsd: 0.034,
      knownModel: true,
      inputTokens: 12_100,
      outputTokens: 4_200,
      calls: 4,
    },
    "claude-sonnet-4-6",
  );
  assert.match(out, /~\$0\.0340?/);
  assert.match(out, /12\.1k in/);
  assert.match(out, /4\.20k out/);
  assert.match(out, /4 LLM calls/);
  assert.match(out, /claude-sonnet-4-6$/);
});

test("formatCostLine: unknown model with no price → $? marker", () => {
  const out = formatCostLine(
    {
      amountUsd: 0,
      knownModel: false,
      inputTokens: 100,
      outputTokens: 50,
      calls: 1,
    },
    "self-hosted",
  );
  assert.match(out, /^\$\?/);
  assert.match(out, /1 LLM call · self-hosted$/);
});

test("formatCostLine: singular vs plural call label", () => {
  const e = (calls) => ({
    amountUsd: 0.001,
    knownModel: true,
    inputTokens: 10,
    outputTokens: 10,
    calls,
  });
  assert.match(formatCostLine(e(1), "x"), /1 LLM call /);
  assert.match(formatCostLine(e(2), "x"), /2 LLM calls /);
});

// ── looksLikeDario ──────────────────────────────────────────────────────────

test("looksLikeDario: matches the default port exactly", () => {
  assert.equal(looksLikeDario(DARIO_DEFAULT_BASE_URL), true);
  assert.equal(looksLikeDario("http://localhost:3456/"), true, "trailing slash tolerated");
});

test("looksLikeDario: rejects a different host or port", () => {
  assert.equal(looksLikeDario("https://api.anthropic.com"), false);
  assert.equal(looksLikeDario("http://localhost:3000"), false);
  assert.equal(looksLikeDario("http://127.0.0.1:3456"), false);
});
