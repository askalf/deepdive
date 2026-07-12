// Fuzz the content extractor — the regex-heavy pipeline every fetched page's
// text passes through (normalizeWhitespace → paragraph split →
// isMeaningfulParagraph → relevance-window clamp). The page is hostile input.
// Contract: extractContent never throws on any text/title/terms combination,
// always returns strings for title/text, a finite non-negative wordCount, and
// a boolean truncated flag. A pathological-backtracking regex in this path
// shows up here as a fuzzer timeout.
import {
  extractContent,
  normalizeWhitespace,
  isMeaningfulParagraph,
} from "../dist/extract.js";

function assertShape(r, label) {
  if (!r || typeof r.title !== "string" || typeof r.text !== "string") {
    throw new Error(`${label}: title/text not strings`);
  }
  if (!Number.isFinite(r.wordCount) || r.wordCount < 0) {
    throw new Error(`${label}: bad wordCount ${r.wordCount}`);
  }
  if (typeof r.truncated !== "boolean") {
    throw new Error(`${label}: truncated not boolean`);
  }
}

export function fuzz(data) {
  const s = data.toString("utf8");

  if (typeof normalizeWhitespace(s) !== "string") {
    throw new Error("normalizeWhitespace returned a non-string");
  }
  if (typeof isMeaningfulParagraph(s.slice(0, 4096)) !== "boolean") {
    throw new Error("isMeaningfulParagraph returned a non-boolean");
  }

  // Small budgets force the truncation branch; input-derived relevance terms
  // force the selectRelevantWindow branch (#145) on the same hostile text.
  const maxWords = (data.length % 97) + 1;
  const terms = s.slice(0, 64).split(/\s+/).filter(Boolean).slice(0, 5);
  assertShape(extractContent(s, s.slice(0, 80), maxWords), "plain clamp");
  if (terms.length > 0) {
    assertShape(extractContent(s, "", maxWords, terms), "relevance window");
  }
}
