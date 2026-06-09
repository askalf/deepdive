// Coverage / confidence heuristic.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assessConfidence, formatConfidenceLine } from "../dist/confidence.js";

test("assessConfidence: high when many sources + well-supported cites", () => {
  const a = assessConfidence({ sources: 8, citationsTotal: 12, citationsSupported: 12 });
  assert.equal(a.level, "high");
  assert.equal(a.supportRatio, 1);
});

test("assessConfidence: low when evidence base is thin", () => {
  const a = assessConfidence({ sources: 2, citationsTotal: 4, citationsSupported: 4 });
  assert.equal(a.level, "low");
  assert.match(a.reasons.join(" "), /thin evidence base/);
});

test("assessConfidence: low when the answer has no inline citations", () => {
  const a = assessConfidence({ sources: 9, citationsTotal: 0, citationsSupported: 0 });
  assert.equal(a.level, "low");
  assert.match(a.reasons.join(" "), /not grounded in citations/);
  assert.equal(a.supportRatio, 1); // nothing to check → neutral ratio
});

test("assessConfidence: low when many citations fail verification", () => {
  const a = assessConfidence({ sources: 7, citationsTotal: 10, citationsSupported: 4 });
  assert.equal(a.level, "low");
  assert.equal(a.supportRatio, 0.4);
  assert.match(a.reasons.join(" "), /weakly supported/);
});

test("assessConfidence: medium in between", () => {
  // 4 sources (not thin, not >=5), all cites supported → medium
  const a = assessConfidence({ sources: 4, citationsTotal: 5, citationsSupported: 5 });
  assert.equal(a.level, "medium");
});

test("formatConfidenceLine: one-line summary", () => {
  const a = assessConfidence({ sources: 8, citationsTotal: 12, citationsSupported: 12 });
  const line = formatConfidenceLine(a);
  assert.match(line, /^confidence · high · /);
  assert.match(line, /8 sources/);
  assert.match(line, /12\/12 citations supported/);
});
