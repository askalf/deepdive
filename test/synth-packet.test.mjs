// Synthesizer source packet (recency-aware) + source-table published date.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourcePacket } from "../dist/synthesize.js";
import { renderSourcesMarkdown } from "../dist/citations.js";

test("buildSourcePacket: header carries the publication date when present", () => {
  const packet = buildSourcePacket([
    { id: 1, url: "https://a.com", title: "A", fetchedAt: 0, publishedAt: Date.UTC(2024, 2, 15), content: "body a" },
    { id: 2, url: "https://b.com", title: "B", fetchedAt: 0, content: "body b" },
  ]);
  assert.match(packet, /\[1\] A \(published 2024-03-15\) — https:\/\/a\.com/);
  // No marker when the date is absent.
  assert.match(packet, /\[2\] B — https:\/\/b\.com/);
});

test("renderSourcesMarkdown: appends published date to the source row", () => {
  const md = renderSourcesMarkdown([
    { id: 1, url: "https://a.com", title: "A", fetchedAt: Date.UTC(2026, 4, 7), publishedAt: Date.UTC(2024, 2, 15) },
  ]);
  assert.match(md, /fetched 2026-05-07 · published 2024-03-15/);
});

test("renderSourcesMarkdown: no published clause when undefined (back-compat)", () => {
  const md = renderSourcesMarkdown([
    { id: 1, url: "https://a.com", title: "A", fetchedAt: Date.UTC(2026, 4, 7) },
  ]);
  assert.match(md, /— fetched 2026-05-07$/m);
  assert.ok(!md.includes("published"));
});
