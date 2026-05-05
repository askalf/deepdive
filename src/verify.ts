// Citation verifier — lexical sanity check on the synthesized answer.
//
// After the synthesizer produces a draft, every sentence that contains an
// inline [N] reference is checked against the extracted text of source N.
// If too few of the sentence's content tokens appear in the cited source,
// the citation is flagged as weak — the most common signature of a
// hallucinated reference.
//
// Multi-cite rule: a sentence with [1][3] is supported only when BOTH cites
// individually clear the recall threshold. A bogus cite buried inside an
// otherwise-true sentence is still a problem worth surfacing.
//
// This module is pure: no LLM, no network, no disk. All five helpers are
// exported for unit tests.

import type { SourceWithContent } from "./synthesize.js";

export const DEFAULT_CITE_MIN_RECALL = 0.4;

export interface CitationCheck {
  sentence: string;
  citedIds: number[];
  unsupportedIds: number[];
  recallByCite: Record<number, number>;
  supported: boolean;
}

export interface VerificationReport {
  threshold: number;
  totalCitations: number;
  supportedCitations: number;
  checks: CitationCheck[];
  unsupported: CitationCheck[];
}

export interface VerifyOptions {
  threshold?: number;
}

export function verifyCitations(
  answer: string,
  sources: SourceWithContent[],
  opts: VerifyOptions = {},
): VerificationReport {
  const threshold = opts.threshold ?? DEFAULT_CITE_MIN_RECALL;
  const body = stripSourcesBlock(answer);
  const sentences = splitSentences(body);

  const sourceTokens = new Map<number, Set<string>>();
  for (const s of sources) {
    sourceTokens.set(s.id, new Set(contentTokens(s.content)));
  }

  const checks: CitationCheck[] = [];
  let totalCitations = 0;
  let supportedCitations = 0;

  for (const sentence of sentences) {
    const citedIds = extractCiteIds(sentence);
    if (citedIds.length === 0) continue;

    const claimTokens = contentTokens(sentence);
    const recallByCite: Record<number, number> = {};
    const unsupportedIds: number[] = [];

    for (const id of citedIds) {
      const tokens = sourceTokens.get(id);
      const r = tokens ? recall(claimTokens, tokens) : 0;
      recallByCite[id] = r;
      totalCitations += 1;
      if (r >= threshold) {
        supportedCitations += 1;
      } else {
        unsupportedIds.push(id);
      }
    }

    checks.push({
      sentence: sentence.trim(),
      citedIds,
      unsupportedIds,
      recallByCite,
      supported: unsupportedIds.length === 0,
    });
  }

  return {
    threshold,
    totalCitations,
    supportedCitations,
    checks,
    unsupported: checks.filter((c) => !c.supported),
  };
}

// Strips an appended "## Sources" block (and anything after it) from the
// answer. The synthesizer is told not to emit this section, but the agent
// appends one — defend against either case.
export function stripSourcesBlock(answer: string): string {
  const m = /(^|\n)##\s+Sources\b/i.exec(answer);
  return m ? answer.slice(0, m.index).trimEnd() : answer;
}

// Splits text into sentences. Handles `.!?` followed by whitespace, leaves
// the trailing fragment (no terminal punctuation) intact, and is permissive
// about edge cases — false-positives just produce shorter sentence chunks
// which still get checked.
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  // Walk by line first so headers and list items each become their own
  // sentence boundary — a heading like "## 5-hour bucket" should not be
  // glued onto the prose below it.
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/(?<=[.!?])\s+(?=[A-Z\[(])/);
    for (const p of parts) {
      const piece = p.trim();
      if (piece) out.push(piece);
    }
  }
  return out;
}

// Pulls every numeric citation id out of a sentence.
//   "[1]"      → [1]
//   "[1][3]"   → [1, 3]
//   "[1, 3]"   → [1, 3]
//   "[citation needed]" → []
export function extractCiteIds(sentence: string): number[] {
  const ids: number[] = [];
  const re = /\[([0-9]+(?:\s*,\s*[0-9]+)*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sentence)) !== null) {
    for (const part of m[1].split(",")) {
      const n = parseInt(part.trim(), 10);
      if (Number.isFinite(n) && n > 0) ids.push(n);
    }
  }
  return ids;
}

// Stop words: a small list of common English words that carry no signal
// for citation matching. Numbers and proper nouns survive automatically
// because we filter by length and case-fold rather than by a vocabulary
// allow-list.
const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "any", "can",
  "had", "her", "was", "one", "our", "out", "day", "get", "has", "him",
  "his", "how", "man", "new", "now", "old", "see", "two", "way", "who",
  "boy", "did", "its", "let", "put", "say", "she", "too", "use", "this",
  "that", "with", "have", "from", "they", "will", "been", "than", "them",
  "were", "what", "when", "your", "into", "some", "more", "very", "also",
  "such", "only", "like", "over", "most", "other", "their", "there",
  "these", "those", "which", "would", "could", "should", "about", "after",
  "before", "because", "between", "during", "while", "where", "without",
  "within", "across", "through", "based", "using", "used", "make", "made",
  "does", "doing", "done", "each", "both", "many", "much", "same", "just",
  "still", "even", "well", "well-",
]);

// Tokenize text into citation-relevant content tokens.
//
//  - lowercase
//  - split on non-alphanumeric runs (so "5-hour" → ["5","hour"])
//  - drop pure stop-words
//  - drop tokens shorter than 3 chars UNLESS they're pure numeric
//    (so "5h", "7d", "2024", "429", "5", "7" all survive)
export function contentTokens(text: string): string[] {
  const out: string[] = [];
  // Pre-split digit/letter boundaries so "5h" → "5 h", "version2" → "version 2".
  // This way numeric anchors survive even when a claim writes them tightly
  // bound to a unit ("5h", "7d") while the source spells them out ("5-hour",
  // "seven days").
  const normalized = text
    .toLowerCase()
    .replace(/([0-9])([a-z])/g, "$1 $2")
    .replace(/([a-z])([0-9])/g, "$1 $2");
  const raw = normalized.split(/[^a-z0-9]+/);
  for (const t of raw) {
    if (!t) continue;
    if (STOP_WORDS.has(t)) continue;
    const isNumeric = /^[0-9]+$/.test(t);
    if (!isNumeric && t.length < 3) continue;
    out.push(t);
  }
  return out;
}

// Token recall: fraction of distinct claim tokens present in the source.
//
//   recall = |claim_set ∩ source_set| / |claim_set|
//
// An empty claim is vacuously supported (returns 1) — there is nothing to
// disprove. This only happens for sentences that consist entirely of
// stop-words and a citation; benign in practice.
export function recall(claim: string[], source: Set<string>): number {
  const claimSet = new Set(claim);
  if (claimSet.size === 0) return 1;
  let hit = 0;
  for (const t of claimSet) if (source.has(t)) hit += 1;
  return hit / claimSet.size;
}
