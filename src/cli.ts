#!/usr/bin/env node
// deepdive CLI entry.
//
//   deepdive "how does claude's rate limiter work"
//   deepdive "..." --model=claude-opus-4-7 --search=brave --out=report.md
//   deepdive --help
//
// Prints the cited markdown report to stdout. Progress events go to stderr
// when --verbose is set or DEEPDIVE_VERBOSE=1.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveConfig, type CLIFlags } from "./config.js";
import { resolveSearchAdapter } from "./search.js";
import { runAgent, type AgentEvent } from "./agent.js";

const USAGE = `deepdive — local research agent

Usage:
  deepdive "<question>" [flags]

Flags:
  --base-url=<url>              LLM endpoint. Default: http://localhost:3456 (dario)
  --api-key=<key>               LLM API key. Default: dario
  --model=<name>                Model to use. Default: claude-sonnet-4-6
  --max-tokens=<n>              Output max tokens per LLM call. Default: 4096
  --search=<adapter>            Search adapter: duckduckgo | searxng | brave | tavily
                                Default: duckduckgo (no key required)
  --results-per-query=<n>       Results per sub-query. Default: 5
  --max-sources=<n>             Total sources to fetch. Default: 12
  --max-words-per-source=<n>    Per-source content cap before synthesis. Default: 2000
  --timeout-ms=<ms>             Per-fetch timeout. Default: 30000
  --out=<path>                  Write markdown to a file (also prints to stdout)
  --verbose, -v                 Stream progress events to stderr
  --help, -h                    Show this help

Environment:
  DEEPDIVE_BASE_URL, DEEPDIVE_API_KEY, DEEPDIVE_MODEL, DEEPDIVE_SEARCH,
  DEEPDIVE_SEARXNG_URL, DEEPDIVE_BRAVE_KEY, DEEPDIVE_TAVILY_KEY,
  DEEPDIVE_MAX_SOURCES, DEEPDIVE_FETCH_TIMEOUT_MS, DEEPDIVE_HEADED,
  DEEPDIVE_VERBOSE
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

function renderEvent(e: AgentEvent): string {
  switch (e.type) {
    case "plan.start":
      return `  plan    planning sub-queries for: ${ellipsize(e.question, 60)}`;
    case "plan.done":
      return `  plan    ${e.plan.queries.length} sub-queries`;
    case "search.start":
      return `  search  ${e.query}`;
    case "search.done":
      return `          ${e.count} result${e.count === 1 ? "" : "s"}`;
    case "fetch.start":
      return `  fetch   ${e.url}`;
    case "fetch.done":
      return `          ${e.ok ? "OK " : "!! "}${e.status} · ${e.words} words`;
    case "synthesize.start":
      return `  synth   synthesizing from ${e.sourceCount} source${e.sourceCount === 1 ? "" : "s"}`;
    case "synthesize.done":
      return `  synth   done`;
  }
}

function ellipsize(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`deepdive: ${(err as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!parsed.question) {
    process.stderr.write(`deepdive: missing question.\n\n${USAGE}`);
    return 2;
  }

  const config = resolveConfig(parsed.flags, process.env);
  const search = await resolveSearchAdapter(config.searchAdapter, process.env);

  const ac = new AbortController();
  const sigint = () => ac.abort();
  process.on("SIGINT", sigint);
  process.on("SIGTERM", sigint);

  try {
    const result = await runAgent(
      parsed.question,
      {
        llm: config.llm,
        search,
        browser: config.browser,
        resultsPerQuery: config.resultsPerQuery,
        maxSources: config.maxSources,
        maxWordsPerSource: config.maxWordsPerSource,
        onEvent: (e) => {
          if (config.verbose) process.stderr.write(renderEvent(e) + "\n");
        },
      },
      ac.signal,
    );

    process.stdout.write(result.markdown);
    if (!result.markdown.endsWith("\n")) process.stdout.write("\n");

    if (parsed.outPath) {
      const path = resolve(parsed.outPath);
      writeFileSync(path, result.markdown, "utf-8");
      process.stderr.write(`\nwrote ${path}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`deepdive: ${(err as Error).message}\n`);
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
