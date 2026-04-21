import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractContent,
  normalizeWhitespace,
  isMeaningfulParagraph,
} from "../dist/extract.js";

test("normalizeWhitespace: collapses tabs, nbsp, multi-spaces to single spaces", () => {
  const out = normalizeWhitespace("a\t b\u00a0 c   d");
  assert.equal(out, "a b c d");
});

test("normalizeWhitespace: 3+ blank lines collapse to exactly one blank line", () => {
  const out = normalizeWhitespace("one\n\n\n\n\ntwo");
  assert.equal(out, "one\n\ntwo");
});

test("normalizeWhitespace: trims leading/trailing whitespace", () => {
  assert.equal(normalizeWhitespace("\n\n  hi  \n\n"), "hi");
});

test("isMeaningfulParagraph: drops paragraphs under 40 chars", () => {
  assert.equal(isMeaningfulParagraph("short and sweet text"), false);
});

test("isMeaningfulParagraph: drops paragraphs under 8 words", () => {
  assert.equal(
    isMeaningfulParagraph("averylongsinglewordthatshouldnotcount verylongword"),
    false,
  );
});

test("isMeaningfulParagraph: keeps real prose", () => {
  const para =
    "The rate limiter uses a sliding window of five hours that resets on every " +
    "eligible request and factors the user's plan into its headroom calculation.";
  assert.equal(isMeaningfulParagraph(para), true);
});

test("isMeaningfulParagraph: drops cookie banners", () => {
  const banner =
    "We use cookies to improve your experience. By using our site you agree.";
  assert.equal(isMeaningfulParagraph(banner), false);
});

test("extractContent: truncates at maxWords and marks truncated", () => {
  // Build a paragraph long enough to pass the paragraph filter so we
  // have enough words to actually exceed a small maxWords.
  const longPara = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const ex = extractContent(longPara, "T", 50);
  assert.equal(ex.truncated, true);
  assert.equal(ex.wordCount, 50);
  assert.match(ex.text, / …$/);
});

test("extractContent: returns full text when under limit", () => {
  // Hit the paragraph filter (>=40 chars, >=8 words, not chrome-shaped).
  const para =
    "This is a complete substantive paragraph containing plenty of words to clear the floor.";
  const ex = extractContent(para, "T", 500);
  assert.equal(ex.truncated, false);
  assert.ok(ex.wordCount >= 8);
  assert.ok(!ex.text.endsWith("…"));
});

test("extractContent: empty input produces empty output (no crash)", () => {
  const ex = extractContent("", "T", 100);
  assert.equal(ex.text, "");
  assert.equal(ex.wordCount, 0);
  assert.equal(ex.truncated, false);
});
