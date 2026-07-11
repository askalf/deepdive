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

import { trimPunctuation } from "./query-keywords.js";

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
  // ops/infra project docs that carry no docs. prefix (the v0.26.1 board's
  // niche-ops question kept 0 primary sources on BOTH sides because the
  // canonical doc hosts for its topic all scored unknown — #130).
  "nginx.org", "apache.org", "kernel.org", "php.net", "git-scm.com",
  // same class, caught live: a run whose answer was almost entirely grounded
  // in the official OpenSSH release notes badged `mixed` because the scorer
  // couldn't see the project's own hosts (#142). openssh.org is the mirror
  // search actually surfaces; openbsd.org is the parent project.
  "openssh.com", "openssh.org", "openbsd.org",
]);

const REPUTABLE_DOMAINS = new Set([
  "wikipedia.org", "stackoverflow.com", "stackexchange.com", "github.com",
  "gitlab.com",
  // The Stack Exchange network's flagship sites live on their OWN domains —
  // not subdomains of stackexchange.com — so the entry above never covered
  // them and the canonical ops Q&A scored unknown (#130).
  "serverfault.com", "superuser.com", "askubuntu.com",
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

// #148 — optional within-tier relevance tiebreak for rankByAuthority.
// Authority orders by WHO published; once a candidate pool is uniformly
// trustworthy (all-arxiv, or all-reputable multi results) it stops
// discriminating exactly where it is the only ranking axis left, and the
// slot-limited keep stage fills on search-interleave order (live receipts:
// a 2010 paper kept in a ternary-LLM answer set; wikipedia taking 4 of 7
// slots on an ops question). `terms` are the question/round content tokens
// (the #145 machinery); `textOf` yields the searchable text of an item
// (title + snippet — content isn't fetched yet at ranking time).
export interface RelevanceTiebreak<T> {
  terms: readonly string[];
  textOf: (item: T) => string;
}

function normalizeToken(w: string): string {
  return trimPunctuation(w).toLowerCase();
}

/**
 * #148 — how many of `terms` appear in `text`, on the same index-walk token
 * normalization as the keyword ladder (#86) and relevance window (#145).
 * Distinct-term count, not occurrence count: repeating one keyword shouldn't
 * outrank matching three different ones. Pure; exported for tests.
 */
export function relevanceOverlap(text: string, terms: readonly string[]): number {
  const termSet = new Set(terms.map(normalizeToken).filter((t) => t.length >= 2));
  if (termSet.size === 0) return 0;
  const tokens = new Set(
    text
      .split(/\s+/)
      .map(normalizeToken)
      .filter((t) => t.length > 0),
  );
  let n = 0;
  for (const t of termSet) if (tokens.has(t)) n++;
  return n;
}

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
 *   "off": identity — search order untouched (relevance is ignored too — off
 *      is the measurement baseline and stays a strict no-op).
 *
 * #148: when `relevance` is provided, candidates that tie on authority are
 * ordered by topical overlap with the question/round terms, so a uniform-tier
 * pool still discriminates by WHAT answers the question. Authority stays the
 * primary key — relevance never promotes a lower tier above a higher one —
 * and equal-overlap ties keep search order (stable sort), so pools where the
 * tiers already discriminate behave exactly as before.
 */
export function rankByAuthority<T>(
  items: T[],
  urlOf: (item: T) => string,
  mode: SourceAuthorityMode,
  relevance?: RelevanceTiebreak<T>,
): T[] {
  if (mode === "off" || items.length <= 1) return items;
  const scored = items.map((item) => ({
    item,
    score: scoreAuthority(urlOf(item)),
    overlap: relevance ? relevanceOverlap(relevance.textOf(item), relevance.terms) : 0,
  }));
  const pool =
    mode === "strict" && scored.some((s) => s.score.tier !== "low")
      ? scored.filter((s) => s.score.tier !== "low")
      : scored;
  return [...pool]
    .sort((a, b) => b.score.score - a.score.score || b.overlap - a.overlap)
    .map((s) => s.item);
}

// Second-level labels under which two-letter ccTLDs commonly register
// (service.gov.uk, ox.ac.uk, example.co.jp) — an eTLD+1 approximation that
// avoids shipping the public-suffix list. Wrong on exotic suffixes, which
// costs at most a slightly-too-wide or too-narrow cap bucket, never a drop.
const CC_SECOND_LEVEL = new Set(["ac", "co", "com", "edu", "gov", "net", "org"]);

/**
 * #148 — approximate registrable domain of a URL, for the per-host slot cap:
 * en.wikipedia.org and de.wikipedia.org must count as ONE host or the cap is
 * trivially evaded by language editions. Falls back to the raw input when the
 * URL won't parse (such candidates just bucket together).
 */
export function registrableDomainOf(url: string): string {
  const host = hostnameOf(url);
  if (!host) return url;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const tld = labels[labels.length - 1];
  const second = labels[labels.length - 2];
  const take = tld.length === 2 && CC_SECOND_LEVEL.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/**
 * #148 — pick up to `slots` items from an already-ranked list, keeping at
 * most `cap` per registrable domain UNLESS there is headroom: when honoring
 * the cap would leave slots unfilled, the best capped-out items fill them
 * (encyclopedic context is worth a slot or two, rarely four — but four
 * wikipedia results are still better than three sources and an empty slot).
 * Preserves the input's ranking order in the output. Pure.
 */
export function selectWithHostCap<T>(
  items: T[],
  urlOf: (item: T) => string,
  slots: number,
  cap: number = 2,
): T[] {
  if (slots <= 0) return [];
  const perHost = new Map<string, number>();
  const chosen = new Set<number>();
  const overflow: number[] = [];
  for (let i = 0; i < items.length && chosen.size < slots; i++) {
    const host = registrableDomainOf(urlOf(items[i]));
    const count = perHost.get(host) ?? 0;
    if (count >= cap) {
      overflow.push(i);
      continue;
    }
    perHost.set(host, count + 1);
    chosen.add(i);
  }
  // Headroom: slots the cap left empty go to the best capped-out candidates.
  for (const i of overflow) {
    if (chosen.size >= slots) break;
    chosen.add(i);
  }
  return [...chosen].sort((a, b) => a - b).map((i) => items[i]);
}
