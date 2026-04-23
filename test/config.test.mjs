import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig, parsePositiveInt, parseNonNegativeInt } from "../dist/config.js";

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

test("parseNonNegativeInt: accepts 0 where parsePositiveInt wouldn't", () => {
  assert.equal(parseNonNegativeInt("0"), 0);
  assert.equal(parseNonNegativeInt("5"), 5);
  assert.equal(parseNonNegativeInt("-1"), undefined);
  assert.equal(parseNonNegativeInt("abc"), undefined);
  assert.equal(parseNonNegativeInt(undefined), undefined);
});

test("resolveConfig: deepRounds defaults to 0, env sets, flag wins", () => {
  assert.equal(resolveConfig({}, {}).deepRounds, 0);
  assert.equal(resolveConfig({}, { DEEPDIVE_DEEP_ROUNDS: "3" }).deepRounds, 3);
  assert.equal(
    resolveConfig({ deepRounds: 5 }, { DEEPDIVE_DEEP_ROUNDS: "3" }).deepRounds,
    5,
  );
  // deepRounds=0 is valid (user explicitly disables)
  assert.equal(resolveConfig({ deepRounds: 0 }, {}).deepRounds, 0);
});

test("resolveConfig: concurrency defaults to 4", () => {
  assert.equal(resolveConfig({}, {}).concurrency, 4);
  assert.equal(
    resolveConfig({}, { DEEPDIVE_CONCURRENCY: "8" }).concurrency,
    8,
  );
  assert.equal(resolveConfig({ concurrency: 2 }, {}).concurrency, 2);
});

test("resolveConfig: cache enabled by default, --no-cache flag disables", () => {
  assert.equal(resolveConfig({}, {}).cache.enabled, true);
  assert.equal(resolveConfig({ noCache: true }, {}).cache.enabled, false);
  assert.equal(
    resolveConfig({}, { DEEPDIVE_NO_CACHE: "1" }).cache.enabled,
    false,
  );
});

test("resolveConfig: cache ttl default 1h, env/flag override", () => {
  const defaultTtl = 60 * 60 * 1000;
  assert.equal(resolveConfig({}, {}).cache.ttlMs, defaultTtl);
  assert.equal(
    resolveConfig({}, { DEEPDIVE_CACHE_TTL_MS: "60000" }).cache.ttlMs,
    60000,
  );
  assert.equal(
    resolveConfig({ cacheTtlMs: 5000 }, { DEEPDIVE_CACHE_TTL_MS: "60000" })
      .cache.ttlMs,
    5000,
  );
});

test("resolveConfig: DEEPDIVE_CACHE_DIR overrides default ~/.deepdive/cache", () => {
  const c = resolveConfig({}, { DEEPDIVE_CACHE_DIR: "/tmp/custom-cache" });
  assert.equal(c.cache.dir, "/tmp/custom-cache");
});

test("resolveConfig: --json flag and DEEPDIVE_JSON=1 both set jsonOutput", () => {
  assert.equal(resolveConfig({}, {}).jsonOutput, false);
  assert.equal(resolveConfig({ json: true }, {}).jsonOutput, true);
  assert.equal(resolveConfig({}, { DEEPDIVE_JSON: "1" }).jsonOutput, true);
});

test("resolveConfig: llm.timeoutMs defaults to 120000, env + flag override", () => {
  assert.equal(resolveConfig({}, {}).llm.timeoutMs, 120_000);
  assert.equal(
    resolveConfig({}, { DEEPDIVE_LLM_TIMEOUT_MS: "60000" }).llm.timeoutMs,
    60_000,
  );
  assert.equal(
    resolveConfig({ llmTimeoutMs: 1000 }, { DEEPDIVE_LLM_TIMEOUT_MS: "9999" }).llm.timeoutMs,
    1000,
  );
});

test("resolveConfig: streamEnabled — on by default, off for --json, --no-stream, or deep mode", () => {
  // Default: on
  assert.equal(resolveConfig({}, {}).streamEnabled, true);
  // JSON off
  assert.equal(resolveConfig({ json: true }, {}).streamEnabled, false);
  // Deep off (any deepRounds > 0)
  assert.equal(resolveConfig({ deepRounds: 2 }, {}).streamEnabled, false);
  // --no-stream explicit off
  assert.equal(resolveConfig({ noStream: true }, {}).streamEnabled, false);
  // DEEPDIVE_NO_STREAM=1 off
  assert.equal(
    resolveConfig({}, { DEEPDIVE_NO_STREAM: "1" }).streamEnabled,
    false,
  );
});

test("resolveConfig: llm.maxAttempts defaults to 3, env + flag override", () => {
  assert.equal(resolveConfig({}, {}).llm.maxAttempts, 3);
  assert.equal(
    resolveConfig({}, { DEEPDIVE_LLM_ATTEMPTS: "5" }).llm.maxAttempts,
    5,
  );
  assert.equal(resolveConfig({ llmAttempts: 1 }, {}).llm.maxAttempts, 1);
});
