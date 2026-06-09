#!/usr/bin/env node
// deepdive CLI entry.
//
//   deepdive "how does claude's rate limiter work"
//   deepdive "..." --model=claude-opus-4-7 --search=brave --out=report.md
//   deepdive "..." --deep=2 --concurrency=6 --json
//   deepdive --help
//
// Prints the cited markdown report to stdout (or JSON with --json). Progress
// events go to stderr when --verbose is set or DEEPDIVE_VERBOSE=1.

import { writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveConfig, type CLIFlags } from "./config.js";
import { parseMaxCost, BudgetExceededError } from "./budget.js";
import { resolveSearchAdapter } from "./search.js";
import { runAgent, type AgentEvent } from "./agent.js";
import { createCache } from "./cache.js";
import { createRobotsCache } from "./robots.js";
import { renderSourcesMarkdown, renderAnswerMarkdown } from "./citations.js";
import { synthesize } from "./synthesize.js";
import { verifyCitations as runVerify, type VerificationReport } from "./verify.js";
import {
  formatCostLine,
  looksLikeDario,
  estimateCost,
  type CostEstimate,
} from "./pricing.js";
import {
  generateSessionId,
  saveSession,
  loadSession,
  listSessions,
  resolveSessionId,
  renderSessionsList,
  deleteSession,
  pruneSessions,
  parseDuration,
  loadAllSessions,
} from "./sessions.js";
import { aggregateSessionStats, renderStats } from "./stats.js";
import { renderHtmlReport } from "./html-export.js";
import { assessConfidence, formatConfidenceLine } from "./confidence.js";
import { loadConfigFile, fileConfigToEnv } from "./config-file.js";
import { resolveProfile } from "./profiles.js";
import { completionScript, type Shell } from "./completion.js";
import { browserOpenCommand } from "./open.js";
import {
  diffSessions,
  renderDiffText,
  DIFF_NARRATE_SYSTEM,
  buildDiffNarrateUser,
} from "./diff.js";
import { callLLM } from "./llm.js";
import {
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  exitCodeFor,
  scrubPath,
} from "./doctor.js";

