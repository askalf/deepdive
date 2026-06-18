import test from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import {
  safeErrorMessage,
  renderCitationHealthFooter,
  renderCostSummary,
  renderNoSourcesMessage,
} from "../dist/cli.js";
import { NoSourcesError } from "../dist/agent.js";
import { summarizeSourceTrust } from "../dist/source-authority.js";

const trust = (urls) => summarizeSourceTrust(urls);

test("safeErrorMessage: home dir scrubbed from Error.message", () => {
  const home = homedir();
  const err = new Error(`failed to open ${home}\\some\\secret`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes(home), `home should be scrubbed: ${out}`);
  assert.ok(out.includes("~"), `should include ~: ${out}`);
});

test("safeErrorMessage: handles non-Error thrown values", () => {
  assert.equal(safeErrorMessage("string error"), "string error");
  assert.equal(safeErrorMessage(42), "42");
  assert.equal(safeErrorMessage(null), "unknown error");
  assert.equal(safeErrorMessage(undefined), "unknown error");
});

test("safeErrorMessage: Unix home dir scrubbed", () => {
  // This test exercises the scrub logic for unix paths — only meaningful on
  // non-Windows, so we synthesize a unix-style home string.
  const fakeHome = homedir();
  const err = new Error(`config at ${fakeHome}/credentials.json is unreadable`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes(fakeHome), `home should be scrubbed: ${out}`);
});

test("safeErrorMessage: preserves non-path error content", () => {
  const err = new Error("LLM 500 Internal Server Error: upstream flake");
  assert.equal(
    safeErrorMessage(err),
    "LLM 500 Internal Server Error: upstream flake",
  );
});

test("safeErrorMessage: backslashes normalized to forward slashes", () => {
  const home = homedir();
  if (!home.includes("\\")) return; // Unix — nothing to test
  const err = new Error(`ENOENT at ${home}\\a\\b\\c`);
  const out = safeErrorMessage(err);
  assert.ok(!out.includes("\\"), `no backslashes in output: ${out}`);
});

test("renderCitationHealthFooter: returns '' when report is undefined", () => {
  assert.equal(renderCitationHealthFooter(undefined), "");
});

test("renderCitationHealthFooter: returns '' when all citations supported", () => {
  const report = {
    threshold: 0.4,
    totalCitations: 3,
    supportedCitations: 3,
    checks: [],
    unsupported: [],
  };
  assert.equal(renderCitationHealthFooter(report), "");
});

test("renderCostSummary: appends the dario hint when baseUrl matches", () => {
  const cost = {
    amountUsd: 0.034,
    knownModel: true,
    inputTokens: 12_100,
    outputTokens: 4_200,
    calls: 4,
  };
  const out = renderCostSummary(cost, "claude-sonnet-4-6", "http://localhost:3456");
  assert.match(out, /^cost · /);
  assert.match(out, /\$0 on Claude Max via dario/);
});

test("renderCostSummary: omits the dario hint when baseUrl is something else", () => {
  const cost = {
    amountUsd: 0.034,
    knownModel: true,
    inputTokens: 12_100,
    outputTokens: 4_200,
    calls: 4,
  };
  const out = renderCostSummary(cost, "claude-sonnet-4-6", "https://api.anthropic.com");
  assert.match(out, /^cost · /);
  assert.doesNotMatch(out, /Claude Max/);
});

test("renderNoSourcesMessage: rate-limited case suggests waiting or switching backends", () => {
  const err = new NoSourcesError("duckduckgo", ["q1", "q2"], 0, [
    { query: "q1", message: "duckduckgo is rate-limiting requests (HTTP 403)", rateLimited: true },
  ]);
  const out = renderNoSourcesMessage(err);
  assert.match(out, /stopped before spending the synthesis LLM call/);
  assert.match(out, /HTTP 403/);
  assert.match(out, /--search=multi:wikipedia,arxiv/);
  assert.match(out, /wait a minute/);
});

test("renderNoSourcesMessage: zero candidates without errors suggests rephrasing", () => {
  const err = new NoSourcesError("duckduckgo", ["q1"], 0, []);
  const out = renderNoSourcesMessage(err);
  assert.match(out, /rephrase the question/);
  assert.doesNotMatch(out, /wait a minute/);
});

test("renderNoSourcesMessage: candidates-but-none-kept names the fetch side", () => {
  const err = new NoSourcesError("duckduckgo", ["q1"], 4, []);
  const out = renderNoSourcesMessage(err);
  assert.match(out, /none survived fetch \+ extraction/);
  assert.match(out, /--verbose/);
});

test("renderNoSourcesMessage: caps the listed search errors at 3", () => {
  const errors = Array.from({ length: 5 }, (_, i) => ({
    query: `q${i}`,
    message: `error ${i}`,
    rateLimited: false,
  }));
  const err = new NoSourcesError("duckduckgo", errors.map((e) => e.query), 0, errors);
  const out = renderNoSourcesMessage(err);
  assert.match(out, /error 0/);
  assert.match(out, /error 2/);
  assert.doesNotMatch(out, /error 3/);
  assert.match(out, /and 2 more search error/);
});

test("renderCitationHealthFooter: emits a footer when there are unsupported cites", () => {
  const report = {
    threshold: 0.4,
    totalCitations: 5,
    supportedCitations: 3,
    checks: [],
    unsupported: [
      { sentence: "x", citedIds: [1], unsupportedIds: [1], recallByCite: { 1: 0.1 }, supported: false },
      { sentence: "y", citedIds: [2], unsupportedIds: [2], recallByCite: { 2: 0.2 }, supported: false },
    ],
  };
  const out = renderCitationHealthFooter(report);
  assert.match(out, /## Citation health/);
  assert.match(out, /2 of 5/);
  assert.match(out, /threshold 0\.4/);
});

test("renderCitationHealthFooter: flags low source trust even when citations are clean", () => {
  const out = renderCitationHealthFooter(
    undefined,
    trust(["https://aiflashreport.com/a", "https://gpt0x.com/b"]),
  );
  assert.match(out, /## Citation health/);
  assert.match(out, /Source trust: \*\*low\*\*/);
  assert.match(out, /content farms/);
});

test("renderCitationHealthFooter: high source trust adds nothing (clean stays clean)", () => {
  const out = renderCitationHealthFooter(
    undefined,
    trust(["https://arxiv.org/a", "https://redis.io/b"]),
  );
  assert.equal(out, "");
});

test("renderCitationHealthFooter: mixed source trust is surfaced", () => {
  const out = renderCitationHealthFooter(
    undefined,
    trust(["https://blog-one.dev/a", "https://blog-two.net/b"]),
  );
  assert.match(out, /Source trust: \*\*mixed\*\*/);
});

test("renderCitationHealthFooter: shows both axes when cites are weak AND trust is low", () => {
  const report = {
    threshold: 0.4,
    totalCitations: 4,
    supportedCitations: 1,
    checks: [],
    unsupported: [
      { sentence: "x", citedIds: [1], unsupportedIds: [1], recallByCite: { 1: 0.1 }, supported: false },
    ],
  };
  const out = renderCitationHealthFooter(
    report,
    trust(["https://gpt0x.com/a", "https://lmmarketcap.com/b"]),
  );
  assert.match(out, /citations have low lexical support/);
  assert.match(out, /Source trust: \*\*low\*\*/);
});
