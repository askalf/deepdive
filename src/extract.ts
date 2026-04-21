// Lightweight content extraction — strips boilerplate (nav, footer, scripts),
// keeps main content. Intentionally hand-rolled so deepdive has zero
// extraction dependencies. For quality-sensitive use cases, swap in
// @mozilla/readability via a custom extractor.

export interface ExtractedContent {
  title: string;
  text: string;
  wordCount: number;
  truncated: boolean;
}

export function extractContent(
  rawText: string,
  rawTitle: string,
  maxWords: number,
): ExtractedContent {
  const normalized = normalizeWhitespace(rawText);
  const paragraphs = normalized
    .split(/\n{2,}|\r\n{2,}|(?:\r?\n\s*){2,}/g)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const meaningful = paragraphs.filter(isMeaningfulParagraph);
  const joined = meaningful.join("\n\n");
  const words = joined.split(/\s+/).filter(Boolean);

  const truncated = words.length > maxWords;
  const clamped = truncated ? words.slice(0, maxWords).join(" ") + " …" : joined;

  return {
    title: rawTitle.trim(),
    text: clamped,
    wordCount: truncated ? maxWords : words.length,
    truncated,
  };
}

// Exported for unit tests.
export function normalizeWhitespace(s: string): string {
  return s
    .replace(/\r\n/g, "\n")
    .replace(/\t/g, " ")
    .replace(/\u00a0/g, " ")
    .replace(/[ \f\v]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Exported for unit tests.
export function isMeaningfulParagraph(p: string): boolean {
  if (p.length < 40) return false;
  const words = p.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  // Drop lines that are mostly links or UI chrome.
  const linkyRatio =
    (p.match(/https?:\/\/|www\./g)?.length ?? 0) /
    Math.max(1, words.length / 10);
  if (linkyRatio > 1) return false;
  // Drop cookie banners and nav lists.
  const chromeRe =
    /\b(cookie|cookies|privacy|sign in|sign up|log in|subscribe now|menu|navigation|skip to content)\b/i;
  if (chromeRe.test(p) && words.length < 25) return false;
  return true;
}
