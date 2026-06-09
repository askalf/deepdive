// Session stats aggregation.

import { test } from "node:test";
import assert from "node:assert/strict";
import { aggregateSessionStats, renderStats } from "../dist/stats.js";

function rec({ id, createdAt, model, cost, sources = 1, rounds = 1 }) {
  return {
    schema: 1,
    id,
    createdAt,
    question: "q " + id,
    plan: { reasoning: "", queries: [] },
    rounds: Array.from({ length: rounds }, (_, i) => ({ round: i, queries: [], candidatesFound: 0, fetched: 0, kept: 0 })),
    sources: Array.from({ length: sources }, (_, i) => ({ id: i + 1, url: "u" + i, title: "t", fetchedAt: 0, content: "c" })),
    answer: "a",
    cost: { amountUsd: cost },
    llm: { baseUrl: "x", model },
  };
}

test("aggregateSessionStats: empty input", () => {
  const s = aggregateSessionStats([]);
  assert.equal(s.count, 0);
  assert.equal(s.totalCostUsd, 0);
  assert.equal(s.avgSourcesPerSession, 0);
  assert.deepEqual(s.byModel, []);
});

test("aggregateSessionStats: sums cost/sources/rounds, counts deep runs", () => {
  const s = aggregateSessionStats([
    rec({ id: "a", createdAt: 100, model: "sonnet", cost: 0.01, sources: 3, rounds: 1 }),
    rec({ id: "b", createdAt: 300, model: "sonnet", cost: 0.02, sources: 5, rounds: 3 }),
    rec({ id: "c", createdAt: 200, model: "opus", cost: 0.10, sources: 2, rounds: 2 }),
  ]);
  assert.equal(s.count, 3);
  assert.ok(Math.abs(s.totalCostUsd - 0.13) < 1e-9);
  assert.equal(s.totalSources, 10);
  assert.equal(s.totalRounds, 6);
  assert.equal(s.deepRuns, 2); // b (3) and c (2) ran >1 round
  assert.ok(Math.abs(s.avgSourcesPerSession - 10 / 3) < 1e-9);
  assert.equal(s.oldest, 100);
  assert.equal(s.newest, 300);
});

test("aggregateSessionStats: per-model breakdown sorted by count desc", () => {
  const s = aggregateSessionStats([
    rec({ id: "a", createdAt: 1, model: "sonnet", cost: 0.01 }),
    rec({ id: "b", createdAt: 2, model: "sonnet", cost: 0.02 }),
    rec({ id: "c", createdAt: 3, model: "opus", cost: 0.10 }),
  ]);
  assert.equal(s.byModel[0].model, "sonnet");
  assert.equal(s.byModel[0].count, 2);
  assert.ok(Math.abs(s.byModel[0].costUsd - 0.03) < 1e-9);
  assert.equal(s.byModel[1].model, "opus");
});

test("aggregateSessionStats: missing cost/model handled", () => {
  const r = rec({ id: "x", createdAt: 1, model: undefined, cost: undefined });
  delete r.cost;
  delete r.llm;
  const s = aggregateSessionStats([r]);
  assert.equal(s.totalCostUsd, 0);
  assert.equal(s.byModel[0].model, "(unknown)");
});

test("renderStats: empty + populated", () => {
  assert.match(renderStats(aggregateSessionStats([])), /no sessions yet/);
  const out = renderStats(
    aggregateSessionStats([rec({ id: "a", createdAt: Date.UTC(2026, 5, 1), model: "claude-sonnet-4-6", cost: 0.0085, sources: 4 })]),
  );
  assert.match(out, /sessions\s+1/);
  assert.match(out, /\$0\.0085/);
  assert.match(out, /claude-sonnet-4-6/);
  assert.match(out, /2026-06-01/);
});