const USAGE = `deepdive — local research agent

Usage:
  deepdive "<question>" [flags]            Run the research agent
  deepdive doctor [flags]                  Health check — paste the output when filing issues
  deepdive sessions ls [<filter>]          List saved sessions (optional question substring)
  deepdive stats                           Aggregate cost / sources / models across sessions
  deepdive show <id>                       Print a saved session's markdown answer
  deepdive resume <id> [<question>]        Re-synthesize against a saved session's
                                           sources (cheap iteration; no re-fetching)
  deepdive continue <id> [<question>]      Full agent run seeded with the saved session's
                                           sources (plans + searches + fetches new pages;
                                           saved as a new session linked via parentId)
  deepdive export <id> [--format=html|md]  Render a saved session as a shareable artifact
                                           (--out=report.html). Format inferred from --out.
  deepdive diff <id-a> <id-b> [--narrate]  Show how the answer + source set changed between
                                           two saved runs. --narrate adds an LLM summary.
  deepdive sessions rm <id> [<id>...]      Delete one or more saved sessions
  deepdive sessions prune --older-than=30d Delete old sessions (and/or --keep=<n> newest;
                                           --dry-run to preview)
  deepdive search "<query>"                Run just the search adapter, print raw results
                                           (no LLM/fetch). Honors --search / --json.
  deepdive open <id>                       Render a session to HTML and open it in the
                                           browser (--out to keep the file)
  deepdive completion <bash|zsh|fish>      Print a shell completion script
  deepdive --help                          Show this help

Flags:
  --base-url=<url>              LLM endpoint. Default: http://localhost:3456 (dario)
  --api-key=<key>               LLM API key. Default: dario
  --model=<name>                Model to use. Default: claude-sonnet-4-6
  --plan-model=<name>           Override model for planner stage only (cheap option:
                                claude-haiku-4-5). Default: same as --model.
  --synth-model=<name>          Override model for synthesizer stage only. Default: same as --model.
  --critic-model=<name>         Override model for critic stage only (cheap option:
                                claude-haiku-4-5). Default: same as --model.
  --max-cost=<$X.YY>            Abort the run before the next LLM call would exceed this
                                dollar cap. e.g. --max-cost=$0.50 or --max-cost=5.
                                Env: DEEPDIVE_MAX_COST. Exit code 2 on cap-hit.
  --max-tokens=<n>              Output max tokens per LLM call. Default: 4096
  --search=<adapter>            Search adapter: duckduckgo | searxng | brave | tavily | exa |
                                auto | wikipedia | arxiv | github | hackernews |
                                stackexchange | pubmed
                                Default: duckduckgo (no key required). wikipedia, arxiv,
                                hackernews, stackexchange, and pubmed need no key; github
                                works keyless (DEEPDIVE_GITHUB_TOKEN raises the limit).
                                'auto' runs DDG first, Brave fallback (if DEEPDIVE_BRAVE_KEY).
  --results-per-query=<n>       Results per sub-query. Default: 5
  --max-sources=<n>             Total sources to fetch. Default: 12
  --max-words-per-source=<n>    Per-source content cap before synthesis. Default: 2000
  --timeout-ms=<ms>             Per-fetch (browser) timeout. Default: 30000
  --browser-cdp-endpoint=<url>  Attach to a running CDP browser (e.g. http://host:9222)
                                instead of launching Chromium. Skips the Playwright
                                browser download. Env: DEEPDIVE_BROWSER_CDP_ENDPOINT
  --llm-timeout-ms=<ms>         Per-LLM-call timeout. Default: 120000 (2 min)
  --llm-attempts=<n>            Max LLM attempts per call (with exponential
                                backoff on 5xx/429/network errors). Default: 3
  --deep[=<n>]                  Iterative research: run N additional critic-driven
                                rounds after the first synthesis. Default when
                                bare: 2. No deep pass when flag absent.
  --profile=<name>              Apply a named preset: deep | thorough | fast | cheap |
                                strict, or one defined in your config file. Layered
                                beneath env + flags. See ~/.deepdive/config.json.
  --concurrency=<n>             Parallel fetches. Default: 4
  --no-cache                    Disable the on-disk page cache (default: enabled)
  --cache-ttl-ms=<ms>           Page cache TTL. Default: 3600000 (1 hour)
  --ignore-robots               Bypass robots.txt checks (default: respect them)
  --no-verify-cites             Skip lexical citation verification (default: on)
  --strict-cites                Exit non-zero if any citation is unsupported
  --cite-min-recall=<0..1>      Threshold for citation support. Default: 0.4
  --no-cost                     Suppress the end-of-run cost summary on stderr
  --include=<paths>             Comma-separated list of local files / dirs to
                                ingest as sources (.pdf, .md, .txt, .html).
                                PDFs require pdfjs-dist installed.
  --pdf-max-pages=<n>           Cap pages parsed per PDF. Default: 50
  --allow-domain=<list>         Comma-separated hostname suffixes to keep
                                exclusively (e.g. github.com,docs.anthropic.com).
  --deny-domain=<list>          Comma-separated hostname suffixes to drop
                                (e.g. pinterest.com,quora.com).
  --since=<date|duration>       Drop sources published before this — an absolute
                                date (2024, 2024-06, 2024-06-15) or a duration
                                (30d, 12h, 2w = that long ago). Sources with no
                                detectable date are kept. Env: DEEPDIVE_SINCE.
  --api-format=<anthropic|openai>
                                Wire format for the LLM endpoint. Default:
                                auto-detected from --base-url (api.openai.com,
                                :11434 (Ollama), :8000 default to openai;
                                everything else to anthropic).
  --tldr                        Lead the answer with a one-paragraph TL;DR (env: DEEPDIVE_TLDR)
  --json                        Emit a JSON result to stdout instead of markdown
  --out=<path>                  Write the output (markdown or json) to a file too
  --format=<html|md>            export: output format (default: inferred from --out, else html)
  --narrate                     diff: add a one-shot LLM summary of what changed
  --older-than=<dur>            sessions prune: age cutoff — 30d, 12h, 90m, 2w
  --keep=<n>                    sessions prune: always retain the newest <n> sessions
  --dry-run                     sessions prune: report what would be deleted, delete nothing
  --verbose, -v                 Stream progress events to stderr
  --no-stream                   Buffer the final answer instead of streaming
                                tokens to stdout (auto-off for --json and
                                non-TTY stdout)
  --no-sessions                 Do not persist this run to ~/.deepdive/sessions/
  --help, -h                    Show this help

Environment:
  DEEPDIVE_BASE_URL, DEEPDIVE_API_KEY, DEEPDIVE_MODEL, DEEPDIVE_SEARCH,
  DEEPDIVE_SEARXNG_URL, DEEPDIVE_BRAVE_KEY, DEEPDIVE_TAVILY_KEY, DEEPDIVE_EXA_KEY,
  DEEPDIVE_WIKIPEDIA_LANG, DEEPDIVE_GITHUB_TOKEN, DEEPDIVE_STACKEXCHANGE_SITE,
  DEEPDIVE_MAX_SOURCES, DEEPDIVE_FETCH_TIMEOUT_MS, DEEPDIVE_HEADED,
  DEEPDIVE_DEEP_ROUNDS, DEEPDIVE_CONCURRENCY, DEEPDIVE_NO_CACHE,
  DEEPDIVE_CACHE_DIR, DEEPDIVE_CACHE_TTL_MS, DEEPDIVE_JSON, DEEPDIVE_VERBOSE, DEEPDIVE_TLDR,
  DEEPDIVE_LLM_TIMEOUT_MS, DEEPDIVE_LLM_ATTEMPTS,
  DEEPDIVE_NO_VERIFY_CITES, DEEPDIVE_STRICT_CITES, DEEPDIVE_CITE_MIN_RECALL,
  DEEPDIVE_NO_COST, DEEPDIVE_PRICE_INPUT_PER_MTOK, DEEPDIVE_PRICE_OUTPUT_PER_MTOK,
  DEEPDIVE_INCLUDE, DEEPDIVE_PDF_MAX_PAGES,
  DEEPDIVE_ALLOW_DOMAIN, DEEPDIVE_DENY_DOMAIN, DEEPDIVE_SINCE, DEEPDIVE_API_FORMAT,
  DEEPDIVE_NO_SESSIONS, DEEPDIVE_SESSIONS_DIR, DEEPDIVE_CONFIG

Config file:
  ~/.deepdive/config.json (override path with DEEPDIVE_CONFIG) — JSON object of
  default settings (friendly keys: model, search, deep, concurrency, …), an
  optional "profiles" map, and an optional "defaultProfile". Precedence:
  CLI flags > env vars > --profile > config-file base > built-in defaults.
`;

interface ParsedArgs {
  // For the default research case, this is the user's question. For
  // subcommand cases (doctor / sessions / show / resume), this is the
  // subcommand verb.
  question?: string;
  // Subcommand-only — extra positional arguments after the verb.
  // Empty for the default research case.
  extras: string[];
  outPath?: string;
  flags: CLIFlags;
  help: boolean;
}

// Verbs that accept additional positional arguments. Anything else
// triggers the "wrap your question in quotes" error when more than one
// positional shows up.
const SUBCOMMAND_VERBS = new Set([
  "doctor",
  "sessions",
  "show",
  "resume",
  "continue",
  "export",
  "diff",
  "completion",
  "search",
  "open",
  "stats",
]);

