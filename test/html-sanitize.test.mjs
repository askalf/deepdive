import test from "node:test";
import assert from "node:assert/strict";
import {
  decodeHtmlEntities,
  stripTags,
} from "../dist/search/duckduckgo.js";

test("decodeHtmlEntities: named entities", () => {
  assert.equal(decodeHtmlEntities("a &amp; b"), "a & b");
  assert.equal(decodeHtmlEntities("&lt;div&gt;"), "<div>");
  assert.equal(decodeHtmlEntities("&quot;hi&quot;"), '"hi"');
  assert.equal(decodeHtmlEntities("it&apos;s"), "it's");
  assert.equal(decodeHtmlEntities("a&nbsp;b"), "a b");
});

test("decodeHtmlEntities: numeric entities", () => {
  assert.equal(decodeHtmlEntities("&#39;"), "'");
  assert.equal(decodeHtmlEntities("&#38;"), "&");
  assert.equal(decodeHtmlEntities("&#x2F;"), "/");
  assert.equal(decodeHtmlEntities("&#x27;"), "'");
});

test("decodeHtmlEntities: single-pass — &amp;#39; stays as &#39; (no double-decode)", () => {
  // The double-decode would produce `'`. Single-pass produces `&#39;`.
  assert.equal(decodeHtmlEntities("&amp;#39;"), "&#39;");
});

test("decodeHtmlEntities: unknown named entity left as-is", () => {
  assert.equal(decodeHtmlEntities("&madeupentity;"), "&madeupentity;");
});

test("decodeHtmlEntities: invalid numeric code left as-is", () => {
  assert.equal(decodeHtmlEntities("&#999999999;"), "&#999999999;");
});

test("decodeHtmlEntities: case-insensitive named entities", () => {
  assert.equal(decodeHtmlEntities("&AMP;"), "&");
  assert.equal(decodeHtmlEntities("&Amp;"), "&");
});

test("stripTags: strips well-formed tags", () => {
  assert.equal(stripTags("<b>hi</b>").trim(), "hi");
  assert.equal(stripTags("<a href='x'>link</a>").trim(), "link");
});

test("stripTags: malformed/partial tag — stray `<` is defused", () => {
  // `<scrip` with no closing `>`: the safe behavior is to NOT leave `<scrip`
  // in the output where it could be picked up as a tag opener elsewhere.
  const out = stripTags("safe text <scrip never closed");
  assert.ok(!out.includes("<"), `expected no '<' in output, got: ${JSON.stringify(out)}`);
  assert.ok(out.includes("safe text"), "legitimate text preserved");
});

test("stripTags: empty string returns empty", () => {
  assert.equal(stripTags(""), "");
});

test("stripTags: text with no tags preserved", () => {
  assert.equal(stripTags("plain prose about a topic"), "plain prose about a topic");
});
