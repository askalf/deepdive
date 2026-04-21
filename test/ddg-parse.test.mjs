import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDuckDuckGoHTML } from "../dist/search/duckduckgo.js";

// Minimal fixture mimicking DDG's HTML output shape.
const FIXTURE = `
<html><body>
  <div class="result results_links">
    <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Farticle&amp;rut=abc">Example Article</a>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The snippet text explains the article.</a>
  </div>
  <div class="result results_links">
    <a class="result__a" href="https://direct.example.org/page">Direct Link</a>
    <a class="result__snippet" href="#">Another snippet about the direct link.</a>
  </div>
  <div class="result results_links">
    <a class="result__a" href="javascript:void(0)">Bogus</a>
    <a class="result__snippet" href="#">Would be skipped.</a>
  </div>
</body></html>
`;

test("parseDuckDuckGoHTML: unwraps /l/?uddg= redirect", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 10);
  assert.equal(r[0].url, "https://example.com/article");
});

test("parseDuckDuckGoHTML: passes through direct URLs unchanged", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 10);
  assert.ok(r.some((x) => x.url === "https://direct.example.org/page"));
});

test("parseDuckDuckGoHTML: filters non-http URLs (javascript:, etc.)", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 10);
  assert.equal(
    r.find((x) => x.title === "Bogus"),
    undefined,
  );
});

test("parseDuckDuckGoHTML: title HTML entities decoded", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 10);
  assert.equal(r[0].title, "Example Article");
});

test("parseDuckDuckGoHTML: limits output to requested count", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 1);
  assert.equal(r.length, 1);
});

test("parseDuckDuckGoHTML: assigns 1-based rank", () => {
  const r = parseDuckDuckGoHTML(FIXTURE, 10);
  assert.equal(r[0].rank, 1);
  assert.equal(r[1].rank, 2);
});

test("parseDuckDuckGoHTML: empty input returns empty array, no throw", () => {
  assert.deepEqual(parseDuckDuckGoHTML("", 10), []);
});