// Exported for unit tests.
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CLIFlags = {};
  let question: string | undefined;
  const extras: string[] = [];
  let outPath: string | undefined;
  let help = false;

  for (const a of argv) {
    if (a === "--help" || a === "-h") {
      help = true;
      continue;
    }
    if (a === "--verbose" || a === "-v") {
      flags.verbose = true;
      continue;
    }
    if (a === "--no-cache") {
      flags.noCache = true;
      continue;
    }
    if (a === "--ignore-robots") {
      flags.ignoreRobots = true;
      continue;
    }
    if (a === "--no-verify-cites") {
      flags.noVerifyCites = true;
      continue;
    }
    if (a === "--strict-cites") {
      flags.strictCites = true;
      continue;
    }
    if (a === "--no-cost") {
      flags.noCost = true;
      continue;
    }
    if (a === "--no-sessions") {
      flags.noSessions = true;
      continue;
    }
    if (a === "--json") {
      flags.json = true;
      continue;
    }
    if (a === "--no-stream") {
      flags.noStream = true;
      continue;
    }
    if (a === "--tldr") {
      flags.tldr = true;
      continue;
    }
    if (a === "--narrate") {
      flags.narrate = true;
      continue;
    }
    if (a === "--dry-run") {
      flags.dryRun = true;
      continue;
    }
    if (a === "--deep") {
      flags.deepRounds = 2;
      continue;
    }
    const m = /^--([a-z0-9-]+)=(.*)$/.exec(a);
    if (m) {
      const [, key, rawValue] = m;
      const value = rawValue.trim();
      switch (key) {
        case "base-url":
          flags.baseUrl = value;
          break;
        case "api-key":
          flags.apiKey = value;
          break;
        case "model":
          flags.model = value;
          break;
        case "plan-model":
          flags.planModel = value;
          break;
        case "synth-model":
          flags.synthModel = value;
          break;
        case "critic-model":
          flags.criticModel = value;
          break;
        case "max-cost":
          {
            const parsed = parseMaxCost(value);
            if (parsed === undefined) {
              throw new Error(
                `--max-cost must be a positive dollar amount (e.g. --max-cost=\$0.50 or --max-cost=5); got: ${value}`,
              );
            }
            flags.maxCostUsd = parsed;
          }
          break;
        case "max-tokens":
          flags.maxTokens = parsePositiveInt(value);
          break;
        case "search":
          flags.search = value.toLowerCase();
          break;
        case "results-per-query":
          flags.resultsPerQuery = parsePositiveInt(value);
          break;
        case "max-sources":
          flags.maxSources = parsePositiveInt(value);
          break;
        case "max-words-per-source":
          flags.maxWordsPerSource = parsePositiveInt(value);
          break;
        case "timeout-ms":
          flags.timeoutMs = parsePositiveInt(value);
          break;
        case "browser-cdp-endpoint":
          flags.browserCdpEndpoint = value;
          break;
        case "llm-timeout-ms":
          flags.llmTimeoutMs = parsePositiveInt(value);
          break;
        case "llm-attempts":
          flags.llmAttempts = parsePositiveInt(value);
          break;
        case "deep":
          flags.deepRounds = parseNonNegativeInt(value);
          break;
        case "concurrency":
          flags.concurrency = parsePositiveInt(value);
          break;
        case "cache-ttl-ms":
          flags.cacheTtlMs = parsePositiveInt(value);
          break;
        case "cite-min-recall":
          flags.citeMinRecall = parseUnitFloat(value);
          break;
        case "pdf-max-pages":
          flags.pdfMaxPages = parsePositiveInt(value);
          break;
        case "include":
          flags.include = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case "allow-domain":
          flags.allowDomain = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case "deny-domain":
          flags.denyDomain = value
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          break;
        case "api-format":
          if (value !== "anthropic" && value !== "openai") {
            throw new Error(
              `--api-format must be 'anthropic' or 'openai' (got: ${value})`,
            );
          }
          flags.apiFormat = value;
          break;
        case "out":
          outPath = value;
          break;
        case "profile":
          flags.profile = value;
          break;
        case "since":
          flags.since = value;
          break;
        case "format":
          flags.format = value.toLowerCase();
          break;
        case "older-than":
          flags.olderThan = value;
          break;
        case "keep":
          flags.keep = parseNonNegativeInt(value);
          break;
        default:
          throw new Error(`unknown flag: --${key}`);
      }
      continue;
    }
    if (a.startsWith("--")) {
      throw new Error(
        `flags must be in --key=value form (got: ${a}). See --help.`,
      );
    }
    if (question === undefined) {
      question = a;
      continue;
    }
    // Subcommand verbs (doctor / sessions / show / resume) take extra
    // positional arguments — capture them. Everything else gets the
    // "wrap the question in quotes" error so users don't accidentally
    // run an unquoted multi-word question.
    if (question !== undefined && SUBCOMMAND_VERBS.has(question)) {
      extras.push(a);
      continue;
    }
    throw new Error(
      `unexpected positional argument: ${JSON.stringify(a)}. Wrap the question in quotes.`,
    );
  }

  return { question, extras, outPath, flags, help };
}

