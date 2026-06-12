// Keyword reduction for encyclopedia-style search backends (#86).
//
// The planner writes queries tuned for general-web engines — long, natural
// language, error strings, "how to fix" phrasing. MediaWiki-style search
// matches article titles/text and returns ZERO for most of them, which made
// wikipedia nearly useless as the default fallback exactly when it was
// needed. These helpers reduce a query to its key terms so an encyclopedia
// can be asked progressively simpler versions ("nginx fastcgi_buffer_size
// upstream sent too big header php-fpm fix" → … → "nginx").
//
// Pure: no I/O, deterministic, unit-tested with the real bench queries that
// failed in the wild.

// Grammar words that carry no topical signal.
const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "between", "but", "by",
  "can", "could", "did", "do", "does", "down", "each", "for", "from", "had",
  "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "last",
  "may", "might", "more", "most", "my", "no", "not", "of", "on", "or",
  "our", "over", "should", "since", "so", "some", "than", "that", "the",
  "their", "them", "then", "there", "these", "they", "this", "to", "too", "under",
  "until", "up", "use", "used", "using", "versus", "vs", "was", "we", "were",
  "what", "when", "where", "which", "while", "who", "why", "will", "with",
  "without", "would", "you", "your",
]);

// Generic instruction / filler words common in planner queries but useless
// (or harmful) as encyclopedia search terms.
const GENERIC_WORDS = new Set([
  "best", "break", "breaks", "broken", "cause", "caused", "causes", "common",
  "compare", "compared", "comparison", "configuration", "current", "day",
  "days", "error", "errors", "example", "examples", "explain", "explained",
  "explanation", "fix", "fixed", "fixes", "fixing", "guide", "issue",
  "issues", "latest", "month", "months", "new", "notable", "overview",
  "practice", "practices", "problem", "problems", "recent", "released",
  "solution", "solutions", "solve", "solved", "tip", "tips", "today",
  "tutorial", "week", "weeks", "work", "working", "works", "year", "years",
]);

// Ordered content tokens of a query: whitespace-split, surrounding
// punctuation trimmed (internal structure like HTTP/3, php-fpm,
// fastcgi_buffer_size survives), stopwords and generic words dropped.
export function extractKeywords(query: string): string[] {
  return query
    .split(/\s+/)
    .map((t) => t.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}+#]+$/gu, ""))
    .filter((t) => t.length > 0)
    .filter((t) => {
      const low = t.toLowerCase();
      return !STOPWORDS.has(low) && !GENERIC_WORDS.has(low);
    });
}

// Progressively shorter keyword variants of a query, longest first
// (4 → 2 → 1 leading keywords), deduplicated, and excluding anything equal
// to the original query — callers try the original first, then walk the
// ladder until a variant returns results. Empty when the query has no
// content tokens (nothing better to try).
export function keywordLadder(query: string): string[] {
  const keywords = extractKeywords(query);
  if (keywords.length === 0) return [];
  const original = query.trim();
  const out: string[] = [];
  for (const cap of [4, 2, 1]) {
    const variant = keywords.slice(0, cap).join(" ");
    if (variant === original) continue;
    if (out.includes(variant)) continue;
    out.push(variant);
  }
  return out;
}
