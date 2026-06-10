// Heading slugs, extractHeadings, and the HTML export's table of contents.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  markdownToHtml,
  extractHeadings,
  headingPlainText,
  slugify,
} from "../dist/markdown.js";
import { renderHtmlReport } from "../dist/html-export.js";

// ── slugify / headingPlainText ───────────────────────────────────────────────

test("slugify: lowercases, dashes non-alphanumerics, trims, never empty", () => {
  assert.equal(slugify("How It Works"), "how-it-works");
  assert.equal(slugify("  C# & .NET — 2026!  "), "c-net-2026");
  assert.equal(slugify("???"), "section");
});

test("headingPlainText: strips code, links, emphasis, and citation runs", () => {
  assert.equal(headingPlainText("The `tokenBucket()` API"), "The tokenBucket() API");
  assert.equal(headingPlainText("**Bold** and *italic* bits"), "Bold and italic bits");
  assert.equal(headingPlainText("See [the docs](https://x.com) here"), "See the docs here");
  assert.equal(headingPlainText("Rate limits [1][2]"), "Rate limits");
});

// ── extractHeadings ──────────────────────────────────────────────────────────

test("extractHeadings: levels, plain text, document order", () => {
  const md = "## Alpha\n\ntext\n\n### Beta `x`\n\n## Gamma [1]";
  assert.deepEqual(extractHeadings(md), [
    { level: 2, text: "Alpha", slug: "alpha" },
    { level: 3, text: "Beta x", slug: "beta-x" },
    { level: 2, text: "Gamma", slug: "gamma" },
  ]);
});

test("extractHeadings: duplicate headings get -2/-3 suffixes", () => {
  const md = "## Setup\n\n## Setup\n\n## Setup";
  assert.deepEqual(
    extractHeadings(md).map((h) => h.slug),
    ["setup", "setup-2", "setup-3"],
  );
});

test("extractHeadings: skips headings inside fenced code blocks", () => {
  const md = "## Real\n\n```\n## not a heading\n```\n\n## Also real";
  assert.deepEqual(
    extractHeadings(md).map((h) => h.slug),
    ["real", "also-real"],
  );
});

// ── markdownToHtml heading ids ───────────────────────────────────────────────

test("markdownToHtml: headingIds emits matching ids; off by default", () => {
  const md = "## How It Works";
  assert.equal(markdownToHtml(md), "<h2>How It Works</h2>");
  assert.equal(markdownToHtml(md, { headingIds: true }), '<h2 id="how-it-works">How It Works</h2>');
});

test("markdownToHtml + extractHeadings agree on duplicate slugs", () => {
  const md = "## Setup\n\nx\n\n## Setup";
  const html = markdownToHtml(md, { headingIds: true });
  const heads = extractHeadings(md);
  for (const h of heads) {
    assert.ok(html.includes(`id="${h.slug}"`), `html should contain id ${h.slug}`);
  }
});

// ── HTML export TOC ──────────────────────────────────────────────────────────

function record(answer) {
  return {
    schema: 1,
    id: "2026-06-09_120000_aaaa1111",
    createdAt: Date.UTC(2026, 5, 9),
    question: "q",
    plan: { reasoning: "", queries: [] },
    rounds: [],
    sources: [],
    answer,
    cost: { amountUsd: 0 },
    llm: { baseUrl: "x", model: "m" },
  };
}

test("renderHtmlReport: TOC appears with 3+ h2/h3 and links to heading ids", () => {
  const html = renderHtmlReport(
    record("## One\n\na\n\n## Two\n\nb\n\n### Two point five\n\nc\n\n## Three"),
  );
  assert.match(html, /<nav class="toc">/);
  assert.match(html, /href="#one"/);
  assert.match(html, /class="toc-l3"><a href="#two-point-five"/);
  assert.match(html, /<h2 id="one">/);
});

test("renderHtmlReport: no TOC for short answers", () => {
  const html = renderHtmlReport(record("## Only\n\nshort answer\n\n## Two"));
  assert.ok(!html.includes('class="toc"'));
});

test("renderHtmlReport: TOC labels are escaped", () => {
  const html = renderHtmlReport(
    record("## <img src=x>\n\na\n\n## Two\n\nb\n\n## Three\n\nc"),
  );
  assert.ok(!html.includes("<img src=x"));
  assert.match(html, /&lt;img src=x&gt;/);
});
