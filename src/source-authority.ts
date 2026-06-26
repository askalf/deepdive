// Deterministic source-authority scoring — no LLM, no network. Pairs with the
// lexical citation verifier (verify.ts): that answers "does the answer match
// its cited source?"; this answers the orthogonal question "is that source
// itself trustworthy?". A confident, fully-cited answer built on content-farm
// spam (e.g. AI-generated "latest models" pages) scores high on the former and
// low here — the two signals are reported separately so neither is mistaken
// for the other. See #111.
//
// Philosophy: lead with high-precision BOOSTS (official docs, primary sources,
// academia, standards) where false positives are near-zero; treat anything
// unrecognized as NEUTRAL rather than punishing it (a niche-but-legit source
// shouldn't be penalized for being unknown); and keep the low-trust signal
// CONSERVATIVE — a missed content farm is acceptable, a misflagged real source
// is not. The lists are deliberately small and auditable; the TLD + subdomain
// rules cover the long tail without trying to enumerate the web.

export type AuthorityTier = "primary" | "reputable" | "unknown" | "low";

export interface AuthorityScore {
  tier: AuthorityTier;
  /** 0..1, monotonic with tier — usable directly as a ranking weight. */
  score: number;
  reason: string;
}

const TIER_SCORE: Record<AuthorityTier, number> = {
  primary: 1.0,
  reputable: 0.7,
  unknown: 0.4,
  low: 0.1,
};

// Curated primary/official domains. Subdomains match too (see domainMatches),
// so `docs.aws.amazon.com` matches `aws.amazon.com`.
const PRIMARY_DOMAINS = new Set([
  // standards / academia
  "arxiv.org", "aclanthology.org", "openreview.net", "nature.com", "science.org",
  "ietf.org", "rfc-editor.org", "w3.org", "iso.org", "ieee.org", "acm.org",
  "ncbi.nlm.nih.gov", "semanticscholar.org",
  // official project / vendor documentation
  "developer.mozilla.org", "redis.io", "kubernetes.io", "rust-lang.org",
  "postgresql.org", "python.org", "nodejs.org", "go.dev", "react.dev",
  "aws.amazon.com", "cloud.google.com", "learn.microsoft.com", "docs.github.com",
]);

const REPUTABLE_DOMAINS = new Set([
  "wikipedia.org", "stackoverflow.com", "stackexchange.com", "github.com",
  "gitlab.com",
]);

// Seed denylist of content-farm / AI-spam domains observed in the wild
// (2026-06 dogfood). Intentionally a small curated list rather than fragile
// name heuristics — precision over recall. Extend as farms are spotted.
const LOW_DOMAINS = new Set([
  "aiflashreport.com", "aireleasetracker.com", "gpt0x.com", "lmmarketcap.com",
  "precisionaiacademy.com", "lushbinary.com", "mer.vin",
]);

// Subdomains that are almost always official product documentation.
const DOCS_PREFIXES = ["docs.", "developer.", "developers.", "doc."];

// Hosts that match a DOCS_PREFIXES entry but are user-generated-content
// platforms, not official product documentation. Anyone can publish a
// Google Doc at docs.google.com/document/d/.../pub, so the prefix boost
// would otherwise score arbitrary user content as `primary` — exactly the
// fabricable-source-scoring-as-trustworthy failure mode this module exists
// to catch (#111), leaking in through the prefix rule's own blind spot.
// Google's real product docs live at developers.google.com / cloud.google.com,
// not here, so excluding docs.google.com costs no true positive. These fall
// through to a neutral `unknown` (not punished — just not boosted). Small and
// auditable, like the other lists; extend as UGC doc hosts are observed.
const DOCS_PREFIX_EXCLUSIONS = new Set(["docs.google.com"]);

// Government / education / military, including second-level ccTLDs
// (`service.gov.uk`, `ox.ac.uk`, `anu.edu.au`). Anchored at a dot so it can't
// match `education.com` or `mygov.com`.
const GOV_EDU_TLD = /\.(gov|edu|mil)$|\.(gov|edu|ac)\.[a-z]{2}$/;

/** Lowercased registrable host, `www.` stripped; null if the URL won't parse. */
function hostnameOf(url: string): string | null {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return h.startsWith("www.") ? h.slice(4) : h;
  } catch {
    return null;
  }
}

