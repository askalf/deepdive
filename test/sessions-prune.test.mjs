// Session lifecycle — duration parsing, prune selection, delete + prune I/O.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  saveSession,
  listSessions,
  deleteSession,
  pruneSessions,
  selectSessionsToPrune,
  parseDuration,
} from "../dist/sessions.js";

// ── parseDuration ────────────────────────────────────────────────────────────

test("parseDuration: units", () => {
  assert.equal(parseDuration("45s"), 45_000);
  assert.equal(parseDuration("90m"), 90 * 60_000);
  assert.equal(parseDuration("12h"), 12 * 3_600_000);
  assert.equal(parseDuration("30d"), 30 * 86_400_000);
  assert.equal(parseDuration("2w"), 2 * 604_800_000);
});

test("parseDuration: bare integer is days", () => {
  assert.equal(parseDuration("7"), 7 * 86_400_000);
});

test("parseDuration: junk → undefined", () => {
  assert.equal(parseDuration("soon"), undefined);
  assert.equal(parseDuration(""), undefined);
  assert.equal(parseDuration(undefined), undefined);
});

// ── selectSessionsToPrune (pure) ─────────────────────────────────────────────

function meta(id, ageDays) {
  return {
    id,
    createdAt: NOW - ageDays * 86_400_000,
    question: "q " + id,
    sourceCount: 1,
    rounds: 1,
    model: "m",
  };
}
const NOW = Date.UTC(2026, 5, 1);

// newest-first, as listSessions returns
const METAS = [meta("d0", 0), meta("d10", 10), meta("d40", 40), meta("d100", 100)];

test("selectSessionsToPrune: neither criterion prunes nothing (safety)", () => {
  assert.deepEqual(selectSessionsToPrune(METAS, { now: NOW }), []);
});

test("selectSessionsToPrune: older-than only", () => {
  const ids = selectSessionsToPrune(METAS, { olderThanMs: 30 * 86_400_000, now: NOW }).map((m) => m.id);
  assert.deepEqual(ids, ["d40", "d100"]);
});

test("selectSessionsToPrune: keep-newest only", () => {
  const ids = selectSessionsToPrune(METAS, { keep: 2, now: NOW }).map((m) => m.id);
  assert.deepEqual(ids, ["d40", "d100"]);
});

test("selectSessionsToPrune: keep protects newest even when older-than would catch them", () => {
  // keep=1 protects d0; older-than=5d would otherwise catch d10/d40/d100.
  const ids = selectSessionsToPrune(METAS, { olderThanMs: 5 * 86_400_000, keep: 1, now: NOW }).map((m) => m.id);
  assert.deepEqual(ids, ["d10", "d40", "d100"]);
});

// ── deleteSession + pruneSessions (I/O) ──────────────────────────────────────

function record(id, createdAt) {
  return {
    schema: 1,
    id,
    createdAt,
    question: "q",
    plan: { reasoning: "", queries: [] },
    rounds: [],
    sources: [],
    answer: "a",
    cost: { amountUsd: 0, knownModel: true, inputTokens: 0, outputTokens: 0, calls: 0 },
    llm: { baseUrl: "x", model: "m" },
  };
}

test("deleteSession: removes the file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-prune-"));
  try {
    await saveSession(record("2026-05-01_120000_aaaaaaaa", NOW), { dir });
    await deleteSession("2026-05-01_120000_aaaaaaaa", { dir });
    const { sessions } = await listSessions({ dir });
    assert.equal(sessions.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSessions: dry-run reports but deletes nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-prune-"));
  try {
    await saveSession(record("2026-01-01_120000_old00000", NOW - 100 * 86_400_000), { dir });
    await saveSession(record("2026-05-31_120000_new00000", NOW - 1 * 86_400_000), { dir });
    const res = await pruneSessions(
      { dir },
      { olderThanMs: 30 * 86_400_000, now: NOW, dryRun: true },
    );
    assert.equal(res.removed.length, 1);
    assert.equal(res.removed[0].id, "2026-01-01_120000_old00000");
    const { sessions } = await listSessions({ dir });
    assert.equal(sessions.length, 2, "dry-run must not delete");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("pruneSessions: actually deletes the selected sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-prune-"));
  try {
    await saveSession(record("2026-01-01_120000_old00000", NOW - 100 * 86_400_000), { dir });
    await saveSession(record("2026-05-31_120000_new00000", NOW - 1 * 86_400_000), { dir });
    const res = await pruneSessions({ dir }, { olderThanMs: 30 * 86_400_000, now: NOW });
    assert.equal(res.removed.length, 1);
    assert.equal(res.remaining, 1);
    const { sessions } = await listSessions({ dir });
    assert.deepEqual(sessions.map((s) => s.id), ["2026-05-31_120000_new00000"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
