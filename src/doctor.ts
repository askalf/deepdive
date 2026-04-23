// `deepdive doctor` — one command, one aggregated report.
//
// Mirrors dario's doctor philosophy: every subsystem deepdive depends on
// (Node, the LLM endpoint, the search adapter, Playwright + Chromium, the
// cache dir) gets probed; anything unhealthy is visible without the user
// chasing error messages across 3 separate commands. Paste-able into issues.
//
// Non-destructive: cache is inspected, not modified. LLM probe sends a
// max_tokens=1 request (a few tokens of cost, not zero). Browser probe opens
// + closes a blank page. Nothing persists across the run.

import { promises as fs } from "node:fs";
import { homedir, platform, arch } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeConfig } from "./config.js";
import type { SearchAdapter } from "./search.js";
import { resolveSearchAdapter } from "./search.js";
import { trimTrailingSlashes } from "./url-util.js";

export type CheckStatus = "ok" | "warn" | "fail" | "info";

export interface CheckResult {
  id: string;
  category: string;
  status: CheckStatus;
  label: string;
  detail: string;
  durationMs?: number;
}

export interface DoctorReport {
  version: string;
  generatedAt: number;
  checks: CheckResult[];
  summary: { total: number; ok: number; warn: number; fail: number; info: number };
}

export interface DoctorOptions {
  config: RuntimeConfig;
  env: Record<string, string | undefined>;
  skipLLM?: boolean;
  skipSearch?: boolean;
  skipBrowser?: boolean;
  skipCache?: boolean;
  // Hooks for tests.
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export async function runDoctor(opts: DoctorOptions): Promise<DoctorReport> {
  const now = opts.now ?? Date.now;
  const checks: CheckResult[] = [];

  for (const check of await envChecks(opts)) checks.push(check);
  if (!opts.skipCache) for (const check of await cacheChecks(opts)) checks.push(check);
  if (!opts.skipLLM) for (const check of await llmChecks(opts)) checks.push(check);
  if (!opts.skipSearch) for (const check of await searchChecks(opts)) checks.push(check);
  if (!opts.skipBrowser) for (const check of await browserChecks(opts)) checks.push(check);

  const summary = checks.reduce(
    (s, c) => ({ ...s, total: s.total + 1, [c.status]: s[c.status] + 1 }),
    { total: 0, ok: 0, warn: 0, fail: 0, info: 0 },
  );

  return {
    version: await readDeepdiveVersion(),
    generatedAt: now(),
    checks,
    summary,
  };
}

async function envChecks(_opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  out.push({
    id: "env.node",
    category: "environment",
    status: nodeMeetsMinimum(process.version) ? "ok" : "fail",
    label: "Node",
    detail: process.version,
  });
  out.push({
    id: "env.platform",
    category: "environment",
    status: "info",
    label: "Platform",
    detail: `${platform()} ${arch()}`,
  });
  out.push({
    id: "env.version",
    category: "environment",
    status: "info",
    label: "deepdive",
    detail: `v${await readDeepdiveVersion()}`,
  });
  return out;
}

async function cacheChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const dir = opts.config.cache.dir;
  if (!opts.config.cache.enabled) {
    out.push({
      id: "cache.enabled",
      category: "cache",
      status: "info",
      label: "cache",
      detail: "disabled (--no-cache or DEEPDIVE_NO_CACHE=1)",
    });
    return out;
  }
  out.push({
    id: "cache.dir",
    category: "cache",
    status: "info",
    label: "dir",
    detail: dir,
  });
  const stat = await inspectCacheDir(dir);
  if (!stat.exists) {
    out.push({
      id: "cache.state",
      category: "cache",
      status: "info",
      label: "state",
      detail: "directory does not exist yet — will be created on first fetch",
    });
    return out;
  }
  out.push({
    id: "cache.state",
    category: "cache",
    status: stat.writable ? "ok" : "fail",
    label: "writable",
    detail: stat.writable ? "yes" : "no — fetched pages cannot be cached",
  });
  out.push({
    id: "cache.entries",
    category: "cache",
    status: "info",
    label: "entries",
    detail: `${stat.fileCount} file${stat.fileCount === 1 ? "" : "s"} · ${formatBytes(stat.totalBytes)}`,
  });
  if (stat.oldestMtime !== null) {
    const ageMs = Date.now() - stat.oldestMtime;
    out.push({
      id: "cache.oldest",
      category: "cache",
      status: "info",
      label: "oldest",
      detail: `${formatDuration(ageMs)} ago`,
    });
  }
  return out;
}