function parsePositiveInt(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseNonNegativeInt(s: string): number | undefined {
  if (!/^\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parseUnitFloat(s: string): number | undefined {
  if (!/^\d+(\.\d+)?$|^\.\d+$/.test(s)) return undefined;
  const n = Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

function renderEvent(e: AgentEvent): string {
  switch (e.type) {
    case "plan.start":
      return `  plan    planning sub-queries for: ${ellipsize(e.question, 60)}`;
    case "plan.done":
      return `  plan    ${e.plan.queries.length} sub-queries`;
    case "round.start":
      return `  round   ${e.round === 0 ? "initial" : "deep " + e.round} · ${e.queries.length} quer${e.queries.length === 1 ? "y" : "ies"}`;
    case "search.start":
      return `  search  ${e.query}`;
    case "search.done":
      return `          ${e.count} result${e.count === 1 ? "" : "s"}`;
    case "fetch.start":
      return `  fetch   ${e.cached ? "(cached) " : ""}${e.url}`;
    case "fetch.done":
      return `          ${e.ok ? "OK " : "!! "}${e.status} · ${e.words} words${e.cached ? " · cache" : ""}`;
    case "fetch.skipped":
      return `  fetch   skipped (${e.reason}) ${e.url}`;
    case "include.done":
      return `  include ${e.ingested} ingested${e.skipped ? ` · ${e.skipped} skipped` : ""}`;
    case "synthesize.start":
      return `  synth   round ${e.round} · ${e.sourceCount} source${e.sourceCount === 1 ? "" : "s"}`;
    case "synthesize.done":
      return `  synth   round ${e.round} done`;
    case "critique.start":
      return `  critic  reviewing round ${e.round}`;
    case "critique.done":
      return e.critique.done
        ? `  critic  answer complete (${e.critique.reasoning || "no reasoning given"})`
        : `  critic  ${e.critique.queries.length} follow-up quer${e.critique.queries.length === 1 ? "y" : "ies"}`;
    case "verify.done": {
      const r = e.report;
      if (r.unsupported.length === 0) {
        return `  verify  ${r.supportedCitations}/${r.totalCitations} citations supported`;
      }
      const lines = [
        `  verify  ⚠ ${r.totalCitations - r.supportedCitations}/${r.totalCitations} citations weak (threshold ${r.threshold})`,
      ];
      for (const c of r.unsupported) {
        const worst = c.unsupportedIds
          .map((id) => `[${id}] ${c.recallByCite[id].toFixed(2)}`)
          .join(", ");
        lines.push(`          ⚠ "${ellipsize(c.sentence, 80)}" — ${worst}`);
      }
      return lines.join("\n");
    }
    case "llm.call":
      return `  llm     ${e.phase.padEnd(8)} ${e.inputTokens} in / ${e.outputTokens} out`;
  }
}

function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Renders the end-of-run cost summary line for stderr. Two-line variant
// when the LLM endpoint looks like dario (the "$0 on Max" hint applies),
// one-line otherwise. Exported for unit tests.
export function renderCostSummary(
  cost: CostEstimate,
  model: string,
  baseUrl: string,
): string {
  const head = "cost · " + formatCostLine(cost, model);
  if (!looksLikeDario(baseUrl)) return head;
  return head + "\n       (≈ at API list price; $0 on Claude Max via dario)";
}

/**
 * Multi-model cost summary. Used when the run spread requests across
 * models (v0.10.0 per-stage overrides). When only one model was used,
 * delegates to `renderCostSummary` so the output is identical to
 * pre-v0.10.0. When two or three models were used, prints the aggregate
 * line followed by one indented per-model line so the operator can see
 * where the dollars actually went.
 */
export function renderMultiModelCostSummary(
  cost: import("./pricing.js").MultiModelCostEstimate,
  baseUrl: string,
): string {
  if (cost.byModel.length <= 1) {
    const single = cost.byModel[0]?.model ?? "(no calls)";
    return renderCostSummary(cost, single, baseUrl);
  }
  // Aggregate line with no model name (multiple); each per-model line
  // breaks out tokens + dollars.
  const head = "cost · " + formatCostLine(cost, "multi-model");
  const breakdown = cost.byModel
    .map((m) => "       · " + formatCostLine(m.estimate, m.model))
    .join("\n");
  const lines = [head, breakdown];
  if (looksLikeDario(baseUrl)) {
    lines.push("       (≈ at API list price; $0 on Claude Max via dario)");
  }
  return lines.join("\n");
}

// Renders a small markdown footer when the verification report has any
// unsupported citations. Returns "" otherwise so clean runs stay clean.
// Exported for unit tests.
export function renderCitationHealthFooter(
  report: VerificationReport | undefined,
): string {
  if (!report || report.unsupported.length === 0) return "";
  const weak = report.totalCitations - report.supportedCitations;
  return (
    `\n## Citation health\n\n` +
    `⚠ ${weak} of ${report.totalCitations} citations have low lexical support ` +
    `in their cited source (threshold ${report.threshold}). ` +
    `Run with \`--verbose\` to see which.\n`
  );
}

// Exported for unit tests. User-facing error rendering at the CLI boundary.
// Runs the error message through scrubPath so the user's home directory can
// never end up in a bug report.
export function safeErrorMessage(err: unknown): string {
  const raw =
    err instanceof Error ? err.message : String(err ?? "unknown error");
  return scrubPath(raw);
}

// Matches the escaping used by renderAnswerMarkdown for the H1 heading — keep
// the streaming header identical to the buffered one so users can diff them.
function escapeHeader(s: string): string {
  return s.replace(/[\r\n]+/g, " ").replace(/\[/g, "(").replace(/\]/g, ")");
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  // `completion` needs no config; everything else gets config-file + profile
  // defaults layered beneath env (real env wins). Do this before any
  // resolveConfig so all subcommands see the same effective settings.
  if (parsed.question === "completion") {
    return completionCommand(parsed);
  }
  const cfgErr = applyConfigToEnv(parsed.flags);
  if (cfgErr) {
    process.stderr.write(`deepdive: ${cfgErr}\n`);
    return 2;
  }
  if (parsed.question === "doctor") {
    const config = resolveConfig(parsed.flags, process.env);
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    const report = await runDoctor({ config, env: process.env });
    const out = config.jsonOutput
      ? renderDoctorJson(report)
      : renderDoctorText(report, { color: useColor }) + "\n";
    process.stdout.write(out);
    return exitCodeFor(report);
  }
  if (parsed.question === "sessions") {
    return await sessionsCommand(parsed);
  }
  if (parsed.question === "show") {
    return await showCommand(parsed);
  }
  if (parsed.question === "resume") {
    return await resumeCommand(parsed);
  }
  if (parsed.question === "continue") {
    return await continueCommand(parsed);
  }
  if (parsed.question === "export") {
    return await exportCommand(parsed);
  }
  if (parsed.question === "diff") {
    return await diffCommand(parsed);
  }
  if (parsed.question === "search") {
    return await searchCommand(parsed);
  }
  if (parsed.question === "open") {
    return await openCommand(parsed);
  }
  if (parsed.question === "stats") {
    return await statsCommand(parsed);
  }
  if (!parsed.question) {
    process.stderr.write(`deepdive: missing question.\n\n${USAGE}`);
    return 2;
  }

  const config = resolveConfig(parsed.flags, process.env);
  return await runResearch({ question: parsed.question, parsed, config });
}

// Layer config-file base + selected-profile settings into process.env, filling
// only keys the real environment hasn't already set — so the effective
// precedence is: CLI flags > env vars > profile > config-file base > defaults.
// Returns an error string for a fatal problem (unknown profile); a malformed
// config file is a non-fatal warning. Mutating process.env keeps every
// downstream resolveConfig(flags, process.env) call config-aware with no
// plumbing changes.
function applyConfigToEnv(flags: CLIFlags): string | undefined {
  const loaded = loadConfigFile(process.env);
  if (loaded.error) {
    process.stderr.write(`deepdive: warning: ${loaded.error}; ignoring config file\n`);
  }
  const profileName = flags.profile ?? loaded.defaultProfile;
  let profileEnv: Record<string, string> = {};
  if (profileName) {
    try {
      profileEnv = fileConfigToEnv(resolveProfile(profileName, loaded.profiles));
    } catch (err) {
      return safeErrorMessage(err);
    }
  }
  // Profile wins over the file base within the file layer.
  const fileEnv = { ...fileConfigToEnv(loaded.base), ...profileEnv };
  for (const [k, v] of Object.entries(fileEnv)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
  return undefined;
}

function completionCommand(parsed: ParsedArgs): number {
  const shell = parsed.extras[0];
  if (shell !== "bash" && shell !== "zsh" && shell !== "fish") {
    process.stderr.write(
      `deepdive: completion requires a shell: bash | zsh | fish\n` +
        `  e.g. source <(deepdive completion bash)\n`,
    );
    return 2;
  }
  process.stdout.write(completionScript(shell as Shell));
  return 0;
}

// `deepdive search "<query>" [--search=<adapter>] [--json]` — run just the
// search adapter and print the raw candidate list. No LLM, no fetch, no
// browser — a cheap way to preview what a backend returns or debug an adapter.
async function searchCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const query = parsed.extras[0];
  if (!query) {
    process.stderr.write(
      `deepdive: search requires a query (e.g. deepdive search "rust async" --search=hackernews)\n`,
    );
    return 2;
  }
  let adapter;
  try {
    adapter = await resolveSearchAdapter(config.searchAdapter, process.env);
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  }
  const ac = new AbortController();
  const sigint = () => ac.abort();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);
  try {
    const count = parsed.flags.resultsPerQuery ?? 10;
    const results = await adapter.search(query, count, ac.signal);
    if (config.jsonOutput) {
      process.stdout.write(
        JSON.stringify({ adapter: adapter.name, query, results }, null, 2) + "\n",
      );
      return 0;
    }
    if (results.length === 0) {
      process.stdout.write(`(no results from ${adapter.name} for "${query}")\n`);
      return 0;
    }
    const lines = results.map((r) => {
      const snip = r.snippet
        ? `\n     ${ellipsize(r.snippet.replace(/\s+/g, " "), 100)}`
        : "";
      return `${String(r.rank).padStart(2)}. ${r.title || r.url}\n     ${r.url}${snip}`;
    });
    process.stdout.write(lines.join("\n") + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
  }
}

// `deepdive open <id> [--out=path]` — render a saved session to a self-
// contained HTML file (temp dir, or --out) and open it in the default browser.
// The browser spawn is best-effort; the file path is always printed so a
// headless box can open it manually.
async function openCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const idArg = parsed.extras[0];
  if (!idArg) {
    process.stderr.write(
      `deepdive: open requires a session id (try \`deepdive sessions ls\`)\n`,
    );
    return 2;
  }
  try {
    const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
    const record = await loadSession(id, { dir: config.sessions.dir });
    const file = parsed.outPath
      ? resolve(parsed.outPath)
      : join(tmpdir(), `deepdive-${id}.html`);
    writeFileSync(file, renderHtmlReport(record), "utf-8");
    const { cmd, args } = browserOpenCommand(process.platform, file);
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      // Opener missing (e.g. headless box with no xdg-open) is non-fatal — the
      // path is printed for manual opening.
      child.on("error", () => undefined);
      child.unref();
    } catch {
      /* non-fatal */
    }
    process.stderr.write(`opened ${file}\n`);
    process.stdout.write(file + "\n");
    return 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

// v0.12.0 — the shared research path used by both the default
// `deepdive "<question>"` invocation and `deepdive continue <id>`.
// Continue threads `preKept` (saved sources from the parent session)
// and `parentId` (lineage backlink for the new record) without
// duplicating the streaming / JSON / persistence / cost / SIGINT
// plumbing that the default path already implements.
interface RunResearchOptions {
  question: string;
  parsed: ParsedArgs;
  config: import("./config.js").RuntimeConfig;
  preKept?: import("./synthesize.js").SourceWithContent[];
  parentId?: string;
}

async function runResearch(opts: RunResearchOptions): Promise<number> {
  const { question, parsed, config, preKept, parentId } = opts;
  // A --since value that was supplied but didn't parse is a user error — fail
  // loud rather than silently running with no recency filter.
  if (config.sinceRaw && config.sinceMs === undefined) {
    process.stderr.write(
      `deepdive: --since must be a date (2024, 2024-06, 2024-06-15) or a duration ` +
        `(30d, 12h, 2w); got: ${config.sinceRaw}\n`,
    );
    return 2;
  }
  const search = await resolveSearchAdapter(config.searchAdapter, process.env);
  const cache = config.cache.enabled
    ? createCache({ dir: config.cache.dir, ttlMs: config.cache.ttlMs })
    : undefined;

  const ac = new AbortController();
  const sigint = () => ac.abort();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);

  // Live-streaming requires an attached TTY: escape sequences, partial line
  // writes, and interactive buffering behave weirdly when stdout is a pipe.
  // Env-var-only: tests can set FORCE_TTY=1 to exercise the streaming path
  // without a real terminal.
  const streaming =
    config.streamEnabled &&
    (process.stdout.isTTY || process.env.DEEPDIVE_FORCE_STREAM === "1");
  let streamed = false;

  try {
    if (streaming) {
      process.stdout.write(`# ${escapeHeader(question)}\n\n`);
    }
    const result = await runAgent(
      question,
      {
        llm: config.llm,
        models: config.models,
        maxCostUsd: config.maxCostUsd,
        preKept,
        search,
        browser: config.browser,
        resultsPerQuery: config.resultsPerQuery,
        maxSources: config.maxSources,
        maxWordsPerSource: config.maxWordsPerSource,
        deepRounds: config.deepRounds,
        concurrency: config.concurrency,
        cache,
        respectRobots: config.respectRobots,
        // Per-run in-memory robots.txt cache so each origin's robots.txt is
        // fetched once, not once per URL (dropped previously — the CLI never
        // supplied one, so canFetch's cache-miss path re-fetched every time).
        robotsCache: createRobotsCache(),
        verifyCitations: config.verifyCitations,
        citeMinRecall: config.citeMinRecall,
        pdfMaxPages: config.pdfMaxPages,
        include: config.include,
        domainFilter: config.domainFilter,
        tldr: config.tldr,
        sinceMs: config.sinceMs,
        env: process.env,
        onEvent: (e) => {
          if (config.verbose) process.stderr.write(renderEvent(e) + "\n");
          // In --deep streaming mode, prefix each round-after-the-first
          // synth with a separator + header so users can tell where one
          // draft ends and the next begins. Round 0's header is the
          // question (already printed above).
          if (
            streaming &&
            e.type === "synthesize.start" &&
            e.round > 0
          ) {
            process.stdout.write(
              `\n\n---\n\n## Round ${e.round} (deep)\n\n`,
            );
          }
        },
        onSynthesizeToken: streaming
          ? (chunk) => {
              streamed = true;
              process.stdout.write(chunk);
            }
          : undefined,
      },
      ac.signal,
    );

    const citeFooter = renderCitationHealthFooter(result.verification);
    const strictFail =
      config.strictCitations &&
      (result.verification?.unsupported.length ?? 0) > 0;

    // Persist the session before printing output. We do this even when
    // --strict-cites is going to make us exit 1 — the run happened, the
    // sources are real, and the user might want to inspect via `show`.
    let sessionId: string | undefined;
    if (config.sessions.enabled) {
      try {
        sessionId = await persistSession(question, result, config, parentId);
      } catch (err) {
        // Persistence failure is non-fatal — surface a warning to stderr
        // but don't break the run.
        process.stderr.write(
          `deepdive: warning: failed to save session (${safeErrorMessage(err)})\n`,
        );
      }
    }

    // Cost summary lands on stderr regardless of stdout mode (suppressed by
    // --no-cost / DEEPDIVE_NO_COST=1, and skipped for --json since the data
    // is in the JSON envelope already).
    // v0.10.0: result.cost is a MultiModelCostEstimate (superset of
    // CostEstimate). Per-stage models → multi-line breakdown; single
    // model → identical output to pre-v0.10.0.
    const costLine =
      config.costEnabled && !config.jsonOutput
        ? renderMultiModelCostSummary(result.cost, config.llm.baseUrl)
        : "";

    // Coverage/confidence signal — computed always (goes into --json), shown on
    // stderr alongside the cost summary (suppressed by --no-cost / --json).
    const confidence = assessConfidence({
      sources: result.usage.kept,
      citationsTotal: result.usage.citationsTotal,
      citationsSupported: result.usage.citationsSupported,
    });
    const confidenceLine =
      config.costEnabled && !config.jsonOutput ? formatConfidenceLine(confidence) : "";

    if (streaming && streamed) {
      // Streaming mode already wrote the header + answer tokens. Close with
      // the sources block, optional citation-health footer, and (if
      // requested) write the full markdown to the output file too.
      const tail = "\n\n" + renderSourcesMarkdown(result.sources) + citeFooter;
      process.stdout.write(tail);
      if (!tail.endsWith("\n")) process.stdout.write("\n");
      if (parsed.outPath) {
        const path = resolve(parsed.outPath);
        writeFileSync(path, result.markdown + citeFooter, "utf-8");
        process.stderr.write(`\nwrote ${path}\n`);
      }
      if (costLine) process.stderr.write(costLine + "\n");
      if (confidenceLine) process.stderr.write(confidenceLine + "\n");
      if (sessionId) writeSessionHint(sessionId);
      return strictFail ? 1 : 0;
    }

    const output = config.jsonOutput
      ? JSON.stringify(
          {
            question: result.question,
            plan: result.plan,
            rounds: result.rounds,
            sources: result.sources.map((s) => ({
              id: s.id,
              url: s.url,
              title: s.title,
              fetchedAt: s.fetchedAt,
              publishedAt: s.publishedAt,
            })),
            answer: result.answer,
            verification: result.verification,
            cost: result.cost,
            usage: result.usage,
            confidence,
          },
          null,
          2,
        ) + "\n"
      : result.markdown +
        (result.markdown.endsWith("\n") ? "" : "\n") +
        citeFooter;

    process.stdout.write(output);

    if (parsed.outPath) {
      const path = resolve(parsed.outPath);
      writeFileSync(path, output, "utf-8");
      process.stderr.write(`\nwrote ${path}\n`);
    }
    if (costLine) process.stderr.write(costLine + "\n");
    if (confidenceLine) process.stderr.write(confidenceLine + "\n");
    if (sessionId) writeSessionHint(sessionId);
    return strictFail ? 1 : 0;
  } catch (err) {
    // v0.11.0 — distinct exit code for "we deliberately stopped because
    // the budget cap was hit". Wrapping scripts can branch on `=== 2`
    // (cap) vs `=== 1` (real error).
    if (err instanceof BudgetExceededError) {
      process.stderr.write(`deepdive: ${err.message}\n`);
      return 2;
    }
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
  }
}

// Persist a finished agent run as a session record. Returns the new id.
// v0.12.0 — pass `parentId` to record the lineage when this run was
// invoked via `deepdive continue <id>`.
async function persistSession(
  question: string,
  result: import("./agent.js").AgentResult,
  config: import("./config.js").RuntimeConfig,
  parentId?: string,
): Promise<string> {
  const id = generateSessionId();
  const record = {
    schema: 1 as const,
    id,
    createdAt: Date.now(),
    question,
    plan: result.plan,
    rounds: result.rounds,
    sources: result.sources,
    answer: result.answer,
    verification: result.verification,
    cost: result.cost,
    llm: { baseUrl: config.llm.baseUrl, model: config.llm.model },
    ...(parentId ? { parentId } : {}),
  };
  await saveSession(record, { dir: config.sessions.dir });
  return id;
}

function writeSessionHint(id: string): void {
  process.stderr.write(`session  ${id}  (deepdive resume ${id})\n`);
}

async function sessionsCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const sub = parsed.extras[0] ?? "ls";
  switch (sub) {
    case "ls":
      return await sessionsLs(config, parsed.extras[1]);
    case "rm":
      return await sessionsRm(parsed, config);
    case "prune":
      return await sessionsPrune(parsed, config);
    default:
      process.stderr.write(
        `deepdive: unknown sessions sub-command: ${sub} (try: ls | rm | prune)\n`,
      );
      return 2;
  }
}

async function sessionsLs(
  config: import("./config.js").RuntimeConfig,
  filter?: string,
): Promise<number> {
  const { sessions, bad } = await listSessions({ dir: config.sessions.dir });
  // Optional case-insensitive substring filter on the question text.
  const needle = filter?.toLowerCase();
  const shown = needle
    ? sessions.filter((s) => s.question.toLowerCase().includes(needle))
    : sessions;
  if (config.jsonOutput) {
    process.stdout.write(JSON.stringify({ sessions: shown, bad }, null, 2) + "\n");
    return 0;
  }
  if (needle && shown.length === 0) {
    process.stdout.write(`(no sessions match "${filter}")\n`);
    return 0;
  }
  process.stdout.write(renderSessionsList(shown) + "\n");
  if (bad.length > 0) {
    process.stderr.write(
      `\n(${bad.length} session file${bad.length === 1 ? "" : "s"} could not be parsed)\n`,
    );
  }
  return 0;
}

// `deepdive stats [--json]` — aggregate insights across all saved sessions:
// run count, total calculated cost, sources/rounds, per-model breakdown, and
// the date span.
async function statsCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const { records, bad } = await loadAllSessions({ dir: config.sessions.dir });
  const stats = aggregateSessionStats(records);
  if (config.jsonOutput) {
    process.stdout.write(JSON.stringify({ stats, bad }, null, 2) + "\n");
    return 0;
  }
  process.stdout.write(renderStats(stats) + "\n");
  if (bad.length > 0) {
    process.stderr.write(
      `\n(${bad.length} session file${bad.length === 1 ? "" : "s"} could not be parsed)\n`,
    );
  }
  return 0;
}

async function sessionsRm(
  parsed: ParsedArgs,
  config: import("./config.js").RuntimeConfig,
): Promise<number> {
  const idArgs = parsed.extras.slice(1);
  if (idArgs.length === 0) {
    process.stderr.write(
      `deepdive: sessions rm requires at least one session id (try \`deepdive sessions ls\`)\n`,
    );
    return 2;
  }
  let failed = 0;
  for (const idArg of idArgs) {
    try {
      const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
      await deleteSession(id, { dir: config.sessions.dir });
      process.stdout.write(`removed ${id}\n`);
    } catch (err) {
      failed++;
      process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    }
  }
  return failed > 0 ? 1 : 0;
}

async function sessionsPrune(
  parsed: ParsedArgs,
  config: import("./config.js").RuntimeConfig,
): Promise<number> {
  const { olderThan, keep, dryRun } = parsed.flags;
  if (olderThan === undefined && keep === undefined) {
    process.stderr.write(
      `deepdive: sessions prune needs --older-than=<dur> and/or --keep=<n>\n` +
        `  e.g. deepdive sessions prune --older-than=30d\n` +
        `       deepdive sessions prune --keep=20\n` +
        `       deepdive sessions prune --older-than=7d --keep=5 --dry-run\n`,
    );
    return 2;
  }
  let olderThanMs: number | undefined;
  if (olderThan !== undefined) {
    olderThanMs = parseDuration(olderThan);
    if (olderThanMs === undefined) {
      process.stderr.write(
        `deepdive: --older-than must be a duration like 30d, 12h, 90m, 2w (got: ${olderThan})\n`,
      );
      return 2;
    }
  }
  const { removed, remaining, bad } = await pruneSessions(
    { dir: config.sessions.dir },
    { olderThanMs, keep, dryRun },
  );
  if (config.jsonOutput) {
    process.stdout.write(
      JSON.stringify({ removed, remaining, bad, dryRun: !!dryRun }, null, 2) + "\n",
    );
    return 0;
  }
  const verb = dryRun ? "would remove" : "removed";
  process.stdout.write(
    `${verb} ${removed.length} session${removed.length === 1 ? "" : "s"} · ${remaining} remaining\n`,
  );
  for (const m of removed) {
    const q = m.question.length > 60 ? m.question.slice(0, 59) + "…" : m.question;
    process.stdout.write(`  ${dryRun ? "-" : "✓"} ${m.id}  ${q}\n`);
  }
  if (bad.length > 0) {
    process.stderr.write(
      `\n(${bad.length} unparsable session file${bad.length === 1 ? "" : "s"} left in place)\n`,
    );
  }
  return 0;
}

// `deepdive export <id> [--format=html|md] [--out=path]` — render a saved
// session as a shareable artifact. HTML is a single self-contained document;
// md re-renders the original cited markdown. Format is inferred from --out's
// extension when not given, defaulting to html.
async function exportCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const idArg = parsed.extras[0];
  if (!idArg) {
    process.stderr.write(
      `deepdive: export requires a session id (try \`deepdive sessions ls\`)\n`,
    );
    return 2;
  }
  const format =
    parsed.flags.format ?? inferFormatFromPath(parsed.outPath) ?? "html";
  if (format !== "html" && format !== "md" && format !== "markdown") {
    process.stderr.write(`deepdive: --format must be html or md (got: ${format})\n`);
    return 2;
  }
  try {
    const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
    const record = await loadSession(id, { dir: config.sessions.dir });
    const output =
      format === "html"
        ? renderHtmlReport(record)
        : renderAnswerMarkdown(record.question, record.answer, record.sources) +
          renderCitationHealthFooter(record.verification);
    if (parsed.outPath) {
      const path = resolve(parsed.outPath);
      writeFileSync(path, output, "utf-8");
      process.stderr.write(`wrote ${path}\n`);
    } else {
      process.stdout.write(output + (output.endsWith("\n") ? "" : "\n"));
    }
    return 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  }
}

