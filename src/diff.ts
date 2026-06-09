// Session diff — compare two saved research sessions and show how the answer
// (and the source set behind it) changed between them. The longitudinal use
// case hosted tools structurally can't serve: "I asked this last month; what's
// different now?" — answered entirely from your own local history.
//
// Pure over two SessionRecords. The LLM narration path (`--narrate`) only
// builds the prompt here; the CLI owns the network call, keeping this module
// I/O-free and unit-testable.

import type { SessionRecord } from "./sessions.js";
import type { SourceWithContent } from "./synthesize.js";
import { dedupeKey } from "./url-util.js";

export interface SourceRef {
  url: string;
  title: string;
}

export type LineKind = "same" | "add" | "del";

export interface DiffLine {
  kind: LineKind;
  text: string;
}

export interface SessionSide {
  id: string;
  question: string;
  createdAt: number;
  model: string;
  sourceCount: number;
  rounds: number;
  costUsd: number;
}

export interface SessionDiff {
  a: SessionSide;
  b: SessionSide;
  sources: {
    added: SourceRef[]; // in B, not A
    removed: SourceRef[]; // in A, not B
    shared: SourceRef[]; // in both (B's title kept)
  };
  answer: {
    lines: DiffLine[];
    added: number;
    removed: number;
    unchanged: number;
  };
}

export function diffSessions(a: SessionRecord, b: SessionRecord): SessionDiff {
  return {
    a: sideOf(a),
    b: sideOf(b),
    sources: diffSources(a.sources, b.sources),
    answer: diffLines(splitLines(a.answer), splitLines(b.answer)),
  };
}

function sideOf(r: SessionRecord): SessionSide {
  return {
    id: r.id,
    question: r.question,
    createdAt: r.createdAt,
    model: r.llm?.model ?? "(unknown)",
    sourceCount: r.sources.length,
    rounds: r.rounds.length,
    costUsd: typeof r.cost?.amountUsd === "number" ? r.cost.amountUsd : 0,
  };
}

// Exported for unit tests. Source-set delta keyed on the normalized URL so
// trailing slashes / fragments don't read as "different source".
export function diffSources(
  a: SourceWithContent[],
  b: SourceWithContent[],
): SessionDiff["sources"] {
  const aKeys = new Map<string, SourceWithContent>();
  for (const s of a) aKeys.set(dedupeKey(s.url), s);
  const bKeys = new Map<string, SourceWithContent>();
  for (const s of b) bKeys.set(dedupeKey(s.url), s);

  const added: SourceRef[] = [];
  const removed: SourceRef[] = [];
  const shared: SourceRef[] = [];

  for (const [k, s] of bKeys) {
    if (aKeys.has(k)) shared.push(ref(s));
    else added.push(ref(s));
  }
  for (const [k, s] of aKeys) {
    if (!bKeys.has(k)) removed.push(ref(s));
  }
  return { added, removed, shared };
}

function ref(s: SourceWithContent): SourceRef {
  return { url: s.url, title: s.title };
}

function splitLines(s: string): string[] {
  return s.replace(/\r\n/g, "\n").trimEnd().split("\n");
}

// Exported for unit tests. Standard LCS line diff. Answers are short (hundreds
// of lines at most), so the O(n·m) DP table is well within budget.
export function diffLines(a: string[], b: string[]): SessionDiff["answer"] {
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of LCS of a[i:] and b[j:].
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0),
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push({ kind: "same", text: a[i] });
      unchanged++;
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      lines.push({ kind: "del", text: a[i] });
      removed++;
      i++;
    } else {
      lines.push({ kind: "add", text: b[j] });
      added++;
      j++;
    }
  }
  while (i < n) {
    lines.push({ kind: "del", text: a[i++] });
    removed++;
  }
  while (j < m) {
    lines.push({ kind: "add", text: b[j++] });
    added++;
  }
  return { lines, added, removed, unchanged };
}

export interface RenderDiffOptions {
  color?: boolean;
  // Unchanged lines of context to keep around each change; longer unchanged
  // runs collapse to a "… N unchanged lines …" marker. Default 2.
  context?: number;
}

