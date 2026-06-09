// HTML export — self-contained shareable report rendering.

import { test } from "node:test";
import assert from "node:assert/strict";
import { renderHtmlReport } from "../dist/html-export.js";

function makeRecord(overrides = {}) {
  return {
    schema: 1,
    id: "2026-05-07_120000_aabbccdd",
    createdAt: Date.UTC(2026, 4, 7, 12, 0, 0),
    question: "how does claude's rate limiter work",
    plan: { reasoning: "split", queries: ["q1"] },
    rounds: [{ round: 0, queries: ["q1"], candidatesFound: 2, fetched: 2, kept: 2 }],
    sources: [
      { id: 1, url: "https://docs.anthropic.com/x", title: "Rate limits", fetchedAt: Date.UTC(2026, 4, 7, 11, 0, 0), content: "..." },
      { id: 2, url: "https://example.com/y", title: "Headers", fetchedAt: Date.UTC(2026, 4, 7, 11, 0, 0), content: "..." },
    ],
    answer: "Claude uses a **two-tier** rolling window [1]. The header switches at the boundary [2].",
    cost: { amountUsd: 0.0085, knownModel: true, inputTokens: 412, outputTokens: 234, calls: 4 },
    llm: { baseUrl: "http://localhost:3456", model: "claude-sonnet-4-6" },
    ...overrides,
  };
}

test("renderHtmlReport: produces a complete, self-contained document", () => {
  const html = renderHtmlReport(makeRecord());
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<\/html>\s*$/);
  assert.match(html, /<style>/); // inline CSS, no external assets
  assert.ok(!html.includes("<script"), "exported report must contain no scripts");
  assert.ok(!html.includes('src="http'), "no remote asset references");
});

test("renderHtmlReport: title + question come from the record", () => {
  const html = renderHtmlReport(makeRecord());
  // The apostrophe is HTML-escaped — that's the safe, correct rendering.
  assert.match(html, /<title>how does claude&#39;s rate limiter work<\/title>/);
  assert.match(html, /<h1>how does claude&#39;s rate limiter work<\/h1>/);
});

test("renderHtmlReport: answer markdown is rendered, cites link to sources", () => {
  const html = renderHtmlReport(makeRecord());
  assert.match(html, /<strong>two-tier<\/strong>/);
  assert.match(html, /href="#source-1"/);
  assert.match(html, /href="#source-2"/);
});

test("renderHtmlReport: sources list carries anchors matching the cite ids", () => {
  const html = renderHtmlReport(makeRecord());
  assert.match(html, /<li id="source-1"><a href="https:\/\/docs\.anthropic\.com\/x"/);
  assert.match(html, /<li id="source-2"><a href="https:\/\/example\.com\/y"/);
});

test("renderHtmlReport: meta line shows model, date, source count, cost", () => {
  const html = renderHtmlReport(makeRecord());
  assert.match(html, /class="meta"/);
  assert.match(html, /2026-05-07/);
  assert.match(html, /claude-sonnet-4-6/);
  assert.match(html, /2 sources/);
  assert.match(html, /\$0\.0085/);
});

test("renderHtmlReport: footer credit present by default, suppressible", () => {
  assert.match(renderHtmlReport(makeRecord()), /Sprayberry Labs/);
  assert.ok(!renderHtmlReport(makeRecord(), { footer: "" }).includes("<footer>"));
});

test("renderHtmlReport: a malicious title/source can't inject markup", () => {
  const html = renderHtmlReport(
    makeRecord({
      question: "<img src=x onerror=alert(1)>",
      sources: [{ id: 1, url: "https://x.com", title: "</title><script>bad()</script>", fetchedAt: Date.now(), content: "" }],
      answer: "ok [1]",
    }),
  );
  assert.ok(!html.includes("<script>bad"), "source title must be escaped");
  assert.ok(!html.includes("<img src=x"), "question must be escaped");
  assert.match(html, /&lt;img src=x/);
});

test("renderHtmlReport: empty source list omits the Sources section", () => {
  const html = renderHtmlReport(makeRecord({ sources: [], answer: "no sources" }));
  assert.ok(!html.includes("<h2>Sources</h2>"));
});
