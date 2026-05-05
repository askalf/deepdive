// Citation verifier — pure-function tests + an end-to-end agent integration
// test that drives a synthesized answer with one bogus citation through the
// full pipeline and checks that the verification report flags it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  verifyCitations,
  splitSentences,
  extractCiteIds,
  contentTokens,
  recall,
  stripSourcesBlock,
  DEFAULT_CITE_MIN_RECALL,
} from "../dist/verify.js";

// ── splitSentences ──────────────────────────────────────────────────────────

test("splitSentences: splits on .!? followed by space + capital", () => {
  const out = splitSentences("Foo bar. Baz qux! Quux? Done.");
  assert.deepEqual(out, ["Foo bar.", "Baz qux!", "Quux?", "Done."]);
});

test("splitSentences: each line is its own sentence boundary", () => {
  const out = splitSentences("## Header\n\nFirst para [1].\nSecond para [2].");
  assert.deepEqual(out, ["## Header", "First para [1].", "Second para [2]."]);
});

test("splitSentences: handles a trailing fragment with no terminator", () => {
  const out = splitSentences("First. Second without period");
  assert.deepEqual(out, ["First.", "Second without period"]);
});

test("splitSentences: blank lines drop out", () => {
  assert.deepEqual(splitSentences("a\n\n\nb"), ["a", "b"]);
});

// ── extractCiteIds ──────────────────────────────────────────────────────────

test("extractCiteIds: single [N]", () => {
  assert.deepEqual(extractCiteIds("foo [3] bar"), [3]);
});

test("extractCiteIds: adjacent [N][M]", () => {
  assert.deepEqual(extractCiteIds("foo [1][3] bar"), [1, 3]);
});

test("extractCiteIds: comma form [1, 3]", () => {
  assert.deepEqual(extractCiteIds("foo [1, 3] bar"), [1, 3]);
});

test("extractCiteIds: ignores non-numeric brackets", () => {
  assert.deepEqual(extractCiteIds("[citation needed] [a] [3]"), [3]);
});

test("extractCiteIds: empty when no citations", () => {
  assert.deepEqual(extractCiteIds("plain prose with no cites"), []);
});

// ── contentTokens ───────────────────────────────────────────────────────────

test("contentTokens: lowercases + drops stop words", () => {
  const t = contentTokens("The quick brown fox");
  assert.deepEqual(t.sort(), ["brown", "fox", "quick"]);
});

test("contentTokens: keeps numeric tokens, even short ones", () => {
  const t = contentTokens("response 429 with 5h bucket");
  assert.ok(t.includes("429"), "429 survives");
  assert.ok(t.includes("5"), "5 from 5h survives");
  assert.ok(t.includes("bucket"));
});

test("contentTokens: hyphens split tokens", () => {
  const t = contentTokens("rate-limit headers");
  assert.deepEqual(t.sort(), ["headers", "limit", "rate"]);
});

test("contentTokens: drops bare punctuation", () => {
  const t = contentTokens("!!! ---");
  assert.deepEqual(t, []);
});

// ── recall ──────────────────────────────────────────────────────────────────

test("recall: full overlap = 1", () => {
  assert.equal(recall(["a", "b", "c"], new Set(["a", "b", "c", "d"])), 1);
});

test("recall: half overlap = 0.5", () => {
  assert.equal(recall(["a", "b"], new Set(["a", "x"])), 0.5);
});

test("recall: deduplicates claim tokens", () => {
  // Set-based: ["a","a","b"] has size 2; one match → 0.5
  assert.equal(recall(["a", "a", "b"], new Set(["a"])), 0.5);
});

test("recall: empty claim is vacuously supported (1)", () => {
  assert.equal(recall([], new Set(["x"])), 1);
});

// ── stripSourcesBlock ───────────────────────────────────────────────────────

test("stripSourcesBlock: removes appended sources section", () => {
  const md =
    "Body sentence [1].\n\n## Sources\n\n1. [Title](https://ex.com)";
  assert.equal(stripSourcesBlock(md), "Body sentence [1].");
});

test("stripSourcesBlock: leaves answer alone when no sources block", () => {
  assert.equal(stripSourcesBlock("Plain answer."), "Plain answer.");
});

// ── verifyCitations end-to-end (pure) ───────────────────────────────────────

