// Session diff — source-set delta + LCS line diff + narration prompt.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diffSessions,
  diffSources,
  diffLines,
  renderDiffText,
  buildDiffNarrateUser,
} from "../dist/diff.js";

function src(id, url, title = "T" + id) {
  return { id, url, title, fetchedAt: Date.UTC(2026, 0, 1), content: "c" };
}

function rec(overrides = {}) {
  return {
    schema: 1,
    id: "2026-05-01_120000_aaaaaaaa",
    createdAt: Date.UTC(2026, 4, 1, 12, 0, 0),
    question: "q",
    plan: { reasoning: "", queries: [] },
    rounds: [{ round: 0, queries: [], candidatesFound: 0, fetched: 0, kept: 0 }],
    sources: [src(1, "https://a.com")],
    answer: "line one\nline two",
    cost: { amountUsd: 0.001, knownModel: true, inputTokens: 1, outputTokens: 1, calls: 1 },
    llm: { baseUrl: "http://localhost:3456", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

// ── diffLines ────────────────────────────────────────────────────────────────

test("diffLines: counts added / removed / unchanged", () => {
  const d = diffLines(["x", "y", "z"], ["x", "Y", "z"]);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.unchanged, 2);
});

test("diffLines: identical input has no changes", () => {
  const d = diffLines(["a", "b"], ["a", "b"]);
  assert.equal(d.added, 0);
  assert.equal(d.removed, 0);
  assert.equal(d.unchanged, 2);
});

test("diffLines: pure append", () => {
  const d = diffLines(["a"], ["a", "b", "c"]);
  assert.equal(d.added, 2);
  assert.equal(d.removed, 0);
});

// ── diffSources ──────────────────────────────────────────────────────────────

test("diffSources: added / removed / shared keyed on normalized url", () => {
  const a = [src(1, "https://a.com"), src(2, "https://b.com")];
  const b = [src(1, "https://b.com/"), src(2, "https://c.com")]; // trailing slash on b.com
  const d = diffSources(a, b);
  assert.deepEqual(d.added.map((s) => s.url), ["https://c.com"]);
  assert.deepEqual(d.removed.map((s) => s.url), ["https://a.com"]);
  assert.equal(d.shared.length, 1); // b.com matches despite trailing slash
});

// ── diffSessions + render ────────────────────────────────────────────────────

test("diffSessions: assembles both sides + deltas", () => {
  const a = rec({ id: "2026-05-01_120000_aaaaaaaa", answer: "alpha\nbeta", sources: [src(1, "https://a.com")] });
  const b = rec({
    id: "2026-06-01_120000_bbbbbbbb",
    createdAt: Date.UTC(2026, 5, 1, 12, 0, 0),
    answer: "alpha\nGAMMA",
    sources: [src(1, "https://a.com"), src(2, "https://new.com")],
    llm: { baseUrl: "http://localhost:3456", model: "claude-opus-4-7" },
  });
  const d = diffSessions(a, b);
  assert.equal(d.a.id, a.id);
  assert.equal(d.b.id, b.id);
  assert.equal(d.a.model, "claude-sonnet-4-6");
  assert.equal(d.b.model, "claude-opus-4-7");
  assert.equal(d.sources.added.length, 1);
  assert.equal(d.answer.added, 1);
  assert.equal(d.answer.removed, 1);
});

test("renderDiffText: surfaces ids, model change, source + line deltas", () => {
  const a = rec({ answer: "alpha\nbeta", sources: [src(1, "https://a.com")] });
  const b = rec({
    id: "2026-06-01_120000_bbbbbbbb",
    answer: "alpha\nGAMMA",
    sources: [src(1, "https://a.com"), src(2, "https://new.com")],
    llm: { baseUrl: "http://localhost:3456", model: "claude-opus-4-7" },
  });
  const text = renderDiffText(diffSessions(a, b), { color: false });
  assert.match(text, /2026-05-01_120000_aaaaaaaa/);
  assert.match(text, /2026-06-01_120000_bbbbbbbb/);
  assert.match(text, /claude-sonnet-4-6.*claude-opus-4-7/s);
  assert.match(text, /\+ https:\/\/new\.com/);
  assert.match(text, /\+ GAMMA/);
  assert.match(text, /- beta/);
});

test("renderDiffText: identical answers say so", () => {
  const a = rec();
  const b = rec({ id: "2026-06-01_120000_bbbbbbbb" });
  const text = renderDiffText(diffSessions(a, b), { color: false });
  assert.match(text, /answer text identical/);
});

// ── narration prompt ─────────────────────────────────────────────────────────

test("buildDiffNarrateUser: includes both answers and the ask", () => {
  const a = rec({ answer: "old answer" });
  const b = rec({ id: "x", answer: "new answer" });
  const msg = buildDiffNarrateUser(a, b);
  assert.match(msg, /old answer/);
  assert.match(msg, /new answer/);
  assert.match(msg, /Summarize what changed/);
});
