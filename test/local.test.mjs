// Local file ingestion — tests for stripTags, expandPaths, and the
// ingestLocalPaths integration (.md / .txt / .html paths).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ingestLocalPaths,
  expandPaths,
  stripTags,
} from "../dist/local.js";

// ── stripTags ───────────────────────────────────────────────────────────────

test("stripTags: drops <script> and <style> blocks entirely", () => {
  const html =
    "<html><head><style>body{color:red}</style></head>" +
    "<body><p>visible</p><script>alert(1)</script></body></html>";
  const out = stripTags(html);
  assert.match(out, /visible/);
  assert.doesNotMatch(out, /color:red/);
  assert.doesNotMatch(out, /alert/);
});

test("stripTags: decodes a small set of named entities", () => {
  assert.equal(stripTags("&lt;p&gt;hi&lt;/p&gt;"), "<p>hi</p>");
  assert.equal(stripTags("a &amp; b &nbsp; c"), "a & b   c".replace(/\s+/g, " "));
  assert.equal(stripTags("&quot;quoted&quot;"), '"quoted"');
  assert.equal(stripTags("it&#39;s"), "it's");
});

test("stripTags: drops HTML comments", () => {
  assert.equal(stripTags("<!-- secret -->visible"), "visible");
});

test("stripTags: matches </script > with whitespace before the close bracket", () => {
  // The previous regex required `</script>` exactly; CodeQL flagged this
  // as a bad-HTML-filtering pattern because </script > and </script\n>
  // would slip through. Now we tolerate \s* before the >.
  const html =
    "<p>before</p><script>alert(1)</script ><p>after</p>";
  const out = stripTags(html);
  assert.match(out, /before/);
  assert.match(out, /after/);
  assert.doesNotMatch(out, /alert/);
});

test("stripTags: does NOT double-unescape &amp;lt;", () => {
  // Sequential .replace() would turn "&amp;lt;" → "&lt;" → "<".
  // The single-pass decode preserves the literal the author wrote.
  assert.equal(stripTags("<p>&amp;lt;tag&amp;gt;</p>"), "&lt;tag&gt;");
});

// ── expandPaths ─────────────────────────────────────────────────────────────

test("expandPaths: dedupes inputs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-local-"));
  try {
    const f = join(dir, "a.md");
    writeFileSync(f, "hi");
    const out = await expandPaths([f, f, f]);
    assert.equal(out.length, 1);
    assert.equal(out[0], f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expandPaths: dir → 1-level expansion of supported extensions only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-local-"));
  try {
    writeFileSync(join(dir, "good.md"), "x");
    writeFileSync(join(dir, "good.txt"), "x");
    writeFileSync(join(dir, "page.html"), "<p>x</p>");
    writeFileSync(join(dir, "ignored.json"), "{}");
    writeFileSync(join(dir, "ignored.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    mkdirSync(join(dir, "nested"));
    writeFileSync(join(dir, "nested", "deep.md"), "x");

    const out = await expandPaths([dir]);
    const names = out.map((p) => p.split(sep).pop()).sort();
    assert.deepEqual(names, ["good.md", "good.txt", "page.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("expandPaths: missing path is silently skipped", async () => {
  const out = await expandPaths(["/this/does/not/exist/anywhere/i/hope"]);
  assert.deepEqual(out, []);
});

// ── ingestLocalPaths ────────────────────────────────────────────────────────

test("ingestLocalPaths: ingests .md / .txt / .html with file:// URLs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-local-"));
  try {
    const md = join(dir, "note.md");
    const txt = join(dir, "log.txt");
    const html = join(dir, "page.html");
    writeFileSync(md, "# heading\n\nbody text here.");
    writeFileSync(txt, "plain log line one\nline two");
    writeFileSync(
      html,
      "<html><body><p>extracted prose</p><script>nope</script></body></html>",
    );

    const result = await ingestLocalPaths([dir], {
      maxWordsPerSource: 1000,
    });
    assert.equal(result.sources.length, 3);
    const byTitle = Object.fromEntries(
      result.sources.map((s) => [s.title, s]),
    );
    assert.match(byTitle["note.md"].content, /heading/);
    assert.match(byTitle["log.txt"].content, /line two/);
    assert.match(byTitle["page.html"].content, /extracted prose/);
    assert.doesNotMatch(byTitle["page.html"].content, /nope/);
    // file:// URLs round-trip
    assert.equal(byTitle["note.md"].url, pathToFileURL(md).href);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestLocalPaths: word-cap truncates long files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-local-"));
  try {
    const f = join(dir, "long.txt");
    writeFileSync(
      f,
      Array.from({ length: 1000 }, (_, i) => `word${i}`).join(" "),
    );
    const result = await ingestLocalPaths([f], { maxWordsPerSource: 50 });
    assert.equal(result.sources.length, 1);
    const words = result.sources[0].content.split(/\s+/).filter(Boolean);
    // 50 words + the trailing "…" sentinel
    assert.ok(words.length <= 51, `got ${words.length} words`);
    assert.match(result.sources[0].content, /…$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ingestLocalPaths: unsupported extension is recorded in skipped[]", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-local-"));
  try {
    const f = join(dir, "weird.xyz");
    writeFileSync(f, "content");
    const result = await ingestLocalPaths([f], { maxWordsPerSource: 1000 });
    assert.equal(result.sources.length, 0);
    assert.equal(result.skipped.length, 1);
    assert.match(result.skipped[0].reason, /unsupported extension/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