function inferFormatFromPath(p: string | undefined): string | undefined {
  if (!p) return undefined;
  const lower = p.toLowerCase();
  if (lower.endsWith(".html") || lower.endsWith(".htm")) return "html";
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) return "md";
  return undefined;
}

// `deepdive diff <id-a> <id-b> [--narrate] [--json]` — show how the answer
// (and the sources behind it) changed between two saved runs. The local-only
// longitudinal view. `--narrate` adds a one-shot LLM summary of the change.
async function diffCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const [idArgA, idArgB] = parsed.extras;
  if (!idArgA || !idArgB) {
    process.stderr.write(
      `deepdive: diff requires two session ids (try \`deepdive sessions ls\`)\n`,
    );
    return 2;
  }
  const ac = new AbortController();
  const sigint = () => ac.abort();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);
  try {
    const dir = { dir: config.sessions.dir };
    const a = await loadSession(await resolveSessionId(idArgA, dir), dir);
    const b = await loadSession(await resolveSessionId(idArgB, dir), dir);
    const diff = diffSessions(a, b);

    let narration: string | undefined;
    if (parsed.flags.narrate) {
      const { text } = await callLLM(
        [{ role: "user", content: buildDiffNarrateUser(a, b) }],
        DIFF_NARRATE_SYSTEM,
        config.llm,
        ac.signal,
      );
      narration = text.trim();
    }

    if (config.jsonOutput) {
      process.stdout.write(JSON.stringify({ diff, narration }, null, 2) + "\n");
      return 0;
    }
    const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
    process.stdout.write(renderDiffText(diff, { color: useColor }) + "\n");
    if (narration) {
      process.stdout.write(`\n## What changed (narrated)\n\n${narration}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
  }
}

async function showCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const idArg = parsed.extras[0];
  if (!idArg) {
    process.stderr.write(`deepdive: show requires a session id\n`);
    return 2;
  }
  const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
  const record = await loadSession(id, { dir: config.sessions.dir });
  // Re-render markdown from the stored answer + sources so it stays
  // identical to what the original run printed.
  const markdown = renderAnswerMarkdown(record.question, record.answer, record.sources);
  process.stdout.write(markdown + (markdown.endsWith("\n") ? "" : "\n"));
  return 0;
}

async function resumeCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const idArg = parsed.extras[0];
  if (!idArg) {
    process.stderr.write(`deepdive: resume requires a session id\n`);
    return 2;
  }
  const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
  const record = await loadSession(id, { dir: config.sessions.dir });
  const newQuestion = parsed.extras[1] ?? record.question;

  // Re-synthesize against the existing source corpus. No search, no
  // browser, no critic — this is the "I want to refine the question
  // without re-spending tokens on retrieval" path.
  const ac = new AbortController();
  const sigint = () => ac.abort();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);

  let usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  const onUsage = (u: { input_tokens: number; output_tokens: number }) => {
    usage.inputTokens += u.input_tokens ?? 0;
    usage.outputTokens += u.output_tokens ?? 0;
    usage.calls += 1;
  };

  const streaming =
    config.streamEnabled &&
    (process.stdout.isTTY || process.env.DEEPDIVE_FORCE_STREAM === "1");
  let streamed = false;

  try {
    if (streaming) {
      process.stdout.write(`# ${escapeHeader(newQuestion)}\n\n`);
    }
    // v0.10.0 — resume re-synthesizes against saved sources, so use the
    // synth-stage model (no plan / critic stages in resume mode).
    const synthLLM = { ...config.llm, model: config.models.synth };
    const answer = await synthesize(newQuestion, record.sources, synthLLM, ac.signal, {
      onToken: streaming
        ? (chunk) => {
            streamed = true;
            process.stdout.write(chunk);
          }
        : undefined,
      onUsage,
      tldr: config.tldr,
    });

    // Cite verification (final only — no in-loop because there's no loop)
    let verification;
    if (config.verifyCitations !== false && answer) {
      verification = runVerify(answer, record.sources, {
        threshold: config.citeMinRecall,
      });
    }
    const citeFooter = renderCitationHealthFooter(verification);
    const strictFail =
      config.strictCitations && (verification?.unsupported.length ?? 0) > 0;

    if (streaming && streamed) {
      const tail = "\n\n" + renderSourcesMarkdown(record.sources) + citeFooter;
      process.stdout.write(tail);
      if (!tail.endsWith("\n")) process.stdout.write("\n");
    } else {
      const md = renderAnswerMarkdown(newQuestion, answer, record.sources);
      process.stdout.write(md + (md.endsWith("\n") ? "" : "\n") + citeFooter);
    }

    if (config.costEnabled && !config.jsonOutput) {
      const cost = estimateCost(usage, synthLLM.model, process.env);
      process.stderr.write(
        renderCostSummary(cost, synthLLM.model, config.llm.baseUrl) + "\n",
      );
    }
    process.stderr.write(`session  resumed from ${id}\n`);
    return strictFail ? 1 : 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
  }
}

