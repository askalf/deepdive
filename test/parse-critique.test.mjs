import { test } from "node:test";
import assert from "node:assert/strict";
import { parseCritique } from "../dist/plan.js";

test("parseCritique: done=true with empty queries", () => {
  const raw = '{"done": true, "reasoning": "answer looks complete", "queries": []}';
  const c = parseCritique(raw);
  assert.equal(c.done, true);
  assert.deepEqual(c.queries, []);
  assert.equal(c.reasoning, "answer looks complete");
});

test("parseCritique: done=false with follow-up queries", () => {
  const raw =
    '{"done": false, "reasoning": "rate-limit specifics missing", "queries": ["claude rate limit headers", "anthropic 429 format"]}';
  const c = parseCritique(raw);
  assert.equal(c.done, false);
  assert.deepEqual(c.queries, [
    "claude rate limit headers",
    "anthropic 429 format",
  ]);
});

test("parseCritique: queries capped at 3", () => {
  const many = Array.from({ length: 8 }, (_, i) => `"q${i}"`).join(",");
  const raw = `{"done": false, "queries": [${many}]}`;
  const c = parseCritique(raw);
  assert.equal(c.queries.length, 3);
});

test("parseCritique: missing done field defaults based on queries", () => {
  // No explicit done, empty queries → treated as done.
  const a = parseCritique('{"queries": []}');
  assert.equal(a.done, true);
  // No explicit done, has queries → not done.
  const b = parseCritique('{"queries": ["next"]}');
  assert.equal(b.done, false);
});

test("parseCritique: non-string queries filtered", () => {
  const raw = '{"done": false, "queries": ["ok", 42, "", "  ", "also ok"]}';
  const c = parseCritique(raw);
  assert.deepEqual(c.queries, ["ok", "also ok"]);
});

test("parseCritique: missing queries array yields empty + done=true", () => {
  const c = parseCritique('{"done": true, "reasoning": "done"}');
  assert.equal(c.done, true);
  assert.deepEqual(c.queries, []);
});

test("parseCritique: prose before/after JSON is stripped", () => {
  const raw =
    'Here is my critique:\n{"done": false, "queries": ["one more"]}\nLet me know.';
  const c = parseCritique(raw);
  assert.deepEqual(c.queries, ["one more"]);
});

test("parseCritique: no JSON throws", () => {
  assert.throws(() => parseCritique("no json here"), /did not return JSON/);
});
