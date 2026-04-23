import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCache, cacheKey } from "../dist/cache.js";

function tmp() {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-cache-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("cacheKey is deterministic and hex", () => {
  const a = cacheKey("https://example.com/a");
  const b = cacheKey("https://example.com/a");
  const c = cacheKey("https://example.com/b");
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test("put then get round-trips a FetchedPage", async () => {
  const { dir, cleanup } = tmp();
  try {
    const cache = createCache({ dir, ttlMs: 60_000 });
    const page = {
      url: "https://example.com/x",
      finalUrl: "https://example.com/x",
      status: 200,
      title: "X",
      text: "hello world",
      html: "<html>hi</html>",
      fetchedAt: Date.now(),
    };
    await cache.put(page.url, page);
    const got = await cache.get(page.url);
    assert.deepEqual(got, page);
    assert.equal(cache.hits, 1);
    assert.equal(cache.misses, 0);
  } finally {
    cleanup();
  }
});

test("get on missing url returns null and counts miss", async () => {
  const { dir, cleanup } = tmp();
  try {
    const cache = createCache({ dir, ttlMs: 60_000 });
    const got = await cache.get("https://example.com/never-written");
    assert.equal(got, null);
    assert.equal(cache.hits, 0);
    assert.equal(cache.misses, 1);
  } finally {
    cleanup();
  }
});

test("expired entries are treated as misses", async () => {
  const { dir, cleanup } = tmp();
  try {
    const cache = createCache({ dir, ttlMs: 1 });
    const page = {
      url: "https://example.com/stale",
      finalUrl: "https://example.com/stale",
      status: 200,
      title: "stale",
      text: "old",
      html: "",
      fetchedAt: Date.now(),
    };
    await cache.put(page.url, page);
    await new Promise((r) => setTimeout(r, 10));
    const got = await cache.get(page.url);
    assert.equal(got, null);
    assert.equal(cache.hits, 0);
    assert.equal(cache.misses, 1);
  } finally {
    cleanup();
  }
});

test("cache dir is created lazily on first put", async () => {
  const { dir, cleanup } = tmp();
  const nested = join(dir, "subdir-that-does-not-exist");
  try {
    const cache = createCache({ dir: nested, ttlMs: 60_000 });
    const page = {
      url: "https://example.com/lazy",
      finalUrl: "https://example.com/lazy",
      status: 200,
      title: "lazy",
      text: "content",
      html: "",
      fetchedAt: Date.now(),
    };
    await cache.put(page.url, page);
    const got = await cache.get(page.url);
    assert.equal(got?.text, "content");
  } finally {
    cleanup();
  }
});

test("put is atomic: partial write leaves no parseable file", async () => {
  // Simulated: put writes to .tmp.<pid> then renames. A concurrent reader
  // mid-put either sees no file (miss) or the finished file (hit), never a
  // half-written JSON that would throw.
  const { dir, cleanup } = tmp();
  try {
    const cache = createCache({ dir, ttlMs: 60_000 });
    const page = {
      url: "https://example.com/atomic",
      finalUrl: "https://example.com/atomic",
      status: 200,
      title: "t",
      text: "t",
      html: "",
      fetchedAt: Date.now(),
    };
    const results = await Promise.all([
      cache.put(page.url, page),
      cache.get(page.url),
      cache.get(page.url),
    ]);
    // Either got null (not yet written) or got the page — never a throw.
    for (const r of [results[1], results[2]]) {
      if (r !== null) assert.equal(r.text, "t");
    }
  } finally {
    cleanup();
  }
});
