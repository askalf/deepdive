// Pure source-authority reporting functions of the bench harness (P3 of #111).
// The two-pass `--authority-compare` run needs a live LLM; the distribution
// math and rendering are deterministic and tested here, like bench-score.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  authorityOf,
  trustedShare,
  fmtAuthority,
  aggregateAuthority,
  renderComparison,
  renderScoreboard,
  questionArgs,
  scoreResult,
  effectiveSpec,
} from "../bench/run.mjs";

test("authorityOf: reads the top-level sourceTrust summary", () => {
  const dist = authorityOf({
    sourceTrust: { label: "high", counts: { primary: 3, reputable: 1, unknown: 1, low: 0, total: 5 } },
  });
  assert.deepEqual(dist, { primary: 3, reputable: 1, unknown: 1, low: 0, total: 5, label: "high" });
});

test("authorityOf: falls back to counting per-source authority tiers", () => {
  const dist = authorityOf({
    sources: [
      { authority: { tier: "primary" } },
      { authority: { tier: "primary" } },
      { authority: { tier: "low" } },
      { authority: {} }, // tier-less source is not counted
    ],
  });
  assert.equal(dist.primary, 2);
  assert.equal(dist.low, 1);
  assert.equal(dist.total, 3);
  assert.equal(dist.label, null);
});

test("authorityOf: no envelope / pre-feature run → all-zero, label null", () => {
  assert.deepEqual(authorityOf(null), {
    primary: 0, reputable: 0, unknown: 0, low: 0, total: 0, label: null,
  });
  assert.equal(authorityOf({ answer: "x" }).total, 0);
});

test("trustedShare: primary+reputable over total, 0 when empty", () => {
  assert.equal(trustedShare({ primary: 3, reputable: 1, unknown: 0, low: 0, total: 4 }), 1);
  assert.equal(trustedShare({ primary: 1, reputable: 0, unknown: 1, low: 2, total: 4 }), 0.25);
  assert.equal(trustedShare({ primary: 0, reputable: 0, unknown: 0, low: 0, total: 0 }), 0);
});

test("fmtAuthority: compact cell, em-dash when empty/absent", () => {
  assert.equal(
    fmtAuthority({ primary: 3, reputable: 0, unknown: 1, low: 0, total: 4, label: "high" }),
    "3P 0R 1U 0L · high",
  );
  assert.equal(fmtAuthority({ primary: 0, reputable: 0, unknown: 0, low: 0, total: 0, label: null }), "—");
  assert.equal(fmtAuthority(undefined), "—");
});

test("aggregateAuthority: sums distributions", () => {
  const agg = aggregateAuthority([
    { primary: 1, reputable: 0, unknown: 1, low: 0, total: 2 },
    { primary: 2, reputable: 1, unknown: 0, low: 1, total: 4 },
  ]);
  assert.deepEqual(agg, { primary: 3, reputable: 1, unknown: 1, low: 1, total: 6 });
});

test("renderComparison: before/after table with per-question delta + aggregate shift", () => {
  const pairs = [
    {
      id: "recent",
      off: { primary: 0, reputable: 0, unknown: 2, low: 4, total: 6, label: "low" },
      prefer: { primary: 2, reputable: 1, unknown: 3, low: 0, total: 6, label: "mixed" },
    },
  ];
  const out = renderComparison(pairs, {
    date: "2026-06-18", model: "m", baseUrl: "u", searchBackend: "searxng", version: "0.26.0",
  });
  assert.match(out, /source authority \(before\/after\)/);
  assert.match(out, /\| recent \| 0P 0R 2U 4L · low \| 2P 1R 3U 0L · mixed \| \+3 \|/);
  assert.match(out, /0% → 50%/); // off 0/6 trusted, prefer 3/6 trusted
});

test("renderScoreboard: gains an authority column + aggregate when rows carry it", () => {
  const spec = effectiveSpec({ expectKeywords: [] }, {
    minSources: 1, minSupportRatio: 0, minAnswerWords: 0, maxCostUsd: 9,
  });
  const outcome = {
    exitCode: 0,
    json: { answer: "a b c", usage: { kept: 1, citationsTotal: 1, citationsSupported: 1, estimatedCostUsd: 0 } },
  };
  const rows = [{
    id: "q",
    score: scoreResult(outcome, spec),
    durationMs: 1000,
    authority: { primary: 2, reputable: 0, unknown: 0, low: 0, total: 2, label: "high" },
  }];
  const out = renderScoreboard(rows, { date: "2026-06-18", model: "m", baseUrl: "u", version: "0.26.0" });
  assert.match(out, /\| authority \|/); // header column
  assert.match(out, /2P 0R 0U 0L · high/); // cell
  assert.match(out, /\*\*Source authority:\*\* 100% primary\/reputable/); // aggregate footer
});

test("renderScoreboard: omits the authority aggregate when no row carries a distribution", () => {
  const spec = effectiveSpec({ expectKeywords: [] }, {
    minSources: 1, minSupportRatio: 0, minAnswerWords: 0, maxCostUsd: 9,
  });
  const outcome = {
    exitCode: 0,
    json: { answer: "a b c", usage: { kept: 1, citationsTotal: 1, citationsSupported: 1, estimatedCostUsd: 0 } },
  };
  const rows = [{ id: "q", score: scoreResult(outcome, spec), durationMs: 1000 }]; // no .authority
  const out = renderScoreboard(rows, { date: "2026-06-18", model: "m", baseUrl: "u", version: "0.26.0" });
  assert.doesNotMatch(out, /Source authority:/);
  assert.match(out, /\| q \|.*\| — \|/); // empty cell still renders
});

test("questionArgs: appends --source-authority only when a mode is given", () => {
  const base = questionArgs({ question: "q" }, "searxng");
  assert.ok(!base.some((a) => a.startsWith("--source-authority")));
  const off = questionArgs({ question: "q" }, "searxng", "off");
  assert.ok(off.includes("--source-authority=off"));
  const prefer = questionArgs({ question: "q", args: ["--since=180d"] }, "searxng", "prefer");
  assert.ok(prefer.includes("--source-authority=prefer"));
  assert.ok(prefer.includes("--since=180d")); // existing args preserved
});
