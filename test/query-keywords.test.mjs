// Keyword reduction for encyclopedia backends (#86). The example queries are
// the REAL planner queries that returned zero on Wikipedia during the
// 2026-06-11 bench runs — keep them as regression anchors.

import { test } from "node:test";
import assert from "node:assert/strict";
import { extractKeywords, keywordLadder } from "../dist/query-keywords.js";

test("extractKeywords: drops question words, keeps technical tokens intact", () => {
  assert.deepEqual(
    extractKeywords("how does HTTP/3 connection migration work and what breaks it in practice"),
    ["HTTP/3", "connection", "migration"],
  );
});

test("extractKeywords: error-string query keeps identifiers like fastcgi_buffer_size and php-fpm", () => {
  assert.deepEqual(
    extractKeywords("nginx fastcgi_buffer_size upstream sent too big header php-fpm fix"),
    ["nginx", "fastcgi_buffer_size", "upstream", "sent", "big", "header", "php-fpm"],
  );
});

test("extractKeywords: recency filler drops out of release-news queries", () => {
  assert.deepEqual(
    extractKeywords("what notable large language models were released in the last six months"),
    ["large", "language", "models", "six"],
  );
});

test("extractKeywords: surrounding punctuation trimmed, internal kept, C++/C# survive", () => {
  assert.deepEqual(extractKeywords('"rust async runtime?" (tokio)'), ["rust", "async", "runtime", "tokio"]);
  assert.deepEqual(extractKeywords("C++ vs C# performance"), ["C++", "C#", "performance"]);
});

test("keywordLadder: longest-first, deduped, capped at 4/2/1", () => {
  assert.deepEqual(
    keywordLadder("nginx fastcgi_buffer_size upstream sent too big header php-fpm fix"),
    ["nginx fastcgi_buffer_size upstream sent", "nginx fastcgi_buffer_size", "nginx"],
  );
});

test("keywordLadder: short queries collapse rungs instead of repeating them", () => {
  // 3 keywords → the 4-cap and full list coincide; 2 and 1 rungs remain.
  assert.deepEqual(
    keywordLadder("how does HTTP/3 connection migration work and what breaks it in practice"),
    ["HTTP/3 connection migration", "HTTP/3 connection", "HTTP/3"],
  );
});

test("keywordLadder: variant equal to the original query is excluded", () => {
  // Caller already tried the original verbatim.
  assert.deepEqual(keywordLadder("token bucket"), ["token"]);
  assert.deepEqual(keywordLadder("nginx"), []);
});

test("keywordLadder: no content tokens → empty ladder", () => {
  assert.deepEqual(keywordLadder("how does it work"), []);
  assert.deepEqual(keywordLadder(""), []);
  assert.deepEqual(keywordLadder("   "), []);
});
