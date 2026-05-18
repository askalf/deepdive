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
}

export interface SessionMeta {
  id: string;
  createdAt: number;
  question: string;
  sourceCount: number;
  rounds: number;
  model: string;
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
      });
    } catch {
      bad.push(f);
    }
  }
  sessions.sort((a, b) => b.createdAt - a.createdAt);
  return { sessions, bad };
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
    lines.push(
      `  ${m.id}  ${ago.padStart(8)}  ${m.sourceCount} src · ${m.rounds} round  ${q}`,
    );
  }
  return lines.join("\n");
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
