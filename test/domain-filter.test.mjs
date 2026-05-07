// Domain filter — pure-function tests for classifyUrl, matchesAny,
// normalizePattern, and parseDomainList.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyUrl,
  matchesAny,
  normalizePattern,
  parseDomainList,
} from "../dist/domain-filter.js";

// ── normalizePattern ────────────────────────────────────────────────────────

test("normalizePattern: lowercases and strips leading dot / www.", () => {
  assert.equal(normalizePattern("GitHub.com"), "github.com");
  assert.equal(normalizePattern(".github.com"), "github.com");
  assert.equal(normalizePattern("www.github.com"), "github.com");
  assert.equal(normalizePattern("  github.com  "), "github.com");
});

// ── matchesAny ──────────────────────────────────────────────────────────────

test("matchesAny: exact host match", () => {
  assert.equal(matchesAny("github.com", ["github.com"]), true);
});

test("matchesAny: subdomain matches via hostname-suffix rule", () => {
  assert.equal(matchesAny("api.github.com", ["github.com"]), true);
  assert.equal(matchesAny("docs.api.github.com", ["github.com"]), true);
});

test("matchesAny: a different TLD does not match", () => {
  assert.equal(matchesAny("github.io", ["github.com"]), false);
});

test("matchesAny: lookalike rejected (githubcompany.com)", () => {
  // Without the "." separator requirement, "github.com" would match
  // "githubcompany.com". The boundary check prevents that.
  assert.equal(matchesAny("githubcompany.com", ["github.com"]), false);
});

test("matchesAny: empty patterns → false", () => {
  assert.equal(matchesAny("github.com", []), false);
});

// ── classifyUrl ─────────────────────────────────────────────────────────────

const ALLOW_GH = { allow: ["github.com"], deny: [] };
const DENY_PIN = { allow: [], deny: ["pinterest.com"] };
const BOTH = { allow: ["github.com"], deny: ["api.github.com"] };

test("classifyUrl: allow-list keeps matching, drops the rest", () => {
  assert.equal(classifyUrl("https://api.github.com/x", ALLOW_GH), "allow");
  assert.equal(classifyUrl("https://pinterest.com/y", ALLOW_GH), "not-allowed");
});

test("classifyUrl: deny-list drops matching, keeps the rest", () => {
  assert.equal(classifyUrl("https://pinterest.com/y", DENY_PIN), "deny-listed");
  assert.equal(classifyUrl("https://github.com/y", DENY_PIN), "allow");
});

test("classifyUrl: allow + deny combine — deny wins on overlap", () => {
  // github.com is allowed, but api.github.com is explicitly denied.
  // The verdict for api.github.com should be deny-listed.
  assert.equal(classifyUrl("https://api.github.com/x", BOTH), "deny-listed");
  assert.equal(classifyUrl("https://www.github.com/x", BOTH), "allow");
  assert.equal(classifyUrl("https://elsewhere.com/x", BOTH), "not-allowed");
});

test("classifyUrl: malformed URL passes through as 'allow'", () => {
  // The fetch will fail visibly downstream — the filter shouldn't
  // silently drop URLs that the downstream pipeline could surface
  // useful errors for.
  assert.equal(classifyUrl("not a url at all", DENY_PIN), "allow");
});

test("classifyUrl: empty filter is an unconditional allow", () => {
  assert.equal(
    classifyUrl("https://anything.example/x", { allow: [], deny: [] }),
    "allow",
  );
});

// ── parseDomainList ─────────────────────────────────────────────────────────

test("parseDomainList: undefined / empty → []", () => {
  assert.deepEqual(parseDomainList(undefined), []);
  assert.deepEqual(parseDomainList(""), []);
});

test("parseDomainList: trims and drops empty parts", () => {
  assert.deepEqual(
    parseDomainList(" github.com , pinterest.com ,, "),
    ["github.com", "pinterest.com"],
  );
});
