// Near-duplicate detection — shingles + Jaccard.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  contentShingles,
  jaccard,
  findNearDuplicate,
  DEFAULT_NEAR_DUPE_THRESHOLD,
} from "../dist/similarity.js";

const DOC =
  "The token bucket algorithm is based on an analogy of a fixed capacity bucket " +
  "into which tokens are added at a fixed rate until the bucket is full.";

test("contentShingles: builds word 5-grams, lowercased", () => {
  const s = contentShingles("Alpha Beta GAMMA delta epsilon zeta");
  // 6 tokens → 2 shingles of 5
  assert.equal(s.size, 2);
  assert.ok(s.has("alpha beta gamma delta epsilon"));
  assert.ok(s.has("beta gamma delta epsilon zeta"));
});

test("contentShingles: short doc becomes a single whole-text shingle", () => {
  const s = contentShingles("just three words");
  assert.equal(s.size, 1);
  assert.ok(s.has("just three words"));
});

test("contentShingles: empty input → empty set", () => {
  assert.equal(contentShingles("").size, 0);
  assert.equal(contentShingles("   \n  ").size, 0);
});

test("jaccard: identical docs score 1, disjoint docs score 0", () => {
  const a = contentShingles(DOC);
  assert.equal(jaccard(a, contentShingles(DOC)), 1);
  const other = contentShingles(
    "Completely different prose about cooking pasta in salted boiling water for eleven minutes exactly.",
  );
  assert.equal(jaccard(a, other), 0);
});

test("jaccard: empty set is similar to nothing", () => {
  assert.equal(jaccard(new Set(), contentShingles(DOC)), 0);
  assert.equal(jaccard(new Set(), new Set()), 0);
});

test("jaccard: a suffix-extended copy of a realistic-length doc still scores high", () => {
  // Syndicated copy with an extra trailing attribution line — the common real
  // shape. Uses a web-source-length doc (the agent's min is 50 words); on very
  // short docs a suffix dilutes similarity proportionally more.
  const LONG =
    DOC +
    " When the bucket is full newly arriving tokens are discarded, and a request " +
    "may proceed only by consuming a token, which makes short bursts possible while " +
    "the long-run average rate stays bounded by the configured refill schedule.";
  const a = contentShingles(LONG);
  const b = contentShingles(LONG + " Reporting contributed by the wire desk.");
  const sim = jaccard(a, b);
  assert.ok(sim > 0.85, `expected > 0.85, got ${sim}`);
});

test("jaccard: same topic, different article scores low", () => {
  const a = contentShingles(DOC);
  const b = contentShingles(
    "Rate limiting with a leaky bucket drains requests at a constant pace regardless " +
      "of burstiness, which contrasts with token approaches that allow short bursts.",
  );
  const sim = jaccard(a, b);
  assert.ok(sim < 0.3, `expected < 0.3, got ${sim}`);
});

test("findNearDuplicate: returns the index of the first match, -1 otherwise", () => {
  const kept = [
    contentShingles("totally unrelated text about gardening tomatoes in raised beds during summer"),
    contentShingles(DOC),
  ];
  assert.equal(findNearDuplicate(contentShingles(DOC), kept), 1);
  assert.equal(
    findNearDuplicate(
      contentShingles("yet another disjoint document concerning maritime navigation by the stars"),
      kept,
    ),
    -1,
  );
});

test("findNearDuplicate: threshold is respected", () => {
  const a = contentShingles(DOC);
  const b = contentShingles(DOC + " Extra trailing sentence to lower similarity a bit overall.");
  const sim = jaccard(a, b);
  assert.equal(findNearDuplicate(b, [a], sim + 0.01), -1, "above-actual threshold → no match");
  assert.equal(findNearDuplicate(b, [a], sim - 0.01), 0, "below-actual threshold → match");
});

test("DEFAULT_NEAR_DUPE_THRESHOLD is the documented 0.9", () => {
  assert.equal(DEFAULT_NEAR_DUPE_THRESHOLD, 0.9);
});
