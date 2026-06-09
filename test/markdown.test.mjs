// Hand-rolled Markdown → HTML renderer.

import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, renderInline, escapeHtml } from "../dist/markdown.js";

// ── escapeHtml ───────────────────────────────────────────────────────────────

test("escapeHtml: escapes the five significant characters", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
});

// ── inline ───────────────────────────────────────────────────────────────────

test("renderInline: bold, italic, code", () => {
  assert.equal(renderInline("a **b** c"), "a <strong>b</strong> c");
  assert.equal(renderInline("a *b* c"), "a <em>b</em> c");
  assert.equal(renderInline("a `code` c"), "a <code>code</code> c");
});

test("renderInline: a bare number is never mistaken for a placeholder", () => {
  // The parking scheme must not collide with literal digits in the text.
  assert.equal(renderInline("revenue grew in 2024 by `10`%"), "revenue grew in 2024 by <code>10</code>%");
});

test("renderInline: code content is not re-processed for emphasis", () => {
  assert.equal(renderInline("`a*b*c`"), "<code>a*b*c</code>");
});

test("renderInline: safe links become anchors, unsafe ones stay literal", () => {
  assert.equal(
    renderInline("see [docs](https://x.com/y)"),
    'see <a href="https://x.com/y" rel="noopener noreferrer">docs</a>',
  );
  // javascript: is not in the allowlist — no anchor is emitted.
  const unsafe = renderInline("[x](javascript:alert(1))");
  assert.ok(!unsafe.includes("<a "), `expected no anchor, got: ${unsafe}`);
  assert.ok(unsafe.includes("javascript:alert(1)"));
});

test("renderInline: citations become superscript anchors when a prefix is set", () => {
  const out = renderInline("X happened [1][3].", { citationAnchorPrefix: "source-" });
  assert.equal(
    out,
    'X happened <sup class="cite"><a href="#source-1">1</a><a href="#source-3">3</a></sup>.',
  );
});

test("renderInline: citations render as plain superscript with no prefix", () => {
  assert.equal(renderInline("X [2]."), 'X <sup class="cite">[2]</sup>.');
});

test("renderInline: a [N] immediately before ( is left alone (link-like)", () => {
  // Should not be turned into a citation superscript.
  const out = renderInline("see [1](https://x.com)", { citationAnchorPrefix: "source-" });
  assert.equal(out, 'see <a href="https://x.com" rel="noopener noreferrer">1</a>');
});

// ── blocks ───────────────────────────────────────────────────────────────────

test("markdownToHtml: headings by level", () => {
  assert.equal(markdownToHtml("# Title"), "<h1>Title</h1>");
  assert.equal(markdownToHtml("### Sub"), "<h3>Sub</h3>");
});

test("markdownToHtml: paragraphs separated by blank lines", () => {
  assert.equal(markdownToHtml("one\n\ntwo"), "<p>one</p>\n<p>two</p>");
});

test("markdownToHtml: wrapped paragraph lines join with a space", () => {
  assert.equal(markdownToHtml("one\ntwo"), "<p>one two</p>");
});

test("markdownToHtml: unordered + ordered lists", () => {
  assert.equal(markdownToHtml("- a\n- b"), "<ul>\n<li>a</li>\n<li>b</li>\n</ul>");
  assert.equal(markdownToHtml("1. a\n2. b"), "<ol>\n<li>a</li>\n<li>b</li>\n</ol>");
});

test("markdownToHtml: fenced code block escapes its body", () => {
  assert.equal(markdownToHtml("```\n<b> & x\n```"), "<pre><code>&lt;b&gt; &amp; x</code></pre>");
});

test("markdownToHtml: horizontal rule", () => {
  assert.equal(markdownToHtml("---"), "<hr>");
});

test("markdownToHtml: GFM table", () => {
  const md = "| A | B |\n|---|---|\n| 1 | 2 |";
  const html = markdownToHtml(md);
  assert.match(html, /<table>/);
  assert.match(html, /<th>A<\/th><th>B<\/th>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test("markdownToHtml: blockquote", () => {
  assert.equal(markdownToHtml("> quoted"), "<blockquote><p>quoted</p></blockquote>");
});

test("markdownToHtml: unknown construct falls through as an escaped paragraph", () => {
  // A stray HTML-ish line should be escaped, never emitted raw.
  assert.equal(markdownToHtml("<script>x</script>"), "<p>&lt;script&gt;x&lt;/script&gt;</p>");
});

test("markdownToHtml: a realistic answer with cites round-trips cleanly", () => {
  const md = "Claude uses a **two-tier** window [1].\n\n## Details\n\n- 5-hour bucket [2]\n- 7-day bucket [3]";
  const html = markdownToHtml(md, { citationAnchorPrefix: "source-" });
  assert.match(html, /<strong>two-tier<\/strong>/);
  assert.match(html, /<h2>Details<\/h2>/);
  assert.match(html, /href="#source-2"/);
  assert.match(html, /<ul>/);
});
