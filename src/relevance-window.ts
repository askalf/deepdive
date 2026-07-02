// Query-relevance windowing for the per-source word cap (#145).
//
// Head-first truncation (`words.slice(0, maxWords)`) reduces long formal
// documents — NIST/ISO/IETF publications, arxiv PDFs, long HTML specs — to
// their LEAST informative span: title page, authors, abstract, table of
// contents. The live run that motivated this fetched the 129-page NIST SP
// 800-63B-4 PDF, extracted all 18,265 words flawlessly, then capped to the
// first 2,000 — and the synthesizer, correctly refusing to cite what it
// couldn't see, answered from front matter only.
//
// Instead, when content exceeds the cap, spend the budget on the spans most
// lexically relevant to the research question and the round's queries:
//
//   1. Always keep a head anchor (title/lead context — the synth needs to
//      know what document it is reading).
//   2. Score fixed-size word windows over the whole document by overlap with
//      the query terms (same token machinery as the keyword ladder / #86).
//   3. Keep the best-scoring windows, then fill any remaining budget in
//      document order; reassemble chronologically with elision markers.
//
// Deterministic, LLM-free, zero new dependencies. With no query terms (or no
// matches) it degrades to exactly the old head-first behavior.

import { trimPunctuation } from "./query-keywords.js";

export interface WindowedSelection {
  text: string;
  wordCount: number;
  truncated: boolean;
}

// Document head always kept for context (capped at half the budget so tiny
// budgets still leave room for relevant spans).
const ANCHOR_WORDS = 200;
// Scoring granule. Small enough to isolate a relevant subsection, large
// enough that a kept window reads as coherent prose.
const WINDOW_WORDS = 150;

function normalizeToken(w: string): string {
  return trimPunctuation(w).toLowerCase();
}

/**
 * Select up to `maxWords` words from `text`, preferring spans that share
 * terms with `terms`. Under the cap, returns the text unchanged (modulo
 * whitespace normalization from the word split).
 */
export function selectRelevantWindow(
  text: string,
  terms: string[],
  maxWords: number,
): WindowedSelection {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length <= maxWords) {
    return { text: words.join(" "), wordCount: words.length, truncated: false };
  }

  const termSet = new Set(
    terms.map(normalizeToken).filter((t) => t.length >= 2),
  );
  if (termSet.size === 0) {
    // No signal to rank by — identical to the pre-#145 head-first cap.
    return {
      text: words.slice(0, maxWords).join(" ") + " …",
      wordCount: maxWords,
      truncated: true,
    };
  }

  const anchorWords = Math.min(ANCHOR_WORDS, Math.floor(maxWords / 2));

  // Fixed, non-overlapping windows; ties resolve to the earlier window so
  // selection is deterministic and stable.
  interface Win {
    start: number;
    length: number;
    score: number;
  }
  const wins: Win[] = [];
  for (let start = 0; start < words.length; start += WINDOW_WORDS) {
    const slice = words.slice(start, start + WINDOW_WORDS);
    let matches = 0;
    const distinct = new Set<string>();
    for (const w of slice) {
      const norm = normalizeToken(w);
      if (termSet.has(norm)) {
        matches++;
        distinct.add(norm);
      }
    }
    // Distinct-term coverage outweighs repetition: a window mentioning three
    // different query terms once each beats one term repeated three times.
    wins.push({
      start,
      length: slice.length,
      score: matches + 2 * distinct.size,
    });
  }

  const selected = new Set<Win>();
  let budget = maxWords;

  // 1. Head anchor.
  for (const w of wins) {
    if (w.start < anchorWords && budget >= w.length) {
      selected.add(w);
      budget -= w.length;
    }
  }
  // 2. Best-scoring windows.
  const byScore = wins
    .filter((w) => !selected.has(w) && w.score > 0)
    .sort((a, b) => b.score - a.score || a.start - b.start);
  for (const w of byScore) {
    if (budget < w.length) continue;
    selected.add(w);
    budget -= w.length;
  }
  // 3. Spend any remaining budget in document order (keeps behavior close to
  //    head-first for documents where matches are sparse).
  for (const w of wins) {
    if (selected.has(w)) continue;
    if (budget < w.length) break;
    selected.add(w);
    budget -= w.length;
  }

  // Reassemble in document order, marking elisions between non-contiguous
  // runs so the synthesizer knows material was skipped.
  const ordered = [...selected].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  let expectedStart = 0;
  let kept = 0;
  for (const w of ordered) {
    if (w.start > expectedStart) parts.push("…");
    parts.push(words.slice(w.start, w.start + w.length).join(" "));
    expectedStart = w.start + w.length;
    kept += w.length;
  }
  if (expectedStart < words.length) parts.push("…");

  return { text: parts.join(" "), wordCount: kept, truncated: true };
}
