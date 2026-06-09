// Session tags — normalization + tag/untag round trips + meta surfacing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  loadSession,
  listSessions,
  renderSessionsList,
  normalizeTags,
  tagSession,
  untagSession,
} from "../dist/sessions.js";

// ── normalizeTags ────────────────────────────────────────────────────────────

test("normalizeTags: trims, lowercases, strips leading #, dedupes, keeps order", () => {
  assert.deepEqual(
    normalizeTags([" Client-X ", "#audit", "AUDIT", "", "client-x", "billing"]),
    ["client-x", "audit", "billing"],
  );
});

test("normalizeTags: empty input → empty list", () => {
  assert.deepEqual(normalizeTags([]), []);
  assert.deepEqual(normalizeTags(["", "  ", "#"]), []);
});

// ── tag / untag round trip ───────────────────────────────────────────────────

function record(id, tags) {
  return {
    schema: 1,
    id,
    createdAt: Date.UTC(2026, 5, 9),
    question: "how does X work",
    plan: { reasoning: "", queries: [] },
    rounds: [],
    sources: [],
    answer: "a",
    cost: { amountUsd: 0 },
    llm: { baseUrl: "x", model: "m" },
    ...(tags ? { tags } : {}),
  };
}

test("tagSession: merges with existing tags, normalized", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-tags-"));
  try {
    await saveSession(record("2026-06-09_120000_aaaa1111", ["audit"]), { dir });
    const tags = await tagSession("2026-06-09_120000_aaaa1111", ["#Client-X", "audit"], { dir });
    assert.deepEqual(tags, ["audit", "client-x"]);
    const back = await loadSession("2026-06-09_120000_aaaa1111", { dir });
    assert.deepEqual(back.tags, ["audit", "client-x"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("untagSession: removes; empty result deletes the field entirely", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-tags-"));
  try {
    await saveSession(record("2026-06-09_120000_bbbb2222", ["audit", "client-x"]), { dir });
    const left = await untagSession("2026-06-09_120000_bbbb2222", ["audit"], { dir });
    assert.deepEqual(left, ["client-x"]);
    const none = await untagSession("2026-06-09_120000_bbbb2222", ["#CLIENT-X"], { dir });
    assert.deepEqual(none, []);
    const back = await loadSession("2026-06-09_120000_bbbb2222", { dir });
    assert.equal("tags" in back, false, "empty tags field removed from the record");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── listSessions / render surfacing ──────────────────────────────────────────

test("listSessions: surfaces tags in metadata; render shows #tags", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-tags-"));
  try {
    await saveSession(record("2026-06-09_120000_cccc3333", ["client-x"]), { dir });
    await saveSession(record("2026-06-08_120000_dddd4444"), { dir });
    const { sessions } = await listSessions({ dir });
    const tagged = sessions.find((s) => s.id.includes("cccc3333"));
    const untagged = sessions.find((s) => s.id.includes("dddd4444"));
    assert.deepEqual(tagged.tags, ["client-x"]);
    assert.equal(untagged.tags, undefined);
    const out = renderSessionsList(sessions);
    assert.match(out, /#client-x/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSession: a pre-tags record loads cleanly (additive field)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-tags-"));
  try {
    await saveSession(record("2026-06-09_120000_eeee5555"), { dir });
    const back = await loadSession("2026-06-09_120000_eeee5555", { dir });
    assert.equal(back.tags, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
