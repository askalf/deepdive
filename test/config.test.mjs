import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, parsePositiveInt } from "../dist/config.js";

test("resolveConfig: defaults map to dario at localhost:3456", () => {
  const c = resolveConfig({}, {});
  assert.equal(c.llm.baseUrl, "http://localhost:3456");
  assert.equal(c.llm.apiKey, "dario");
  assert.equal(c.llm.model, "claude-sonnet-4-6");
  assert.equal(c.searchAdapter, "duckduckgo");
});

test("resolveConfig: flags win over env", () => {
  const c = resolveConfig(
    { baseUrl: "http://flag:1234", model: "opus" },
    { DEEPDIVE_BASE_URL: "http://env:9999", DEEPDIVE_MODEL: "env-model" },
  );
  assert.equal(c.llm.baseUrl, "http://flag:1234");
  assert.equal(c.llm.model, "opus");
});

test("resolveConfig: env used when no flag", () => {
  const c = resolveConfig(
    {},
    { DEEPDIVE_BASE_URL: "http://env:1", DEEPDIVE_API_KEY: "k" },
  );
  assert.equal(c.llm.baseUrl, "http://env:1");
  assert.equal(c.llm.apiKey, "k");
});

test("resolveConfig: numeric env with junk ignored, falls back to default", () => {
  const c = resolveConfig({}, { DEEPDIVE_MAX_SOURCES: "not-a-number" });
  assert.equal(c.maxSources, 12);
});

test("resolveConfig: DEEPDIVE_VERBOSE=1 flips verbose", () => {
  const c = resolveConfig({}, { DEEPDIVE_VERBOSE: "1" });
  assert.equal(c.verbose, true);
});

test("resolveConfig: DEEPDIVE_HEADED=1 flips browser.headless off", () => {
  const c = resolveConfig({}, { DEEPDIVE_HEADED: "1" });
  assert.equal(c.browser.headless, false);
});

test("parsePositiveInt: rejects zero, negative, float, non-numeric", () => {
  assert.equal(parsePositiveInt("0"), undefined);
  assert.equal(parsePositiveInt("-1"), undefined);
  assert.equal(parsePositiveInt("1.5"), undefined);
  assert.equal(parsePositiveInt("abc"), undefined);
  assert.equal(parsePositiveInt(""), undefined);
  assert.equal(parsePositiveInt(undefined), undefined);
});

test("parsePositiveInt: accepts positive ints with surrounding whitespace", () => {
  assert.equal(parsePositiveInt("  42  "), 42);
  assert.equal(parsePositiveInt("1"), 1);
  assert.equal(parsePositiveInt("1000000"), 1000000);
});