// Exported for unit tests. Terminal-friendly rendering of a SessionDiff.
export function renderDiffText(diff: SessionDiff, opts: RenderDiffOptions = {}): string {
  const color = opts.color ?? false;
  const ctx = opts.context ?? 2;
  const g = (s: string) => (color ? `\x1b[32m${s}\x1b[0m` : s);
  const r = (s: string) => (color ? `\x1b[31m${s}\x1b[0m` : s);
  const dim = (s: string) => (color ? `\x1b[2m${s}\x1b[0m` : s);

  const out: string[] = [];
  out.push(`diff  ${diff.a.id}  →  ${diff.b.id}`);
  out.push(
    dim(
      `      ${ageBetween(diff.a.createdAt, diff.b.createdAt)} apart` +
        ` · ${fmtDate(diff.a.createdAt)} → ${fmtDate(diff.b.createdAt)}`,
    ),
  );
  if (diff.a.question !== diff.b.question) {
    out.push("");
    out.push(`  question  ${r("- " + diff.a.question)}`);
    out.push(`            ${g("+ " + diff.b.question)}`);
  }

  out.push("");
  out.push("  metadata");
  out.push(metaRow("model", diff.a.model, diff.b.model, g, r));
  out.push(
    metaRow("sources", String(diff.a.sourceCount), String(diff.b.sourceCount), g, r),
  );
  out.push(metaRow("rounds", String(diff.a.rounds), String(diff.b.rounds), g, r));
  out.push(
    metaRow(
      "cost",
      `$${diff.a.costUsd.toFixed(4)}`,
      `$${diff.b.costUsd.toFixed(4)}`,
      g,
      r,
    ),
  );

  out.push("");
  const { added, removed, shared } = diff.sources;
  out.push(
    `  sources   ${g("+" + added.length)} / ${r("-" + removed.length)} / ${shared.length} shared`,
  );
  for (const s of added) out.push("    " + g(`+ ${s.url}`));
  for (const s of removed) out.push("    " + r(`- ${s.url}`));

  out.push("");
  out.push(
    `  answer    ${g("+" + diff.answer.added)} / ${r("-" + diff.answer.removed)} lines` +
      ` (${diff.answer.unchanged} unchanged)`,
  );
  if (diff.answer.added === 0 && diff.answer.removed === 0) {
    out.push(dim("    (answer text identical)"));
  } else {
    out.push("");
    for (const block of collapseContext(diff.answer.lines, ctx)) {
      if (block.kind === "gap") {
        out.push(dim(`    … ${block.count} unchanged line${block.count === 1 ? "" : "s"} …`));
        continue;
      }
      const prefix =
        block.line.kind === "add" ? g("  + ") : block.line.kind === "del" ? r("  - ") : "    ";
      const text =
        block.line.kind === "add"
          ? g(block.line.text)
          : block.line.kind === "del"
          ? r(block.line.text)
          : block.line.text;
      out.push(prefix + text);
    }
  }

  return out.join("\n");
}

type RenderBlock =
  | { kind: "line"; line: DiffLine }
  | { kind: "gap"; count: number };

// Collapse long runs of unchanged lines, keeping `ctx` lines of context on
// either side of each change.
function collapseContext(lines: DiffLine[], ctx: number): RenderBlock[] {
  const keep = new Array<boolean>(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind !== "same") {
      for (let k = Math.max(0, i - ctx); k <= Math.min(lines.length - 1, i + ctx); k++) {
        keep[k] = true;
      }
    }
  }
  const blocks: RenderBlock[] = [];
  let gap = 0;
  for (let i = 0; i < lines.length; i++) {
    if (keep[i]) {
      if (gap > 0) {
        blocks.push({ kind: "gap", count: gap });
        gap = 0;
      }
      blocks.push({ kind: "line", line: lines[i] });
    } else {
      gap++;
    }
  }
  if (gap > 0) blocks.push({ kind: "gap", count: gap });
  return blocks;
}

function metaRow(
  label: string,
  a: string,
  b: string,
  g: (s: string) => string,
  r: (s: string) => string,
): string {
  if (a === b) return `    ${label.padEnd(9)} ${a}`;
  return `    ${label.padEnd(9)} ${r(a)} → ${g(b)}`;
}

function fmtDate(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? "?" : d.toISOString().slice(0, 10);
}

function ageBetween(a: number, b: number): string {
  const ms = Math.abs(b - a);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 1) return `${days}d`;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h`;
  const mins = Math.floor(ms / 60_000);
  return `${mins}m`;
}

// ── LLM narration (--narrate) ────────────────────────────────────────────────
// diff.ts stays I/O-free: it only builds the prompt. The CLI runs the call.

export const DIFF_NARRATE_SYSTEM = `You compare two research answers to the same (or a closely related) question, produced at different times. Summarize what substantively changed between the OLDER answer (A) and the NEWER answer (B).

Rules:
- Focus on changes in facts, conclusions, numbers, and recommendations — not wording.
- Lead with the single most important change.
- Call out new claims in B, claims dropped from A, and any reversals.
- If the two answers are materially the same, say so in one sentence.
- Be concise: a short paragraph or a few bullets. No preamble.`;

export function buildDiffNarrateUser(a: SessionRecord, b: SessionRecord): string {
  return (
    `Question (A, older — ${fmtDate(a.createdAt)}): ${a.question}\n` +
    `Question (B, newer — ${fmtDate(b.createdAt)}): ${b.question}\n\n` +
    `=== ANSWER A (older) ===\n${a.answer}\n\n` +
    `=== ANSWER B (newer) ===\n${b.answer}\n\n` +
    `Summarize what changed from A to B.`
  );
}