// v0.12.0 — `deepdive continue <id> [<refined-question>]`. Unlike
// `resume` (which is the cheap "re-ask the same corpus" path),
// `continue` runs a full agent loop — search included — with the
// saved sources seeded into the kept-sources pool. The new run is
// persisted with `parentId` set to the original id so the lineage
// is recoverable. The typical use is: original run got close,
// follow-up question wants the planner to fetch a few more pages
// without losing the corpus the user already paid for.
async function continueCommand(parsed: ParsedArgs): Promise<number> {
  const config = resolveConfig(parsed.flags, process.env);
  const idArg = parsed.extras[0];
  if (!idArg) {
    process.stderr.write(
      `deepdive: continue requires a session id (try \`deepdive sessions ls\`)\n`,
    );
    return 2;
  }
  const id = await resolveSessionId(idArg, { dir: config.sessions.dir });
  const record = await loadSession(id, { dir: config.sessions.dir });
  // Refined question wins; falls back to the parent's. Lets the user
  // type just `deepdive continue <id>` to run again from where they
  // left off with new search results.
  const newQuestion = parsed.extras[1] ?? record.question;
  return await runResearch({
    question: newQuestion,
    parsed,
    config,
    preKept: record.sources,
    parentId: id,
  });
}

// Only run main() when invoked as a script, not when imported (e.g. by tests
// that exercise `parseArgs` in isolation).
const isEntryPoint =
  process.argv[1] !== undefined &&
  (() => {
    try {
      return process.argv[1] === fileURLToPath(import.meta.url);
    } catch {
      return false;
    }
  })();

if (isEntryPoint) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
