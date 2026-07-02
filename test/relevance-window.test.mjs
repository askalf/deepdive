import test from "node:test";
import assert from "node:assert/strict";
import { selectRelevantWindow } from "../dist/relevance-window.js";
import { extractContent } from "../dist/extract.js";
import { extractKeywords } from "../dist/query-keywords.js";

// Synthetic formal document in the shape that motivated #145: a long run of
// front matter (title, authors, abstract, ToC — no query terms), then the
// normative body deep past any head-first cap.
function formalDoc({ frontWords = 2600, tailWords = 800 } = {}) {
  const front = Array.from({ length: frontWords }, (_, i) => `front${i}`);
  const body =
    "Verifiers and CSPs SHALL NOT impose other composition rules for passwords. " +
    "Verifiers SHALL NOT require passwords to be changed periodically unless there " +
    "is evidence of compromise of the password.";
  const tail = Array.from({ length: tailWords }, (_, i) => `tail${i}`);
  return [...front, body, ...tail].join(" ");
}

const QUESTION_TERMS = extractKeywords(
  "What are the requirements on password composition rules and periodic rotation for verifiers?",
);

test("selectRelevantWindow: under the cap returns the text untruncated", () => {
  const text = "alpha beta gamma delta";
  const r = selectRelevantWindow(text, ["gamma"], 100);
  assert.equal(r.truncated, false);
  assert.equal(r.text, text);
  assert.equal(r.wordCount, 4);
});

test("selectRelevantWindow: reaches normative text a head-first cap misses", () => {
  const doc = formalDoc();
  const cap = 2000;
  // The pre-#145 behavior: first 2000 words are all front matter.
  const headFirst = doc.split(/\s+/).slice(0, cap).join(" ");
  assert.ok(!/SHALL NOT/.test(headFirst), "fixture: body must lie past the cap");

  const r = selectRelevantWindow(doc, QUESTION_TERMS, cap);
  assert.equal(r.truncated, true);
  assert.ok(r.wordCount <= cap);
  assert.match(r.text, /SHALL NOT impose other composition rules/);
  assert.match(r.text, /changed periodically/);
});

test("selectRelevantWindow: keeps a head anchor for document identity", () => {
  const r = selectRelevantWindow(formalDoc(), QUESTION_TERMS, 2000);
  assert.ok(r.text.startsWith("front0 front1"), "head anchor preserved");
});

test("selectRelevantWindow: marks elisions between non-contiguous spans", () => {
  const r = selectRelevantWindow(formalDoc(), QUESTION_TERMS, 600);
  assert.ok(r.text.includes("…"), "gap between anchor and deep body is marked");
});

test("selectRelevantWindow: no terms degrades to the head-first cap", () => {
  const doc = formalDoc();
  const cap = 500;
  const r = selectRelevantWindow(doc, [], cap);
  assert.equal(r.text, doc.split(/\s+/).slice(0, cap).join(" ") + " …");
  assert.equal(r.truncated, true);
});

test("selectRelevantWindow: no matching terms also degrades head-first via doc-order fill", () => {
  const doc = formalDoc();
  const cap = 500;
  const r = selectRelevantWindow(doc, ["zzz-nomatch"], cap);
  // Windows all score 0 → anchor + document-order fill = a head prefix.
  assert.ok(r.text.startsWith("front0"));
  assert.ok(!/SHALL NOT/.test(r.text));
});

test("selectRelevantWindow: deterministic", () => {
  const doc = formalDoc();
  const a = selectRelevantWindow(doc, QUESTION_TERMS, 1000);
  const b = selectRelevantWindow(doc, QUESTION_TERMS, 1000);
  assert.deepEqual(a, b);
});

test("selectRelevantWindow: selected spans stay in document order", () => {
  const doc = formalDoc();
  const r = selectRelevantWindow(doc, QUESTION_TERMS, 2000);
  const iFront = r.text.indexOf("front0");
  const iBody = r.text.indexOf("SHALL NOT");
  assert.ok(iFront !== -1 && iBody !== -1 && iFront < iBody);
});

test("extractContent: relevanceTerms reach a deep paragraph the head cap drops", () => {
  // Paragraphs must pass isMeaningfulParagraph (>=40 chars, >=8 words).
  const filler = Array.from(
    { length: 260 },
    (_, i) =>
      `Filler paragraph number ${i} contains routine introductory material about the document structure and scope.`,
  );
  const target =
    "Verifiers and CSPs SHALL NOT impose other composition rules for passwords and SHALL NOT require periodic rotation without evidence of compromise.";
  const raw = [...filler, target].join("\n\n");

  const without = extractContent(raw, "t", 1000);
  assert.ok(!/SHALL NOT/.test(without.text), "head-first cap misses the target");

  const withTerms = extractContent(raw, "t", 1000, QUESTION_TERMS);
  assert.equal(withTerms.truncated, true);
  assert.match(withTerms.text, /SHALL NOT impose other composition rules/);
});

test("extractContent: without relevanceTerms behavior is unchanged", () => {
  const raw = Array.from(
    { length: 50 },
    (_, i) =>
      `Paragraph ${i} carries enough ordinary words to count as meaningful content here.`,
  ).join("\n\n");
  const a = extractContent(raw, "t", 100);
  assert.equal(a.truncated, true);
  assert.ok(a.text.endsWith(" …"));
});