async function llmChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const { baseUrl, apiKey, model } = opts.config.llm;
  const fetchImpl = opts.fetchImpl ?? fetch;

  out.push({
    id: "llm.base-url",
    category: "llm",
    status: "info",
    label: "base URL",
    detail: baseUrl,
  });
  out.push({
    id: "llm.model",
    category: "llm",
    status: "info",
    label: "model",
    detail: model,
  });

  // Non-regex trim to avoid CodeQL's polynomial-ReDoS detection on
  // `/\/+$/`. The regex is actually safe (no nested repetition) but
  // `trimTrailingSlashes` is our standard helper used everywhere else.
  const url = `${trimTrailingSlashes(baseUrl)}/v1/messages`;
  const body = {
    model,
    max_tokens: 1,
    system: "Reply with a single character.",
    messages: [{ role: "user", content: "." }],
  };

  const start = Date.now();
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const durationMs = Date.now() - start;
    if (!res.ok) {
      const text = await safeReadText(res);
      out.push({
        id: "llm.reachable",
        category: "llm",
        status: "fail",
        label: "reachable",
        detail: `${res.status} ${res.statusText} — ${clip(text, 120)}`,
        durationMs,
      });
      return out;
    }
    const json = await safeReadJson(res);
    if (!json || !isAnthropicMessagesShape(json)) {
      out.push({
        id: "llm.shape",
        category: "llm",
        status: "warn",
        label: "shape",
        detail:
          "endpoint returned 200 but the body does not match the Anthropic Messages format — check your proxy",
        durationMs,
      });
      return out;
    }
    out.push({
      id: "llm.reachable",
      category: "llm",
      status: "ok",
      label: "reachable",
      detail: `200 in ${durationMs}ms`,
      durationMs,
    });
    const usage = json.usage ?? {};
    const inTok = typeof usage.input_tokens === "number" ? usage.input_tokens : "?";
    const outTok = typeof usage.output_tokens === "number" ? usage.output_tokens : "?";
    out.push({
      id: "llm.probe",
      category: "llm",
      status: "ok",
      label: "probe",
      detail: `max_tokens=1 · in=${inTok} out=${outTok}`,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    out.push({
      id: "llm.reachable",
      category: "llm",
      status: "fail",
      label: "reachable",
      detail: classifyFetchError(err) + ` (${durationMs}ms)`,
      durationMs,
    });
  }
  return out;
}

