// Session persistence — every successful agent run is saved to disk so
// the user can iterate on a question without re-running searches or
// re-fetching pages. Stored at ~/.deepdive/sessions/<id>.json with
// atomic .tmp + rename semantics, mirroring the cache module.
//
// Schema choice: store the full kept-source content. Yes that means
// duplication with the page cache, but cache TTLs out (1h default) and
// sessions are the long-lived record of "what did the agent actually
// reason over." A 30-day-old session must remain self-contained.
//
// Pure I/O at well-named boundaries; the session ID generator and the
// id-resolver (prefix matching) are pure and unit-testable.

import { promises as fs } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Plan, Critique } from "./plan.js";
import type { SourceWithContent } from "./synthesize.js";
import type { VerificationReport } from "./verify.js";
import type { CostEstimate } from "./pricing.js";
import type { RoundTrace } from "./agent.js";

export interface SessionRecord {
  // Schema version. Bump when the shape changes incompatibly.
  schema: 1;
  id: string;
  createdAt: number;
  question: string;
  plan: Plan;
  rounds: RoundTrace[];
  sources: SourceWithContent[];
  answer: string;
  verification?: VerificationReport;
  cost: CostEstimate;
  llm: { baseUrl: string; model: string };
  // v0.12.0 — backlink to the session this one was `continue`-d from.
  // Additive optional field; pre-v0.12.0 records load with `parentId`
  // undefined. Lets `sessions ls` (in a future release) render the
  // parent chain and `show` link back.
  parentId?: string;
  // v0.17.0 — user labels for organizing the corpus (--tag on a run, or
  // `sessions tag <id> <tags>` after the fact). Normalized lowercase,
  // deduped. Additive optional; older records load with tags undefined.
  tags?: string[];
}

export interface SessionMeta {
  id: string;
  createdAt: number;
  question: string;
  sourceCount: number;
  rounds: number;
  model: string;
  tags?: string[];
}

export interface SessionStorageOptions {
  dir: string;
}

// Default sessions directory. Override with DEEPDIVE_SESSIONS_DIR.
export function defaultSessionsDir(env?: Record<string, string | undefined>): string {
  return env?.DEEPDIVE_SESSIONS_DIR ?? join(homedir(), ".deepdive", "sessions");
}

// Session ID format: `2026-05-07_HHMMSS_<8-hex>`. Sortable
// chronologically when listed; the suffix is enough entropy to avoid
// collisions when multiple sessions land in the same second. Exported
// for tests.
export function generateSessionId(now: Date = new Date()): string {
  const yyyy = now.getUTCFullYear();
  const mm = pad(now.getUTCMonth() + 1, 2);
  const dd = pad(now.getUTCDate(), 2);
  const hh = pad(now.getUTCHours(), 2);
  const mi = pad(now.getUTCMinutes(), 2);
  const ss = pad(now.getUTCSeconds(), 2);
  const suffix = randomHex(4);
  return `${yyyy}-${mm}-${dd}_${hh}${mi}${ss}_${suffix}`;
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

function randomHex(bytes: number): string {
  const arr = new Uint8Array(bytes);
  // crypto is globally available in Node 20+ via web crypto.
  (globalThis.crypto as { getRandomValues: (a: Uint8Array) => void }).getRandomValues(
    arr,
  );
  return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

// Atomically write a session to disk. The dir is created if missing.
export async function saveSession(
  record: SessionRecord,
  opts: SessionStorageOptions,
): Promise<string> {
  await fs.mkdir(opts.dir, { recursive: true });
  const path = join(opts.dir, `${record.id}.json`);
  const tmp = path + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(record, null, 2), "utf-8");
  await fs.rename(tmp, path);
  return path;
}

// Loads a session by exact id. Throws if missing or unparsable.
export async function loadSession(
  id: string,
  opts: SessionStorageOptions,
): Promise<SessionRecord> {
  const path = join(opts.dir, `${id}.json`);
  const raw = await fs.readFile(path, "utf-8");
  const json = JSON.parse(raw) as SessionRecord;
  if (json.schema !== 1) {
    throw new Error(
      `session ${id}: unsupported schema version ${json.schema} (expected 1)`,
    );
  }
  return json;
}

// Lists session metadata, newest first. Skips files that don't parse
// (returns them as warnings via `bad[]` for the caller to surface).
export async function listSessions(
  opts: SessionStorageOptions,
): Promise<{ sessions: SessionMeta[]; bad: string[] }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(opts.dir);
  } catch {
    return { sessions: [], bad: [] };
  }
  const sessions: SessionMeta[] = [];
  const bad: string[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    if (f.endsWith(".tmp")) continue;
    try {
      const raw = await fs.readFile(join(opts.dir, f), "utf-8");
      const r = JSON.parse(raw) as SessionRecord;
      if (r.schema !== 1) {
        bad.push(f);
        continue;
      }
      sessions.push({
        id: r.id,
        createdAt: r.createdAt,
        question: r.question,
        sourceCount: r.sources.length,
        rounds: r.rounds.length,
        model: r.llm?.model ?? "(unknown)",
        ...(Array.isArray(r.tags) && r.tags.length > 0 ? { tags: r.tags } : {}),
      });
    } catch {
      bad.push(f);
    }
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return { sessions, bad };
}

