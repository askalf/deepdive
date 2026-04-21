import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildSourceTable,
  renderSourcesMarkdown,
  renderAnswerMarkdown,
} from "../dist/citations.js";

const now = Date.UTC(2026, 3, 21);

test("buildSourceTable: assigns 1-based ids in insertion order", () => {
  const s = buildSourceTable([
    { url: "https://a", title: "A", fetchedAt: now },
    { url: "https://b", title: "B", fetchedAt: now },
  ]);
  assert.deepEqual(
    s.map((x) => x.id),
    [1, 2],
  );
});

test("renderSourcesMarkdown: produces numbered list with dates", () => {
  const s = buildSourceTable([
    { url: "https://a", title: "Alpha", fetchedAt: now },
    { url: "https://b", title: "Beta", fetchedAt: now },
  ]);
  const md = renderSourcesMarkdown(s);
  assert.match(md, /## Sources/);
  assert.match(md, /1\. \[Alpha\]\(https:\/\/a\) — fetched 2026-04-21/);
  assert.match(md, /2\. \[Beta\]\(https:\/\/b\) — fetched 2026-04-21/);
});

test("renderSourcesMarkdown: empty list returns empty string", () => {
  assert.equal(renderSourcesMarkdown([]), "");
});

test("renderSourcesMarkdown: titles with newlines normalized to spaces", () => {
  const s = buildSourceTable([
    { url: "https://a", title: "line 1\nline 2", fetchedAt: now },
  ]);
  assert.match(renderSourcesMarkdown(s), /\[line 1 line 2\]/);
});

test("renderSourcesMarkdown: brackets in title escaped to parens so markdown link is valid", () => {
  const s = buildSourceTable([
    { url: "https://a", title: "[draft] A study", fetchedAt: now },
  ]);
  assert.match(renderSourcesMarkdown(s), /\[\(draft\) A study\]\(https:\/\/a\)/);
});

test("renderSourcesMarkdown: empty title falls back to URL", () => {
  const s = buildSourceTable([{ url: "https://a", title: "", fetchedAt: now }]);
  assert.match(renderSourcesMarkdown(s), /\[https:\/\/a\]\(https:\/\/a\)/);
});

test("renderAnswerMarkdown: structure is H1, answer body, sources block", () => {
  const s = buildSourceTable([
    { url: "https://a", title: "A", fetchedAt: now },
  ]);
  const md = renderAnswerMarkdown("what is X?", "X is Y. [1]", s);
  assert.match(md, /^# what is X\?/);
  assert.match(md, /X is Y\. \[1\]/);
  assert.match(md, /## Sources/);
});
