// Pure scoring functions of the bench harness (bench/run.mjs). The harness
// itself needs a live LLM + network and is manual-only; the scoring logic is
// deterministic and tested here.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  effectiveSpec,
  scoreResult,
  renderScoreboard,
  resolveBackend,
  questionArgs,
  GATES,
} from "../bench/run.mjs";

const DEFAULTS = {
  minSources: 4,
  minSupportRatio: 0.5,
  minAnswerWords: 120,
  maxCostUsd: 2.0,
};

function goodOutcome() {
  return {
    exitCode: 0,
    json: {
      answer: Array(150).fill("word").join(" ") + " QUIC connection migration explained.",
      usage: {
        kept: 6,
        citationsTotal: 10,
        citationsSupported: 8,
        estimatedCostUsd: 0.42,
      },
    },
  };
}

test("effectiveSpec: question overrides beat defaults, defaults fill gaps", () => {
  const spec = effectiveSpec({ minSources: 7, expectKeywords: ["x"] }, DEFAULTS);
  assert.equal(spec.minSources, 7);
  assert.equal(spec.minSupportRatio, 0.5);
  assert.equal(spec.minAnswerWords, 120);
  assert.deepEqual(spec.expectKeywords, ["x"]);
});

test("scoreResult: a healthy run passes every gate", () => {
  const spec = effectiveSpec({ expectKeywords: ["QUIC", "connection"] }, DEFAULTS);
  const { gates, pass } = scoreResult(goodOutcome(), spec);
  assert.equal(pass, true);
  for (const [name] of GATES) {
    assert.equal(gates[name].pass, true, `gate ${name} should pass: ${gates[name].detail}`);
  }
});

test("scoreResult: non-zero exit fails the completed gate (and overall)", () => {
  const spec = effectiveSpec({}, DEFAULTS);
  const { gates, pass } = scoreResult({ exitCode: 3, json: null }, spec);
  assert.equal(gates.completed.pass, false);
  assert.equal(pass, false);
});

test("scoreResult: too few sources fails the sources gate", () => {
  const outcome = goodOutcome();
  outcome.json.usage.kept = 2;
  const { gates } = scoreResult(outcome, effectiveSpec({}, DEFAULTS));
  assert.equal(gates.sources.pass, false);
  assert.equal(gates.sources.detail, "2/4");
});

test("scoreResult: zero citations fails support (an uncited answer is not a pass)", () => {
  const outcome = goodOutcome();
  outcome.json.usage.citationsTotal = 0;
  outcome.json.usage.citationsSupported = 0;
  const { gates } = scoreResult(outcome, effectiveSpec({}, DEFAULTS));
  assert.equal(gates.support.pass, false);
  assert.equal(gates.support.detail, "no citations");
});

test("scoreResult: weak citation support fails the support gate", () => {
  const outcome = goodOutcome();
  outcome.json.usage.citationsSupported = 3; // 3/10 < 0.5
  const { gates } = scoreResult(outcome, effectiveSpec({}, DEFAULTS));
  assert.equal(gates.support.pass, false);
});

test("scoreResult: missing keywords are named case-insensitively", () => {
  const spec = effectiveSpec({ expectKeywords: ["quic", "jellyfish"] }, DEFAULTS);
  const { gates } = scoreResult(goodOutcome(), spec);
  assert.equal(gates.keywords.pass, false);
  assert.equal(gates.keywords.detail, "missing: jellyfish");
});

test("scoreResult: cost over the ceiling fails the cost gate", () => {
  const outcome = goodOutcome();
  outcome.json.usage.estimatedCostUsd = 3.5;
  const { gates } = scoreResult(outcome, effectiveSpec({}, DEFAULTS));
  assert.equal(gates.cost.pass, false);
});

test("renderScoreboard: markdown table with verdicts and totals", () => {
  const spec = effectiveSpec({ expectKeywords: ["QUIC"] }, DEFAULTS);
  const rows = [
    { id: "good", score: scoreResult(goodOutcome(), spec), durationMs: 64000 },
    { id: "bad", score: scoreResult({ exitCode: 1, json: null }, spec), durationMs: 2000 },
  ];
  const out = renderScoreboard(rows, {
    date: "2026-06-11",
    model: "claude-sonnet-4-6",
    baseUrl: "http://localhost:3456",
    version: "0.20.0",
  });
  assert.match(out, /# deepdive bench — 2026-06-11/);
  assert.match(out, /\| good \|/);
  assert.match(out, /\*\*PASS\*\*/);
  assert.match(out, /\*\*FAIL\*\*/);
  assert.match(out, /1\/2 passed/);
  assert.match(out, /64s/);
});

test("renderScoreboard: records the search backend when set, omits when absent", () => {
  const spec = effectiveSpec({ expectKeywords: ["QUIC"] }, DEFAULTS);
  const rows = [{ id: "good", score: scoreResult(goodOutcome(), spec), durationMs: 1000 }];
  const base = { date: "2026-06-14", model: "m", baseUrl: "u", version: "1.0.0" };
  assert.match(renderScoreboard(rows, { ...base, searchBackend: "searxng" }), /search: `searxng`/);
  assert.doesNotMatch(renderScoreboard(rows, base), /search:/);
});

test("resolveBackend: explicit DEEPDIVE_SEARCH wins, else searxng needs a URL", () => {
  // explicit override wins even when a searxng URL is also present
  assert.equal(resolveBackend({ DEEPDIVE_SEARCH: "duckduckgo", DEEPDIVE_SEARXNG_URL: "u" }), "duckduckgo");
  assert.equal(resolveBackend({ DEEPDIVE_SEARCH: "brave" }), "brave");
  // no override → searxng when a URL is configured
  assert.equal(resolveBackend({ DEEPDIVE_SEARXNG_URL: "http://localhost:8081" }), "searxng");
  // nothing usable → null (main() turns this into a guided error)
  assert.equal(resolveBackend({}), null);
});

test("questionArgs: injects --search when absent, swaps duckduckgo, keeps domain adapters", () => {
  // plain question gets the backend injected + standard flags
  const plain = questionArgs({ question: "q" }, "searxng");
  assert.deepEqual(plain, ["q", "--json", "--no-sessions", "--max-runtime=8m", "--search=searxng"]);

  // multi-adapter question: only the duckduckgo leg is swapped, arxiv/openalex stay
  const multi = questionArgs({ question: "q", args: ["--search=multi:duckduckgo,arxiv,openalex"] }, "searxng");
  assert.ok(multi.includes("--search=multi:searxng,arxiv,openalex"));
  assert.equal(multi.filter((a) => a.startsWith("--search=")).length, 1); // not double-injected

  // unrelated args (e.g. --since, --deep) pass through untouched
  const since = questionArgs({ question: "q", args: ["--since=180d"] }, "searxng");
  assert.ok(since.includes("--since=180d"));
  assert.ok(since.includes("--search=searxng"));

  // an explicit override of duckduckgo is a no-op swap (reproduces old behavior)
  const ddg = questionArgs({ question: "q", args: ["--search=multi:duckduckgo,stackexchange"] }, "duckduckgo");
  assert.ok(ddg.includes("--search=multi:duckduckgo,stackexchange"));
});