// Loads every parseable session record (full content, not just metadata) for
// aggregate analysis (`deepdive stats`). Unparseable files are collected in
// `bad` and skipped. Newest first.
export async function loadAllSessions(
  opts: SessionStorageOptions,
): Promise<{ records: SessionRecord[]; bad: string[] }> {
  let entries: string[] = [];
  try {
    entries = await fs.readdir(opts.dir);
  } catch {
    return { records: [], bad: [] };
  }
  const records: SessionRecord[] = [];
  const bad: string[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json") || f.endsWith(".tmp")) continue;
    try {
      const raw = await fs.readFile(join(opts.dir, f), "utf-8");
      const r = JSON.parse(raw) as SessionRecord;
      if (r.schema !== 1) {
        bad.push(f);
        continue;
      }
      records.push(r);
    } catch {
      bad.push(f);
    }
  }
  records.sort((a, b) => b.createdAt - a.createdAt);
  return { records, bad };
}

// Resolves a partial id (timestamp-prefix shorthand) against the
// directory. Exported for tests and reuse from the resume path.
//
// - "2026-05-07" → matches every session from that day; ambiguous
//   unless exactly one matches
// - "2026-05-07_103045" → likely unique; resolve if so
// - exact id → always resolves to itself when the file exists
//
// Returns the resolved id or throws with a clear "ambiguous" / "no
// match" message.
export async function resolveSessionId(
  prefix: string,
  opts: SessionStorageOptions,
): Promise<string> {
  // Exact match wins, no listing needed.
  try {
    await fs.access(join(opts.dir, `${prefix}.json`));
    return prefix;
  } catch {
    /* fall through */
  }
  const { sessions } = await listSessions(opts);
  const matches = sessions.filter((s) => s.id.startsWith(prefix));
  if (matches.length === 0) {
    throw new Error(`no session matches "${prefix}" in ${opts.dir}`);
  }
  if (matches.length > 1) {
    const sample = matches
      .slice(0, 5)
      .map((m) => m.id)
      .join("\n  ");
    throw new Error(
      `prefix "${prefix}" is ambiguous (${matches.length} matches); pick one:\n  ${sample}`,
    );
  }
  return matches[0].id;
}

// Pretty-prints the metadata list for `deepdive sessions ls`. Exported
// for tests and reuse.
export function renderSessionsList(metas: SessionMeta[]): string {
  if (metas.length === 0) {
    return "(no sessions yet — run `deepdive \"<question>\"` to create one)";
  }
  const lines: string[] = [];
  for (const m of metas) {
    const ago = humanDuration(Date.now() - m.createdAt);
    const q =
      m.question.length > 60 ? m.question.slice(0, 59) + "…" : m.question;
    const tags =
      m.tags && m.tags.length > 0 ? "  " + m.tags.map((t) => `#${t}`).join(" ") : "";
    lines.push(
      `  ${m.id}  ${ago.padStart(8)}  ${m.sourceCount} src · ${m.rounds} round  ${q}${tags}`,
    );
  }
  return lines.join("\n");
}