const SOURCE_A_CONTENT =
  "Anthropic's Claude rate limiter uses a five-hour rolling bucket and a " +
  "seven-day rolling bucket. Requests bill against the five-hour bucket first.";
const SOURCE_B_CONTENT =
  "When a request exhausts the bucket the API returns HTTP 429 with the " +
  "anthropic-ratelimit headers populated.";
const SOURCE_C_CONTENT =
  "Cats are excellent at sitting in cardboard boxes. They also enjoy sunbeams.";

const sources = [
  { id: 1, url: "https://a", title: "A", fetchedAt: 0, content: SOURCE_A_CONTENT },
  { id: 2, url: "https://b", title: "B", fetchedAt: 0, content: SOURCE_B_CONTENT },
  { id: 3, url: "https://c", title: "C", fetchedAt: 0, content: SOURCE_C_CONTENT },
];

test("verifyCitations: faithful sentence is supported", () => {
  const answer =
    "Claude's rate limiter uses a five-hour bucket and a seven-day bucket [1].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.checks.length, 1);
  assert.equal(r.checks[0].supported, true);
  assert.equal(r.unsupported.length, 0);
  assert.equal(r.totalCitations, 1);
  assert.equal(r.supportedCitations, 1);
});

test("verifyCitations: hallucinated sentence is flagged", () => {
  const answer =
    "Claude's rate limiter uses a thirty-second mongoose interval [3].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.unsupported[0].supported, false);
  assert.deepEqual(r.unsupported[0].unsupportedIds, [3]);
});

test("verifyCitations: REQUIRE-ALL — multi-cite with one bogus is unsupported", () => {
  // Source 1 supports the rate-limiter claim; source 3 (cats) does not.
  const answer =
    "Claude's rate limiter uses a five-hour bucket and a seven-day bucket [1][3].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.checks.length, 1);
  assert.equal(
    r.checks[0].supported,
    false,
    "sentence flagged because [3] is unsupported even though [1] is",
  );
  assert.deepEqual(r.checks[0].unsupportedIds, [3]);
  assert.equal(r.supportedCitations, 1, "[1] still counts as supported");
  assert.equal(r.totalCitations, 2);
});

test("verifyCitations: multi-cite with both supporting is supported", () => {
  // Claim tokens (anthropic, uses, bucket) all appear in BOTH sources 1 and 2,
  // so the require-all rule passes.
  const answer = "Anthropic uses the bucket [1][2].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.checks[0].supported, true);
  assert.equal(r.unsupported.length, 0);
});

test("verifyCitations: sentences with no [N] are excluded from the report", () => {
  const answer = "This sentence has no citation. This one does [1].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.checks.length, 1);
  assert.equal(r.totalCitations, 1);
});

test("verifyCitations: ignores cites pointing at unknown source ids", () => {
  // [99] doesn't exist in our sources → recall is 0 → unsupported.
  const answer = "Some claim [99].";
  const r = verifyCitations(answer, sources);
  assert.equal(r.unsupported.length, 1);
  assert.equal(r.checks[0].recallByCite[99], 0);
});

test("verifyCitations: threshold knob changes verdict", () => {
  // Tuned for ~50% recall against source 1: "claude" + "limiter" overlap;
  // "headers" + "cardboard" do not.
  const answer = "Claude limiter headers cardboard [1].";
  const lax = verifyCitations(answer, sources, { threshold: 0.3 });
  const strict = verifyCitations(answer, sources, { threshold: 0.7 });
  assert.equal(lax.unsupported.length, 0);
  assert.equal(strict.unsupported.length, 1);
});

test("verifyCitations: DEFAULT_CITE_MIN_RECALL is exposed and is 0.4", () => {
  assert.equal(DEFAULT_CITE_MIN_RECALL, 0.4);
});

test("verifyCitations: strips an appended Sources block before verifying", () => {
  // The "[2]" inside the Sources block should NOT be counted as a citation.
  const answer =
    "Faithful claim [1].\n\n## Sources\n\n1. [Title](https://a) — [2] is just markdown.";
  const r = verifyCitations(answer, sources);
  assert.equal(r.checks.length, 1, "only the body sentence is checked");
  assert.equal(r.totalCitations, 1);
});
