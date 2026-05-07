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
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type CLIFlags } from "./config.js";
import { resolveSearchAdapter } from "./search.js";
import { runAgent, type AgentEvent } from "./agent.js";
import { createCache } from "./cache.js";
import { renderSourcesMarkdown } from "./citations.js";
import type { VerificationReport } from "./verify.js";
import {
  formatCostLine,
  looksLikeDario,
  type CostEstimate,
} from "./pricing.js";
import {
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  exitCodeFor,
  scrubPath,
} from "./doctor.js";

const USAGE = `deepdive — local research agent

Usage:
  deepdive "<question>" [flags]      Run the research agent
  deepdive doctor [flags]            Health check — paste the output when filing issues
  deepdive --help                    Show this help

Flags:
  --base-url=<url>              LLM endpoint. Default: http://localhost:3456 (dario)
  --api-key=<key>               LLM API key. Default: dario
  --model=<name>                Model to use. Default: claude-sonnet-4-6
  --max-tokens=<n>              Output max tokens per LLM call. Default: 4096
  --search=<adapter>            Search adapter: duckduckgo | searxng | brave | tavily | exa
                                Default: duckduckgo (no key required)
  --results-per-query=<n>       Results per sub-query. Default: 5
  --max-sources=<n>             Total sources to fetch. Default: 12
  --max-words-per-source=<n>    Per-source content cap before synthesis. Default: 2000
  --timeout-ms=<ms>             Per-fetch (browser) timeout. Default: 30000
  --llm-timeout-ms=<ms>         Per-LLM-call timeout. Default: 120000 (2 min)
  --llm-attempts=<n>            Max LLM attempts per call (with exponential
                                backoff on 5xx/429/network errors). Default: 3
  --deep[=<n>]                  Iterative research: run N additional critic-driven
                                rounds after the first synthesis. Default when
                                bare: 2. No deep pass when flag absent.
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
  --api-format=<anthropic|openai>
                                Wire format for the LLM endpoint. Default:
                                auto-detected from --base-url (api.openai.com,
                                :11434 (Ollama), :8000 default to openai;
                                everything else to anthropic).
  --json                        Emit a JSON result to stdout instead of markdown
  --out=<path>                  Write the output (markdown or json) to a file too
  --verbose, -v                 Stream progress events to stderr
  --no-stream                   Buffer the final answer instead of streaming
                                tokens to stdout (auto-off for --json, deep
                                mode, and non-TTY stdout)
  --help, -h                    Show this help

Environment:
  DEEPDIVE_BASE_URL, DEEPDIVE_API_KEY, DEEPDIVE_MODEL, DEEPDIVE_SEARCH,
  DEEPDIVE_SEARXNG_URL, DEEPDIVE_BRAVE_KEY, DEEPDIVE_TAVILY_KEY, DEEPDIVE_EXA_KEY,
  DEEPDIVE_MAX_SOURCES, DEEPDIVE_FETCH_TIMEOUT_MS, DEEPDIVE_HEADED,
  DEEPDIVE_DEEP_ROUNDS, DEEPDIVE_CONCURRENCY, DEEPDIVE_NO_CACHE,
  DEEPDIVE_CACHE_DIR, DEEPDIVE_CACHE_TTL_MS, DEEPDIVE_JSON, DEEPDIVE_VERBOSE,
  DEEPDIVE_LLM_TIMEOUT_MS, DEEPDIVE_LLM_ATTEMPTS,
  DEEPDIVE_NO_VERIFY_CITES, DEEPDIVE_STRICT_CITES, DEEPDIVE_CITE_MIN_RECALL,
  DEEPDIVE_NO_COST, DEEPDIVE_PRICE_INPUT_PER_MTOK, DEEPDIVE_PRICE_OUTPUT_PER_MTOK,
  DEEPDIVE_INCLUDE, DEEPDIVE_PDF_MAX_PAGES,
  DEEPDIVE_ALLOW_DOMAIN, DEEPDIVE_DENY_DOMAIN, DEEPDIVE_API_FORMAT
`;

interface ParsedArgs {
  question?: string;
  outPath?: string;
  flags: CLIFlags;
  help: boolean;
}

// Exported for unit tests.
export function parseArgs(argv: string[]): ParsedArgs {
  const flags: CLIFlags = {};
  let question: string | undefined;
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
    if (a === "--json") {
      flags.json = true;
      continue;
    }
    if (a === "--no-stream") {
      flags.noStream = true;
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
    throw new Error(
      `unexpected positional argument: ${JSON.stringify(a)}. Wrap the question in quotes.`,
    );
  }

  return { question, outPath, flags, help };
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
  if (!parsed.question) {
    process.stderr.write(`deepdive: missing question.\n\n${USAGE}`);
    return 2;
  }

  const config = resolveConfig(parsed.flags, process.env);
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
      process.stdout.write(`# ${escapeHeader(parsed.question)}\n\n`);
    }
    const result = await runAgent(
      parsed.question,
      {
        llm: config.llm,
        search,
        browser: config.browser,
        resultsPerQuery: config.resultsPerQuery,
        maxSources: config.maxSources,
        maxWordsPerSource: config.maxWordsPerSource,
        deepRounds: config.deepRounds,
        concurrency: config.concurrency,
        cache,
        respectRobots: config.respectRobots,
        verifyCitations: config.verifyCitations,
        citeMinRecall: config.citeMinRecall,
        pdfMaxPages: config.pdfMaxPages,
        include: config.include,
        domainFilter: config.domainFilter,
        env: process.env,
        onEvent: (e) => {
          if (config.verbose) process.stderr.write(renderEvent(e) + "\n");
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

    // Cost summary lands on stderr regardless of stdout mode (suppressed by
    // --no-cost / DEEPDIVE_NO_COST=1, and skipped for --json since the data
    // is in the JSON envelope already).
    const costLine =
      config.costEnabled && !config.jsonOutput
        ? renderCostSummary(result.cost, config.llm.model, config.llm.baseUrl)
        : "";

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
            })),
            answer: result.answer,
            verification: result.verification,
            cost: result.cost,
            usage: result.usage,
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
    return strictFail ? 1 : 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${safeErrorMessage(err)}\n`);
    return 1;
  } finally {
    process.off("SIGINT", sigint);
    process.off("SIGTERM", sigint);
  }
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
