// URL canonicalization helpers. Kept as non-regex string operations so they
// are trivially linear-time even on pathological inputs — CodeQL flags
// equivalent regex forms (`/\/+$/`) as polynomial-ReDoS risks despite being
// end-anchored.

// Exported for unit tests.
export function trimTrailingSlashes(s: string): string {
  let i = s.length;
  while (i > 0 && s.charCodeAt(i - 1) === 0x2f) i--;
  return s.slice(0, i);
}

// Exported for unit tests.
export function stripHashFragment(s: string): string {
  const i = s.indexOf("#");
  return i === -1 ? s : s.slice(0, i);
}

// Exported for unit tests. Returns a dedupe key: scheme+host+path+query with
// any trailing slashes removed and any URL fragment stripped. Fragment-only
// changes shouldn't create duplicate cache entries; trailing-slash variants
// shouldn't either.
export function dedupeKey(url: string): string {
  return trimTrailingSlashes(stripHashFragment(url));
}
