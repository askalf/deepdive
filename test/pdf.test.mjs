// PDF extraction — pure-function tests for the helpers, plus an
// end-to-end test that builds a minimal valid one-page PDF in-memory and
// runs it through extractPdfText.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPdfText,
  isPdfExtractorAvailable,
  looksLikePdf,
  joinTextItems,
  dedupeRunningHeadersFooters,
  PdfExtractorMissingError,
} from "../dist/pdf.js";

// ── looksLikePdf ────────────────────────────────────────────────────────────

test("looksLikePdf: detects by URL extension", () => {
  assert.equal(looksLikePdf({ url: "https://x/y.pdf" }), true);
  assert.equal(looksLikePdf({ url: "https://x/y.PDF" }), true);
  assert.equal(looksLikePdf({ url: "https://x/y.pdf?download=1" }), true);
  assert.equal(looksLikePdf({ url: "https://x/y.pdf#page=2" }), true);
  assert.equal(looksLikePdf({ url: "https://x/y.html" }), false);
});

test("looksLikePdf: detects by content-type header", () => {
  assert.equal(looksLikePdf({ contentType: "application/pdf" }), true);
  assert.equal(looksLikePdf({ contentType: "application/pdf; charset=binary" }), true);
  assert.equal(looksLikePdf({ contentType: "text/html" }), false);
});

test("looksLikePdf: prefers finalUrl when set", () => {
  // Initial URL is a redirect endpoint; final URL is the PDF.
  assert.equal(
    looksLikePdf({ url: "https://x/redirect", finalUrl: "https://x/paper.pdf" }),
    true,
  );
});

// ── joinTextItems ───────────────────────────────────────────────────────────

test("joinTextItems: concatenates with spaces and respects hasEOL", () => {
  const items = [
    { str: "Hello" },
    { str: "world" },
    { str: "", hasEOL: true },
    { str: "next" },
    { str: "line" },
  ];
  const out = joinTextItems(items);
  assert.equal(out, "Hello world\nnext line");
});

test("joinTextItems: collapses runs of whitespace", () => {
  const items = [{ str: "a   b" }, { str: "c" }];
  const out = joinTextItems(items);
  assert.equal(out, "a b c");
});

// ── dedupeRunningHeadersFooters ─────────────────────────────────────────────

test("dedupeRunningHeadersFooters: drops a header that appears on every page", () => {
  const pages = [
    "MyPaper v1\nIntroduction\nstuff happens here.",
    "MyPaper v1\nMethods\nmethods text.",
    "MyPaper v1\nResults\nresults text.",
    "MyPaper v1\nDiscussion\ndiscussion text.",
  ];
  const out = dedupeRunningHeadersFooters(pages);
  for (const p of out) {
    assert.ok(!p.includes("MyPaper v1"), `header should be dropped: ${p}`);
  }
});

test("dedupeRunningHeadersFooters: keeps lines that vary across pages", () => {
  const pages = [
    "Page 1\nfoo",
    "Page 2\nbar",
    "Page 3\nbaz",
  ];
  const out = dedupeRunningHeadersFooters(pages);
  assert.ok(out[0].includes("Page 1"));
  assert.ok(out[1].includes("Page 2"));
});

test("dedupeRunningHeadersFooters: no-op on <3 pages", () => {
  const pages = ["a\nshared", "b\nshared"];
  const out = dedupeRunningHeadersFooters(pages);
  assert.deepEqual(out, pages);
});

// ── isPdfExtractorAvailable ─────────────────────────────────────────────────

test("isPdfExtractorAvailable: returns true when pdfjs-dist is installed", async () => {
  // pdfjs-dist is a devDependency, so this should be true in CI/local.
  assert.equal(await isPdfExtractorAvailable(), true);
});

// ── extractPdfText (end-to-end against a minimal PDF) ───────────────────────

// Builds a minimal one-page text-bearing PDF in-memory. Returns a Uint8Array.
// PDF format: header + 5 indirect objects (catalog, pages, page, contents,
// font) + xref + trailer.
function makeMinimalPdf(text) {
  const enc = new TextEncoder();
  const objs = [
    "<</Type/Catalog/Pages 2 0 R>>",
    "<</Type/Pages/Count 1/Kids[3 0 R]>>",
    "<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>",
    null, // contents — built below so we can compute its Length
    "<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>",
  ];
  const stream = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, "\\$&")}) Tj ET`;
  objs[3] = `<</Length ${stream.length}>>\nstream\n${stream}\nendstream`;

  let body = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  const offsets = [0];
  for (let i = 0; i < objs.length; i++) {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${objs[i]}\nendobj\n`;
  }
  const xrefOffset = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objs.length; i++) {
    body += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  }
  body += `trailer\n<</Size ${objs.length + 1}/Root 1 0 R>>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return enc.encode(body);
}

test("extractPdfText: round-trips visible text through pdfjs-dist", async () => {
  const bytes = makeMinimalPdf("HelloDeepdive worldFromPdf");
  const result = await extractPdfText(bytes);
  assert.equal(result.pageCount, 1);
  assert.equal(result.parsedPages, 1);
  assert.equal(result.truncated, false);
  assert.match(result.text, /HelloDeepdive/);
  assert.match(result.text, /worldFromPdf/);
});

test("extractPdfText: PdfExtractorMissingError class is exported and named", () => {
  const err = new PdfExtractorMissingError();
  assert.equal(err.name, "PdfExtractorMissingError");
  assert.match(err.message, /pdfjs-dist not installed/);
});
