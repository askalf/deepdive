// Published-date extraction. Given a page's HTML, find when it was published
// so the source table can annotate recency and the synthesizer can weigh fresh
// sources over stale ones. Pure over the HTML string; no DOM, no deps.
//
// Precedence (first valid wins): JSON-LD datePublished → publication-oriented
// <meta> tags → <time datetime> → JSON-LD dateModified → modified <meta> tags.
// A "published" date is preferred over "modified" everywhere because the
// question deepdive answers is usually "how current is this claim", and the
// original publication is the honest answer to that.

// Returns the published date as epoch milliseconds, or undefined when no
// trustworthy date is present. Dates outside a sane range (before 1990 or more
// than ~2 days into the future) are rejected as parse noise.
export function extractPublishedDate(
  html: string,
  now: number = Date.now(),
): number | undefined {
  const candidates: string[] = [];

  const ld = jsonLdDates(html);
  if (ld.published) candidates.push(ld.published);

  const metas = metaTags(html);
  for (const key of PUBLISHED_META_KEYS) {
    const hit = metas.get(key);
    if (hit) candidates.push(hit);
  }

  const timeEl = /<time\b[^>]*\bdatetime\s*=\s*["']([^"']+)["']/i.exec(html);
  if (timeEl) candidates.push(timeEl[1]);

  if (ld.modified) candidates.push(ld.modified);
  for (const key of MODIFIED_META_KEYS) {
    const hit = metas.get(key);
    if (hit) candidates.push(hit);
  }

  for (const c of candidates) {
    const t = toEpoch(c, now);
    if (t !== undefined) return t;
  }
  return undefined;
}

// Publication-oriented meta keys, highest-trust first. Compared lowercased.
const PUBLISHED_META_KEYS = [
  "article:published_time",
  "og:article:published_time",
  "datepublished",
  "parsely-pub-date",
  "sailthru.date",
  "pubdate",
  "publishdate",
  "publish-date",
  "publication_date",
  "dc.date.issued",
  "dcterms.issued",
  "dc.date",
  "date",
];

const MODIFIED_META_KEYS = [
  "article:modified_time",
  "og:updated_time",
  "datemodified",
  "lastmod",
];

// Exported for unit tests. Parses every <meta> into a key→content map, keyed by
// the lowercased name/property/itemprop. First occurrence of a key wins.
export function metaTags(html: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<meta\b([^>]*?)\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const key = (
      attr(attrs, "property") ??
      attr(attrs, "name") ??
      attr(attrs, "itemprop")
    )?.toLowerCase();
    const content = attr(attrs, "content");
    if (key && content && !out.has(key)) out.set(key, content);
  }
  return out;
}

function attr(attrs: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs);
  return m ? m[1] : undefined;
}

// Exported for unit tests. Pulls datePublished / dateModified out of any
// JSON-LD <script> block, walking arrays and @graph. Malformed JSON is skipped.
export function jsonLdDates(html: string): { published?: string; modified?: string } {
  const re =
    /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  const result: { published?: string; modified?: string } = {};
  while ((m = re.exec(html)) !== null) {
    let data: unknown;
    try {
      data = JSON.parse(m[1].trim());
    } catch {
      continue;
    }
    walk(data, result);
    if (result.published) break; // best signal found
  }
  return result;
}

function walk(node: unknown, out: { published?: string; modified?: string }): void {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, out);
      if (out.published) return;
    }
    return;
  }
  const obj = node as Record<string, unknown>;
  if (!out.published && typeof obj.datePublished === "string") {
    out.published = obj.datePublished;
  }
  if (!out.modified && typeof obj.dateModified === "string") {
    out.modified = obj.dateModified;
  }
  for (const v of Object.values(obj)) {
    if (out.published) return;
    if (v && typeof v === "object") walk(v, out);
  }
}

// Exported for unit tests. Parse a date string to epoch ms, rejecting values
// outside [1990-01-01, now + 2 days]. Bare YYYY / YYYY-MM are accepted.
export function toEpoch(s: string, now: number = Date.now()): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  // Reject pure-noise short strings that Date.parse would coerce oddly.
  if (!/\d{4}/.test(trimmed)) return undefined;
  const t = Date.parse(trimmed);
  if (Number.isNaN(t)) return undefined;
  const MIN = Date.UTC(1990, 0, 1);
  const MAX = now + 2 * 86_400_000;
  if (t < MIN || t > MAX) return undefined;
  return t;
}