// ── Tags ─────────────────────────────────────────────────────────────────────

// Exported for unit tests. Normalize a raw tag list: trim, lowercase, drop
// empties and the leading '#' people will inevitably type, dedupe, preserve
// first-seen order. Tags are labels — lowercase keeps filtering predictable.
export function normalizeTags(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const t = r.trim().replace(/^#/, "").toLowerCase();
    if (t.length === 0 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// Adds tags to a saved session (load → merge → atomic save). Returns the
// updated tag list.
export async function tagSession(
  id: string,
  tags: string[],
  opts: SessionStorageOptions,
): Promise<string[]> {
  const record = await loadSession(id, opts);
  const merged = normalizeTags([...(record.tags ?? []), ...tags]);
  record.tags = merged;
  await saveSession(record, opts);
  return merged;
}

// Removes tags from a saved session. Returns the remaining tag list.
export async function untagSession(
  id: string,
  tags: string[],
  opts: SessionStorageOptions,
): Promise<string[]> {
  const record = await loadSession(id, opts);
  const remove = new Set(normalizeTags(tags));
  const remaining = (record.tags ?? []).filter((t) => !remove.has(t));
  if (remaining.length > 0) record.tags = remaining;
  else delete record.tags;
  await saveSession(record, opts);
  return remaining;
}

// Exported for tests.
export function humanDuration(ms: number): string {
  if (ms < 0) return "future";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ── Lifecycle: delete + prune ────────────────────────────────────────────────

// Deletes a single session file by exact id. Resolve a prefix with
// resolveSessionId first. Throws ENOENT if the file is already gone.
export async function deleteSession(
  id: string,
  opts: SessionStorageOptions,
): Promise<void> {
  await fs.unlink(join(opts.dir, `${id}.json`));
}

export interface PruneCriteria {
  // Prune sessions older than this many ms (relative to `now`).
  olderThanMs?: number;
  // Always retain the newest `keep` sessions regardless of age.
  keep?: number;
  // Injectable clock for tests. Defaults to Date.now() at call time.
  now?: number;
}

// Exported for unit tests. Pure selection: given metadata (newest-first, as
// listSessions returns) and the criteria, returns the sessions that should be
// removed. With neither criterion set, returns [] — never prunes everything by
// default; the CLI requires at least one of --older-than / --keep.
export function selectSessionsToPrune(
  metas: SessionMeta[],
  crit: PruneCriteria,
): SessionMeta[] {
  if (crit.olderThanMs === undefined && crit.keep === undefined) return [];
  const now = crit.now ?? Date.now();
  const keep = crit.keep ?? 0;
  const out: SessionMeta[] = [];
  metas.forEach((m, idx) => {
    if (idx < keep) return; // protected: among the newest `keep`
    if (crit.olderThanMs !== undefined && now - m.createdAt < crit.olderThanMs) {
      return; // too new to prune
    }
    out.push(m);
  });
  return out;
}

// Lists, selects, and (unless dryRun) deletes matching sessions. Returns the
// metadata of removed sessions, the count still remaining, and any unparsable
// files encountered while listing.
export async function pruneSessions(
  opts: SessionStorageOptions,
  crit: PruneCriteria & { dryRun?: boolean },
): Promise<{ removed: SessionMeta[]; remaining: number; bad: string[] }> {
  const { sessions, bad } = await listSessions(opts);
  const toRemove = selectSessionsToPrune(sessions, crit);
  if (!crit.dryRun) {
    for (const m of toRemove) {
      await deleteSession(m.id, opts).catch(() => undefined);
    }
  }
  return {
    removed: toRemove,
    remaining: sessions.length - toRemove.length,
    bad,
  };
}

// Exported for unit tests. Parses a human duration like "30d", "12h", "90m",
// "45s", "2w" into milliseconds. A bare integer is interpreted as days
// (the common "prune things older than N days" case). Returns undefined for
// unparsable input.
export function parseDuration(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const t = s.trim().toLowerCase();
  const m = /^(\d+)\s*(w|d|h|m|s)?$/.exec(t);
  if (!m) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  const unit = m[2] ?? "d";
  const mult: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * mult[unit];
}
