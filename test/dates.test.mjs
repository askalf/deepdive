// Published-date extraction.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractPublishedDate,
  metaTags,
  jsonLdDates,
  toEpoch,
  resolveSince,
} from "../dist/dates.js";

const NOW = Date.UTC(2026, 5, 1);
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

// ── toEpoch ──────────────────────────────────────────────────────────────────

test("toEpoch: parses ISO and full dates", () => {
  assert.equal(iso(toEpoch("2024-03-15", NOW)), "2024-03-15");
  assert.equal(iso(toEpoch("2024-03-15T08:00:00Z", NOW)), "2024-03-15");
});

test("toEpoch: accepts bare year", () => {
  assert.equal(new Date(toEpoch("2020", NOW)).getUTCFullYear(), 2020);
});

test("toEpoch: rejects out-of-range and junk", () => {
  assert.equal(toEpoch("1788-01-01", NOW), undefined); // before 1990
  assert.equal(toEpoch("3000-01-01", NOW), undefined); // far future
  assert.equal(toEpoch("tomorrow", NOW), undefined);
  assert.equal(toEpoch("", NOW), undefined);
});

// ── metaTags ─────────────────────────────────────────────────────────────────

test("metaTags: parses name/property/itemprop in either attr order", () => {
  const html = `
    <meta property="article:published_time" content="2024-01-02">
    <meta content="2024-02-03" name="date">
    <meta itemprop="datePublished" content="2024-03-04"/>
  `;
  const m = metaTags(html);
  assert.equal(m.get("article:published_time"), "2024-01-02");
  assert.equal(m.get("date"), "2024-02-03");
  assert.equal(m.get("datepublished"), "2024-03-04");
});

// ── jsonLdDates ──────────────────────────────────────────────────────────────

test("jsonLdDates: pulls datePublished from an object", () => {
  const html = `<script type="application/ld+json">{"@type":"Article","datePublished":"2023-07-01","dateModified":"2023-08-01"}</script>`;
  const r = jsonLdDates(html);
  assert.equal(r.published, "2023-07-01");
  assert.equal(r.modified, "2023-08-01");
});

test("jsonLdDates: walks @graph arrays", () => {
  const html = `<script type="application/ld+json">{"@graph":[{"@type":"WebSite"},{"@type":"Article","datePublished":"2022-05-05"}]}</script>`;
  assert.equal(jsonLdDates(html).published, "2022-05-05");
});

test("jsonLdDates: skips malformed JSON without throwing", () => {
  const html = `<script type="application/ld+json">{not json</script>`;
  assert.deepEqual(jsonLdDates(html), {});
});

// ── extractPublishedDate (precedence) ────────────────────────────────────────

test("extractPublishedDate: JSON-LD datePublished wins over meta + time", () => {
  const html = `
    <script type="application/ld+json">{"datePublished":"2021-01-01"}</script>
    <meta property="article:published_time" content="2022-02-02">
    <time datetime="2023-03-03">x</time>`;
  assert.equal(iso(extractPublishedDate(html, NOW)), "2021-01-01");
});

test("extractPublishedDate: meta beats <time> when no JSON-LD", () => {
  const html = `
    <meta property="article:published_time" content="2022-02-02">
    <time datetime="2023-03-03">x</time>`;
  assert.equal(iso(extractPublishedDate(html, NOW)), "2022-02-02");
});

test("extractPublishedDate: falls back to <time datetime>", () => {
  const html = `<article><time datetime="2025-04-04T00:00:00Z">Apr</time></article>`;
  assert.equal(iso(extractPublishedDate(html, NOW)), "2025-04-04");
});

test("extractPublishedDate: undefined when nothing usable is present", () => {
  assert.equal(extractPublishedDate("<html><body>no dates here</body></html>", NOW), undefined);
});

test("extractPublishedDate: a future/garbage meta date is rejected, not returned", () => {
  const html = `<meta name="date" content="3999-01-01">`;
  assert.equal(extractPublishedDate(html, NOW), undefined);
});

// ── resolveSince ─────────────────────────────────────────────────────────────

test("resolveSince: a duration with a unit is relative to now", () => {
  assert.equal(resolveSince("30d", NOW), NOW - 30 * 86_400_000);
  assert.equal(resolveSince("2w", NOW), NOW - 14 * 86_400_000);
  assert.equal(resolveSince("12h", NOW), NOW - 12 * 3_600_000);
});

test("resolveSince: a bare 4-digit value is a YEAR, not a day count", () => {
  assert.equal(iso(resolveSince("2024", NOW)), "2024-01-01");
});

test("resolveSince: absolute dates parse", () => {
  assert.equal(iso(resolveSince("2024-06-15", NOW)), "2024-06-15");
});

test("resolveSince: junk returns undefined", () => {
  assert.equal(resolveSince("whenever", NOW), undefined);
  assert.equal(resolveSince("3999", NOW), undefined); // out of range year
});