async function searchChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  const name = opts.config.searchAdapter;

  let adapter: SearchAdapter;
  try {
    adapter = await resolveSearchAdapter(name, opts.env);
  } catch (err) {
    out.push({
      id: "search.resolve",
      category: "search",
      status: "fail",
      label: "adapter",
      detail: `${name} — ${(err as Error).message}`,
    });
    return out;
  }

  out.push({
    id: "search.adapter",
    category: "search",
    status: "info",
    label: "adapter",
    detail: name,
  });

  const start = Date.now();
  try {
    const results = await adapter.search("hello world", 3);
    const durationMs = Date.now() - start;
    if (results.length === 0) {
      out.push({
        id: "search.probe",
        category: "search",
        status: "warn",
        label: "probe",
        detail: `0 results for "hello world" (${durationMs}ms) — upstream may be throttling or parser may need an update`,
        durationMs,
      });
      return out;
    }
    out.push({
      id: "search.probe",
      category: "search",
      status: "ok",
      label: "probe",
      detail: `${results.length} results in ${durationMs}ms`,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    out.push({
      id: "search.probe",
      category: "search",
      status: "fail",
      label: "probe",
      detail: classifyFetchError(err) + ` (${durationMs}ms)`,
      durationMs,
    });
  }
  return out;
}

async function browserChecks(opts: DoctorOptions): Promise<CheckResult[]> {
  const out: CheckResult[] = [];

  let playwright: typeof import("playwright") | null = null;
  try {
    playwright = await import("playwright");
  } catch {
    out.push({
      id: "browser.module",
      category: "browser",
      status: "fail",
      label: "playwright",
      detail: "playwright module not installed — run `npm install -g @askalf/deepdive`",
    });
    return out;
  }

  out.push({
    id: "browser.module",
    category: "browser",
    status: "ok",
    label: "playwright",
    detail: "module loaded",
  });

  const start = Date.now();
  try {
    const browser = await playwright.chromium.launch({
      headless: true,
      args: ["--disable-dev-shm-usage"],
    });
    await browser.close();
    const durationMs = Date.now() - start;
    out.push({
      id: "browser.launch",
      category: "browser",
      status: "ok",
      label: "chromium",
      detail: `launch + close in ${durationMs}ms`,
      durationMs,
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    const msg = scrubPath((err as Error).message ?? String(err));
    const hint = /Executable doesn't exist|No such file|spawn ENOENT/i.test(msg)
      ? " — run `npx playwright install chromium`"
      : "";
    out.push({
      id: "browser.launch",
      category: "browser",
      status: "fail",
      label: "chromium",
      detail: `${clip(msg, 120)}${hint} (${durationMs}ms)`,
      durationMs,
    });
  }

  return out;
}

// ──────── helpers ────────

// Exported for unit tests.
export function renderDoctorText(report: DoctorReport, opts: { color?: boolean } = {}): string {
  const byCategory = new Map<string, CheckResult[]>();
  for (const c of report.checks) {
    const arr = byCategory.get(c.category) ?? [];
    arr.push(c);
    byCategory.set(c.category, arr);
  }

  const lines: string[] = [];
  lines.push(`deepdive doctor — v${report.version}`);
  lines.push("");
  const order = ["environment", "cache", "llm", "search", "browser"];
  const seenCategories = new Set<string>();
  const orderedCategories = [
    ...order.filter((c) => byCategory.has(c)),
    ...[...byCategory.keys()].filter((c) => !order.includes(c)),
  ];
  for (const cat of orderedCategories) {
    if (seenCategories.has(cat)) continue;
    seenCategories.add(cat);
    lines.push(`# ${cat}`);
    for (const c of byCategory.get(cat) ?? []) {
      lines.push(`  ${badge(c.status, opts.color)} ${pad(c.label, 11)} ${c.detail}`);
    }
    lines.push("");
  }
  const { total, ok, warn, fail } = report.summary;
  lines.push(
    `Summary: ${total} check${total === 1 ? "" : "s"} · ${ok} ok · ${warn} warn · ${fail} fail`,
  );
  return lines.join("\n");
}

// Exported for unit tests.
export function renderDoctorJson(report: DoctorReport): string {
  return JSON.stringify(report, null, 2) + "\n";
}

// Exported for unit tests.
export function exitCodeFor(report: DoctorReport): number {
  return report.summary.fail > 0 ? 1 : 0;
}

function badge(status: CheckStatus, color = false): string {
  const plain = { ok: "OK ", warn: "!! ", fail: "XX ", info: "---" }[status];
  if (!color) return plain;
  const ansi = { ok: "\x1b[32m", warn: "\x1b[33m", fail: "\x1b[31m", info: "\x1b[90m" }[status];
  return `${ansi}${plain}\x1b[0m`;
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

// Exported for unit tests.
export function nodeMeetsMinimum(versionString: string): boolean {
  const m = /^v(\d+)\./.exec(versionString);
  if (!m) return false;
  return Number(m[1]) >= 20;
}

interface CacheStat {
  exists: boolean;
  writable: boolean;
  fileCount: number;
  totalBytes: number;
  oldestMtime: number | null;
}

async function inspectCacheDir(dir: string): Promise<CacheStat> {
  try {
    await fs.stat(dir);
  } catch {
    return { exists: false, writable: true, fileCount: 0, totalBytes: 0, oldestMtime: null };
  }
  let writable = true;
  try {
    const probe = join(dir, `.write-probe.${process.pid}.${Date.now()}`);
    await fs.writeFile(probe, "");
    await fs.unlink(probe);
  } catch {
    writable = false;
  }
  let fileCount = 0;
  let totalBytes = 0;
  let oldestMtime: number | null = null;
  try {
    const names = await fs.readdir(dir);
    for (const n of names) {
      if (!n.endsWith(".json")) continue;
      try {
        const s = await fs.stat(join(dir, n));
        fileCount++;
        totalBytes += s.size;
        if (oldestMtime === null || s.mtimeMs < oldestMtime) oldestMtime = s.mtimeMs;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
  return { exists: true, writable, fileCount, totalBytes, oldestMtime };
}

// Exported for unit tests.
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

// Exported for unit tests.
export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d`;
}

// Exported for unit tests.
export function classifyFetchError(err: unknown): string {
  const msg = (err as Error)?.message ?? String(err);
  const scrubbed = scrubPath(msg);
  if (/abort/i.test(msg) && /TimeoutError/i.test(msg)) return "timeout (10s)";
  if (/timeout/i.test(msg)) return "timeout";
  if (/ECONNREFUSED/i.test(msg)) return "connection refused — is the endpoint running?";
  if (/ENOTFOUND|getaddrinfo/i.test(msg)) return "DNS failure — hostname not resolvable";
  if (/ECONNRESET/i.test(msg)) return "connection reset by peer";
  if (/certificate|CERT_|TLS|SSL/i.test(msg)) return `TLS error: ${clip(scrubbed, 80)}`;
  return clip(scrubbed, 120);
}

// Exported for unit tests. Strips Unix and Windows home-directory paths from
// text so they don't end up in bug reports or logs.
export function scrubPath(s: string): string {
  const home = homedir();
  if (!home) return s;
  let out = s;
  const homeEsc = home.replace(/[\\.*+?^${}()|[\]]/g, "\\$&");
  out = out.replace(new RegExp(homeEsc, "g"), "~");
  out = out.replace(/\\/g, "/");
  return out;
}

function isAnthropicMessagesShape(json: unknown): boolean {
  if (!json || typeof json !== "object") return false;
  const o = json as Record<string, unknown>;
  if (!Array.isArray(o.content)) return false;
  if (o.role !== "assistant") return false;
  return true;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

async function safeReadJson(res: Response): Promise<any | null> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function readDeepdiveVersion(): Promise<string> {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/doctor.js → dist/../package.json
    const pkgPath = join(here, "..", "package.json");
    const raw = await fs.readFile(pkgPath, "utf-8");
    const parsed = JSON.parse(raw) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}
