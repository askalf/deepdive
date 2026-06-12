import { test } from "node:test";
import assert from "node:assert/strict";
import { plannerSystem, criticSystem } from "../dist/plan.js";

// 2026-06-12T12:00:00Z — fixed "today" so assertions are stable.
const NOW = Date.UTC(2026, 5, 12, 12);
// 180 days earlier — the bench "recent" question's --since window.
const SINCE = NOW - 180 * 86_400_000;

test("plannerSystem: carries today's date", () => {
  const s = plannerSystem({ now: NOW });
  assert.match(s, /Today's date: 2026-06-12\./);
});

test("plannerSystem: defaults to the real current date", () => {
  const s = plannerSystem();
  const today = new Date().toISOString().slice(0, 10);
  assert.ok(s.includes(`Today's date: ${today}.`));
});

test("plannerSystem: recency rules present, since line absent without sinceMs", () => {
  const s = plannerSystem({ now: NOW });
  assert.match(s, /time-bound events/);
  assert.match(s, /absolute dates/);
  // The counterweight rule — scholarly/conceptual queries stay year-free.
  assert.match(s, /timeless/);
  assert.doesNotMatch(s, /freshness filter/);
});

test("plannerSystem: sinceMs discloses the cutoff date", () => {
  const s = plannerSystem({ now: NOW, sinceMs: SINCE });
  assert.match(s, /freshness filter will DROP every source published before 2025-12-14/);
});

test("plannerSystem: JSON output contract unchanged", () => {
  const s = plannerSystem({ now: NOW, sinceMs: SINCE });
  assert.match(s, /one JSON object, no prose before or after/);
  assert.match(s, /"queries": \["q1", "q2", \.\.\.\]/);
});

test("criticSystem: carries today's date and recency rules", () => {
  const s = criticSystem({ now: NOW });
  assert.match(s, /Today's date: 2026-06-12\./);
  assert.match(s, /time-bound events/);
  assert.match(s, /timeless/);
  assert.doesNotMatch(s, /freshness filter/);
});

test("criticSystem: sinceMs discloses the cutoff date", () => {
  const s = criticSystem({ now: NOW, sinceMs: SINCE });
  assert.match(s, /freshness filter will DROP every source published before 2025-12-14/);
});

test("criticSystem: done/queries output contract unchanged", () => {
  const s = criticSystem({ now: NOW, sinceMs: SINCE });
  assert.match(s, /"done": bool/);
});
