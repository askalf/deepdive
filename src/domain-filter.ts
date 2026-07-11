// Domain allow / deny list — applied between search and fetch.
//
//   --deny-domain=pinterest.com,quora.com,reddit.com
//     → drop URLs whose hostname is OR ends with any listed domain
//
//   --allow-domain=docs.anthropic.com,github.com
//     → keep ONLY URLs whose hostname is OR ends with any listed domain
//
// Hostname-suffix matching: "github.com" matches "github.com" and
// "api.github.com" but not "githubcompany.com" — we require either an
// exact match or a leading-subdomain match (".github.com").
//
// When both lists are non-empty, allow takes precedence: a URL must
// match the allow list AND not match the deny list. An empty allow list
// is treated as "match everything". An empty deny list is treated as
// "match nothing".
//
// Pure decision functions; no I/O.

export interface DomainFilter {
  allow: string[];
  deny: string[];
}

export type DomainVerdict = "allow" | "deny-listed" | "not-allowed";

// Decides whether a URL should pass the filter. URLs that fail to parse
// are passed through ("allow") — the fetch will fail visibly elsewhere.
export function classifyUrl(
  url: string,
  filter: DomainFilter,
): DomainVerdict {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "allow";
  }
  if (filter.allow.length > 0 && !matchesAny(host, filter.allow)) {
    return "not-allowed";
  }
  if (filter.deny.length > 0 && matchesAny(host, filter.deny)) {
    return "deny-listed";
  }
  return "allow";
}

// Exported for tests. True iff `host` equals any of the patterns OR is
// a sub-host of any pattern (separated by exactly one `.`). Patterns
// are normalized by lowercasing and stripping a leading "www." or ".".
export function matchesAny(host: string, patterns: string[]): boolean {
  for (const raw of patterns) {
    const p = normalizePattern(raw);
    if (!p) continue;
    if (host === p) return true;
    if (host.endsWith("." + p)) return true;
  }
  return false;
}

// Exported for tests.
export function normalizePattern(raw: string): string {
  let s = raw.trim().toLowerCase();
  if (s.startsWith(".")) s = s.slice(1);
  if (s.startsWith("www.")) s = s.slice(4);
  return s;
}

// #147 — true iff SOME hostname under one of `servesDomains` could pass the
// allow list. An adapter serving wikipedia.org produces hosts like
// en.wikipedia.org, which pass allow=wikipedia.org (host under pattern) AND
// allow=en.wikipedia.org (pattern under serving domain) — so overlap in
// either suffix direction counts. Empty allow list matches everything.
// Used by the agent to detect a structurally useless fallback pass.
export function canServeAllowedDomain(
  servesDomains: readonly string[],
  allow: readonly string[],
): boolean {
  if (allow.length === 0) return true;
  for (const rawServed of servesDomains) {
    const served = normalizePattern(rawServed);
    if (!served) continue;
    for (const rawAllow of allow) {
      const allowed = normalizePattern(rawAllow);
      if (!allowed) continue;
      if (
        served === allowed ||
        served.endsWith("." + allowed) ||
        allowed.endsWith("." + served)
      ) {
        return true;
      }
    }
  }
  return false;
}

// Splits a comma-separated string into a normalized pattern list.
// Exported for CLI / config parsing.
export function parseDomainList(s: string | undefined): string[] {
  if (!s) return [];
  return s
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
