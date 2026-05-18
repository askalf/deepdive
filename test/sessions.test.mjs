// Sessions module — pure helpers + round-trip tests against a tmp dir.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
  resolveSessionId,
  renderSessionsList,
  humanDuration,
} from "../dist/sessions.js";

// ── generateSessionId ───────────────────────────────────────────────────────

test("generateSessionId: matches the documented YYYY-MM-DD_HHMMSS_<8hex> format", () => {
  const id = generateSessionId(new Date(Date.UTC(2026, 4, 7, 13, 45, 9)));
  assert.match(id, /^2026-05-07_134509_[0-9a-f]{8}$/);
});

test("generateSessionId: zero-pads single-digit components", () => {
  const id = generateSessionId(new Date(Date.UTC(2026, 0, 3, 4, 5, 6)));
  assert.match(id, /^2026-01-03_040506_/);
});

test("generateSessionId: two adjacent calls with same Date differ in the suffix", () => {
  const d = new Date();
  const a = generateSessionId(d);
  const b = generateSessionId(d);
  assert.notEqual(a, b);
});

// ── humanDuration ───────────────────────────────────────────────────────────

test("humanDuration: tiers across s / m / h / d", () => {
  assert.equal(humanDuration(15_000), "15s ago");
  assert.equal(humanDuration(2 * 60 * 1000), "2m ago");
  assert.equal(humanDuration(3 * 3600 * 1000), "3h ago");
  assert.equal(humanDuration(2 * 86400 * 1000), "2d ago");
});

// ── save / load round trip ─────────────────────────────────────────────────

function makeRecord(id) {
  return {
    schema: 1,
    id,
    createdAt: Date.now(),
    question: "how does X work",
    plan: { reasoning: "split", queries: ["q1", "q2"] },
    rounds: [
      { round: 0, queries: ["q1", "q2"], candidatesFound: 3, fetched: 2, kept: 2 },
    ],
    sources: [
      {
        id: 1,
        url: "https://ex.com/a",
        title: "A",
        fetchedAt: Date.now(),
        content: "the content of source A.",
      },
    ],
    answer: "Answer with [1].",
    cost: { amountUsd: 0.001, knownModel: true, inputTokens: 10, outputTokens: 5, calls: 2 },
    llm: { baseUrl: "http://localhost:3456", model: "claude-sonnet-4-6" },
  };
}

test("saveSession + loadSession: round trip", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const rec = makeRecord("2026-05-07_120000_aabbccdd");
    await saveSession(rec, { dir });
    const back = await loadSession(rec.id, { dir });
    assert.equal(back.id, rec.id);
    assert.equal(back.question, rec.question);
    assert.equal(back.sources.length, 1);
    assert.equal(back.sources[0].content, "the content of source A.");
    assert.equal(back.llm.model, "claude-sonnet-4-6");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveSession: writes atomically (no .tmp left on disk)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const rec = makeRecord("2026-05-07_120001_zzzzzzzz");
    await saveSession(rec, { dir });
    const fs = await import("node:fs/promises");
    const entries = await fs.readdir(dir);
    assert.deepEqual(entries.sort(), [`${rec.id}.json`]);
    assert.equal(
      entries.some((e) => e.endsWith(".tmp")),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSession: rejects unknown schema version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const id = "2026-05-07_120002_99999999";
    writeFileSync(
      join(dir, `${id}.json`),
      JSON.stringify({ schema: 99, id, sources: [] }),
    );
    await assert.rejects(() => loadSession(id, { dir }), /unsupported schema/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── listSessions ────────────────────────────────────────────────────────────

test("listSessions: returns metadata sorted newest-first; surfaces bad files", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const olderId = "2026-05-01_100000_aaaaaaaa";
    const newerId = "2026-05-07_100000_bbbbbbbb";
    const older = makeRecord(olderId);
    older.createdAt = Date.UTC(2026, 4, 1, 10, 0, 0);
    older.question = "older";
    const newer = makeRecord(newerId);
    newer.createdAt = Date.UTC(2026, 4, 7, 10, 0, 0);
    newer.question = "newer";
    await saveSession(older, { dir });
    await saveSession(newer, { dir });
    // A bad file alongside good ones
    writeFileSync(join(dir, "broken.json"), "{not-json");

    const { sessions, bad } = await listSessions({ dir });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].id, newerId, "newest first");
    assert.equal(sessions[1].id, olderId);
    assert.deepEqual(bad, ["broken.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listSessions: missing dir returns empty result without throwing", async () => {
  const { sessions, bad } = await listSessions({
    dir: "/nonexistent/sessions/dir/xyzzy",
  });
  assert.deepEqual(sessions, []);
  assert.deepEqual(bad, []);
});

// ── resolveSessionId ────────────────────────────────────────────────────────

test("resolveSessionId: exact id resolves immediately", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const rec = makeRecord("2026-05-07_120003_44444444");
    await saveSession(rec, { dir });
    const id = await resolveSessionId(rec.id, { dir });
    assert.equal(id, rec.id);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionId: unique prefix resolves to the matching id", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    await saveSession(makeRecord("2026-05-07_120004_aaaa1111"), { dir });
    await saveSession(makeRecord("2026-05-08_120004_bbbb2222"), { dir });
    const id = await resolveSessionId("2026-05-08", { dir });
    assert.equal(id, "2026-05-08_120004_bbbb2222");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionId: ambiguous prefix throws with the candidate list", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    await saveSession(makeRecord("2026-05-07_120005_aaaa1111"), { dir });
    await saveSession(makeRecord("2026-05-07_120005_bbbb2222"), { dir });
    await assert.rejects(
      () => resolveSessionId("2026-05-07", { dir }),
      /ambiguous/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveSessionId: no match throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    await assert.rejects(
      () => resolveSessionId("nope", { dir }),
      /no session matches/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── renderSessionsList ──────────────────────────────────────────────────────

test("renderSessionsList: empty list shows the bootstrap hint", () => {
  const out = renderSessionsList([]);
  assert.match(out, /no sessions yet/);
});

// ── parentId (v0.12.0) ──────────────────────────────────────────────────────

test("saveSession + loadSession: parentId round-trips when present", async () => {
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const rec = makeRecord("2026-05-07_120007_cccccccc");
    rec.parentId = "2026-05-07_115959_dddddddd";
    await saveSession(rec, { dir });
    const back = await loadSession(rec.id, { dir });
    assert.equal(back.parentId, rec.parentId);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadSession: pre-v0.12.0 records (no parentId) load with parentId undefined", async () => {
  // A pre-v0.12.0 session has no parentId field on disk. Must still load
  // cleanly — additive field, no migration.
  const dir = mkdtempSync(join(tmpdir(), "deepdive-sessions-"));
  try {
    const rec = makeRecord("2026-05-07_120008_eeeeeeee");
    // makeRecord() doesn't set parentId; saveSession will write a JSON
    // without that key. loadSession should treat it as undefined.
    await saveSession(rec, { dir });
    const back = await loadSession(rec.id, { dir });
    assert.equal(back.parentId, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderSessionsList: includes id, ago, source count, rounds, and truncated question", () => {
  const out = renderSessionsList([
    {
      id: "2026-05-07_120006_77777777",
      createdAt: Date.now() - 5000,
      question: "how does X work",
      sourceCount: 3,
      rounds: 2,
      model: "claude-sonnet-4-6",
    },
  ]);
  assert.match(out, /2026-05-07_120006_77777777/);
  assert.match(out, /\bago\b/);
  assert.match(out, /3 src/);
  assert.match(out, /2 round/);
  assert.match(out, /how does X work/);
});
