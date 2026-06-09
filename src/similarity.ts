// Near-duplicate detection over extracted source content. The same article
// syndicated across several sites (wire stories, scraped mirrors, canonical +
// AMP copies on different hosts) survives URL-level dedupe but wastes a
// source slot and pads the synth context with repeated text. A cheap shingle
// Jaccard check catches it: two documents sharing ≳90% of their word 5-grams
// are the same article, not two perspectives.
//
// Pure over strings and sets; hand-rolled, no deps. Content is already capped
// at maxWordsPerSource (2000 default) so a shingle set is ≤ ~2000 entries and
// the pairwise compare against ≤ maxSources kept docs is trivial.

export const DEFAULT_NEAR_DUPE_THRESHOLD = 0.9;
const SHINGLE_SIZE = 5;

// Word n-gram shingle set for a document. Lowercased, whitespace-tokenized.
// A document shorter than the shingle size contributes its whole token
// sequence as a single shingle so two identical short docs still match.
export function contentShingles(text: string, n: number = SHINGLE_SIZE): Set<string> {
  const tokens = text.toLowerCase().split(/\s+/).filter(Boolean);
  const out = new Set<string>();
  if (tokens.length === 0) return out;
  if (tokens.length < n) {
    out.add(tokens.join(" "));
    return out;
  }
  for (let i = 0; i + n <= tokens.length; i++) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

// Jaccard similarity |A∩B| / |A∪B| over two shingle sets. 0 when either set
// is empty (an empty doc is "similar" to nothing — it gets dropped by the
// min-words gate upstream anyway, never by dedupe).
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const s of small) {
    if (large.has(s)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

// Returns the index of the first kept document whose similarity to
// `candidate` meets the threshold, or -1 when the candidate is genuinely new.
export function findNearDuplicate(
  candidate: Set<string>,
  kept: Set<string>[],
  threshold: number = DEFAULT_NEAR_DUPE_THRESHOLD,
): number {
  for (let i = 0; i < kept.length; i++) {
    if (jaccard(candidate, kept[i]) >= threshold) return i;
  }
  return -1;
}
