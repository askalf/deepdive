import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../dist/plan.js";

test("parsePlan: clean JSON", () => {
  const raw = '{"reasoning":"because","queries":["a","b","c"]}';
  const p = parsePlan(raw);
  assert.equal(p.reasoning, "because");
  assert.deepEqual(p.queries, ["a", "b", "c"]);
});

test("parsePlan: prose before/after JSON is stripped", () => {
  const raw = 'Here is the plan:\n\n{"reasoning":"r","queries":["x","y"]}\n\nThat should cover it.';
  const p = parsePlan(raw);
  assert.deepEqual(p.queries, ["x", "y"]);
});

test("parsePlan: strings containing braces do not confuse parser", () => {
  const raw = '{"reasoning":"this {thing} is tricky","queries":["q1","q2"]}';
  const p = parsePlan(raw);
  assert.equal(p.reasoning, "this {thing} is tricky");
  assert.deepEqual(p.queries, ["q1", "q2"]);
});

test("parsePlan: escaped quotes inside strings do not close them early", () => {
  const raw = '{"reasoning":"she said \\"hi\\"","queries":["a"]}';
  const p = parsePlan(raw);
  assert.equal(p.reasoning, 'she said "hi"');
});

test("parsePlan: empty queries array rejected", () => {
  assert.throws(() => parsePlan('{"queries":[]}'), /no queries/);
});

test("parsePlan: missing queries rejected", () => {
  assert.throws(() => parsePlan('{"reasoning":"..."}'), /no queries/);
});

test("parsePlan: non-string entries filtered out, empties dropped", () => {
  const raw = '{"queries":["good", 42, "", "  ", "also good"]}';
  const p = parsePlan(raw);
  assert.deepEqual(p.queries, ["good", "also good"]);
});

test("parsePlan: queries clamped at 8", () => {
  const many = Array.from({ length: 20 }, (_, i) => `"q${i}"`).join(",");
  const raw = `{"queries":[${many}]}`;
  const p = parsePlan(raw);
  assert.equal(p.queries.length, 8);
});

test("parsePlan: no JSON at all throws", () => {
  assert.throws(() => parsePlan("this has no json"), /did not return JSON/);
});