/** True if `host` is `domain` or any subdomain of it. */
function domainMatches(host: string, set: Set<string>): boolean {
  if (set.has(host)) return true;
  for (const d of set) {
    if (host.endsWith("." + d)) return true;
  }
  return false;
}

function tier(t: AuthorityTier, reason: string): AuthorityScore {
  return { tier: t, score: TIER_SCORE[t], reason };
}

/**
 * Score a source URL's trustworthiness from its domain alone. Pure and cheap;
 * order matters — an explicit denylist hit wins over any boost.
 */
export function scoreAuthority(url: string): AuthorityScore {
  const host = hostnameOf(url);
  if (!host) return tier("unknown", "unparseable url");

  if (domainMatches(host, LOW_DOMAINS)) return tier("low", `known low-trust domain (${host})`);
  if (GOV_EDU_TLD.test(host)) return tier("primary", `government/education TLD (${host})`);
  if (domainMatches(host, PRIMARY_DOMAINS)) return tier("primary", `primary/official source (${host})`);
  if (DOCS_PREFIXES.some((p) => host.startsWith(p)) && !DOCS_PREFIX_EXCLUSIONS.has(host))
    return tier("primary", `documentation subdomain (${host})`);
  if (domainMatches(host, REPUTABLE_DOMAINS)) return tier("reputable", `reputable reference (${host})`);
  return tier("unknown", `unrecognized domain (${host})`);
}

export interface SourceTrustSummary {
  /** Aggregate trust read across the kept sources, orthogonal to citation support. */
  label: "high" | "mixed" | "low";
  counts: {
    primary: number;
    reputable: number;
    unknown: number;
    low: number;
    total: number;
  };
}

/**
 * Summarize domain authority across the kept source URLs into one trust label,
 * for the output's source-trust signal (#111 P2). Deliberately coarse and
 * explainable:
 *   "high"  — no low-trust sources AND at least half are primary/reputable.
 *   "low"   — at least half the sources are known content farms.
 *   "mixed" — everything in between (all-unrecognized, or a farm or two).
 * Distinct from citation support: a fully-cited answer can still be "low" trust
 * when every source it cites is a content farm.
 */
export function summarizeSourceTrust(urls: string[]): SourceTrustSummary {
  const counts = { primary: 0, reputable: 0, unknown: 0, low: 0, total: urls.length };
  for (const url of urls) counts[scoreAuthority(url).tier]++;
  const trusted = counts.primary + counts.reputable;
  const half = Math.ceil(counts.total / 2);
  let label: SourceTrustSummary["label"];
  if (counts.total === 0) label = "mixed";
  else if (counts.low >= half) label = "low";
  else if (counts.low === 0 && trusted >= half) label = "high";
  else label = "mixed";
  return { label, counts };
}

export type SourceAuthorityMode = "prefer" | "strict" | "off";

/**
 * Order this round's candidate sources for the limited fetch slots by domain
 * authority, so authoritative/primary sources win the slots ahead of whatever
 * search happened to rank first. Pure; consumed by the keep-stage in agent.ts.
 *
 *   "prefer" (default): stable-sort by authority descending. Nothing is
 *      dropped — only the order changes, and search order is preserved within a
 *      tier (Array.prototype.sort is stable, ES2019+).
 *   "strict": additionally drop `low`-tier (known content-farm) candidates —
 *      UNLESS every candidate this round is low, in which case keep them. That
 *      min-keep floor means a niche or recency topic that only surfaces farms
 *      still gets sources rather than nothing.
 *   "off": identity — search order untouched.
 */
export function rankByAuthority<T>(
  items: T[],
  urlOf: (item: T) => string,
  mode: SourceAuthorityMode,
): T[] {
  if (mode === "off" || items.length <= 1) return items;
  const scored = items.map((item) => ({ item, score: scoreAuthority(urlOf(item)) }));
  const pool =
    mode === "strict" && scored.some((s) => s.score.tier !== "low")
      ? scored.filter((s) => s.score.tier !== "low")
      : scored;
  return [...pool].sort((a, b) => b.score.score - a.score.score).map((s) => s.item);
}
