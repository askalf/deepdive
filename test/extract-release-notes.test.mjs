import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { extract } = require("../.github/scripts/extract-release-notes.cjs");

const SAMPLE = `# Changelog

## [Unreleased]

## [1.2.0] - 2026-01-02

### Added — something

- A bullet with **markdown** and [a link](https://example.com).

Body paragraph.

## [1.1.0] - 2026-01-01

### Fixed

- Older entry.
`;

test("extract: returns the full section between this heading and the next", () => {
  const out = extract(SAMPLE, "1.2.0");
  assert.match(out, /### Added — something/);
  assert.match(out, /Body paragraph\./);
  assert.doesNotMatch(out, /Older entry/);
  assert.doesNotMatch(out, /\[Unreleased\]/);
});

test("extract: NOT defeated by the blank line under the heading (#135)", () => {
  // The old lazy-regex version captured the empty string here — `$` under the
  // `m` flag matches at every line end, so the lazy quantifier stopped at the
  // first blank line. Every release body since 0.20.0 shipped empty.
  assert.notEqual(extract(SAMPLE, "1.2.0"), "");
});

test("extract: last section in the file runs to EOF", () => {
  const out = extract(SAMPLE, "1.1.0");
  assert.match(out, /Older entry/);
});

test("extract: missing version falls back to the explicit message", () => {
  assert.match(extract(SAMPLE, "9.9.9"), /no changelog section found/);
});

test("extract: version string is regex-escaped (dots do not wildcard)", () => {
  // "1x2y0" would match "1.2.0" if dots weren't escaped.
  const tricky = SAMPLE.replace("## [1.1.0]", "## [1x2y0]");
  assert.match(extract(tricky, "1.2.0"), /### Added — something/);
});

test("extract: works against the real CHANGELOG for a released version", () => {
  const md = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf-8");
  const out = extract(md, "0.27.0");
  assert.notEqual(out.length, 0);
  assert.match(out, /#130/);
  assert.doesNotMatch(out, /## \[0\.26\.1\]/);
});
