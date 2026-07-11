// MCP server mode — `deepdive mcp` exposes the research agent as a Model
// Context Protocol tool over stdio, so agent harnesses (Claude Code, MCP-
// aware IDEs, other agents) can hand their model a research tool that shows
// its work: every call returns the cited answer PLUS the source-trust mix,
// citation-verification numbers, confidence, and cost — the same signals the
// CLI reports, in one text block the calling model can read.
//
// Protocol discipline: stdout is the MCP channel. Progress goes to stderr
// only (clients that inherit stderr can watch a run move); nothing in this
// module may write to stdout.
//
// Configuration flows exactly like the CLI: env (DEEPDIVE_BASE_URL,
// DEEPDIVE_API_KEY, DEEPDIVE_SEARCH, …) supplies defaults via the MCP
// client's `env` block; per-call tool arguments override, using the same
// resolveConfig path as CLI flags so the two surfaces can't drift.
//
// Sessions are disabled (an MCP tool call is stateless) and every call gets
// a wall-clock deadline (default 10m) enforced with an AbortSignal — a
// server must never process.exit the way the CLI's runtime backstop does.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { resolveConfig, type CLIFlags } from "./config.js";
import { resolveSearchAdapter, normalizeAdapterList, type SearchAdapter } from "./search.js";
import { runAgent, NoSourcesError, type AgentEvent } from "./agent.js";
import { BudgetExceededError } from "./budget.js";
import { summarizeSourceTrust } from "./source-authority.js";
import { assessConfidence, formatConfidenceLine } from "./confidence.js";
import { createRobotsCache } from "./robots.js";
import { createCache } from "./cache.js";

export interface ResearchToolArgs {
  question: string;
  search?: string;
  allow_domains?: string[];
  deny_domains?: string[];
  since?: string;
  deep?: number;
  max_cost_usd?: number;
  max_sources?: number;
  source_authority?: "prefer" | "strict" | "off";
  max_runtime?: string;
}

// Exported for tests — the pure mapping from MCP tool arguments to the CLI
// flag surface. Everything not mapped here falls through to env defaults in
// resolveConfig, exactly as it would for a bare CLI invocation.
export function flagsFromToolArgs(args: ResearchToolArgs): CLIFlags {
  const flags: CLIFlags = { noSessions: true };
  if (args.search !== undefined) flags.search = args.search;
  if (args.allow_domains !== undefined) flags.allowDomain = args.allow_domains;
  if (args.deny_domains !== undefined) flags.denyDomain = args.deny_domains;
  if (args.since !== undefined) flags.since = args.since;
  if (args.deep !== undefined) flags.deepRounds = args.deep;
  if (args.max_cost_usd !== undefined) flags.maxCostUsd = args.max_cost_usd;
  if (args.max_sources !== undefined) flags.maxSources = args.max_sources;
  if (args.source_authority !== undefined) flags.sourceAuthority = args.source_authority;
  flags.maxRuntime = args.max_runtime ?? "10m";
  return flags;
}

// Exported for tests — the stats footer appended to every successful answer,
// built from the same primitives the CLI reports (trust mix, citation
// support, confidence, cost). One line each; the calling model reads these
// as trust signals rather than prose.
export function renderResearchFooter(result: {
  sources: { url: string }[];
  usage: {
    kept: number;
    citationsTotal: number;
    citationsSupported: number;
  };
  cost: { amountUsd: number; knownModel: boolean };
}): string {
  const trust = summarizeSourceTrust(result.sources.map((s) => s.url));
  const c = trust.counts;
  const confidence = assessConfidence({
    sources: result.usage.kept,
    citationsTotal: result.usage.citationsTotal,
    citationsSupported: result.usage.citationsSupported,
  });
  const lines = [
    "---",
    `source trust: ${trust.label} (${c.primary}P ${c.reputable}R ${c.unknown}U ${c.low}L)`,
    `citations supported: ${result.usage.citationsSupported}/${result.usage.citationsTotal}`,
    formatConfidenceLine(confidence),
    `cost: $${result.cost.amountUsd.toFixed(3)}${result.cost.knownModel ? "" : " (unknown model — unpriced calls excluded)"}`,
  ];
  return lines.join("\n");
}

// The default runner: assemble the agent exactly the way the CLI does and
// return the full markdown answer + stats footer as one text block.
async function runResearchDefault(args: ResearchToolArgs): Promise<string> {
  const config = resolveConfig(flagsFromToolArgs(args), process.env);
  if (config.maxRuntimeMs === undefined) {
    throw new Error(`invalid max_runtime: ${config.maxRuntimeRaw} (use 90s, 10m, 1h)`);
  }
  let search: SearchAdapter;
  let fallbackSearch: SearchAdapter | undefined;
  search = await resolveSearchAdapter(config.searchAdapter, process.env, config.sourceAuthority);
  if (config.searchFallback) {
    const fallbackName = normalizeAdapterList(config.searchFallback);
    if (fallbackName && fallbackName !== config.searchAdapter) {
      fallbackSearch = await resolveSearchAdapter(fallbackName, process.env, config.sourceAuthority);
    }
  }
  const cache = config.cache.enabled
    ? createCache({ dir: config.cache.dir, ttlMs: config.cache.ttlMs })
    : undefined;

  const result = await runAgent(
    args.question,
    {
      llm: config.llm,
      models: config.models,
      maxCostUsd: config.maxCostUsd,
      search,
      fallbackSearch,
      browser: config.browser,
      resultsPerQuery: config.resultsPerQuery,
      maxSources: config.maxSources,
      maxWordsPerSource: config.maxWordsPerSource,
      deepRounds: config.deepRounds,
      concurrency: config.concurrency,
      cache,
      respectRobots: config.respectRobots,
      robotsCache: createRobotsCache(),
      verifyCitations: config.verifyCitations,
      citeMinRecall: config.citeMinRecall,
      pdfMaxPages: config.pdfMaxPages,
      domainFilter: config.domainFilter,
      tldr: config.tldr,
      sinceMs: config.sinceMs,
      dedupeNearDupes: config.dedupeNearDupes,
      nearDupeThreshold: config.nearDupeThreshold,
      sourceAuthority: config.sourceAuthority,
      env: process.env,
      onEvent: logProgress,
    },
    AbortSignal.timeout(config.maxRuntimeMs),
  );

  return `${result.markdown}\n\n${renderResearchFooter(result)}`;
}

// Sparse per-run progress on stderr — enough for a human tailing the server
// to see a call move, quiet enough not to drown multi-call sessions.
function logProgress(e: AgentEvent): void {
  switch (e.type) {
    case "round.start":
      console.error(`deepdive-mcp: round ${e.round} · ${e.queries.length} queries`);
      break;
    case "search.hinted":
      console.error(`deepdive-mcp: retrying with domain hint (${e.hosts.join(", ")})`);
      break;
    case "search.fallback":
      console.error(`deepdive-mcp: primary search empty — falling back to ${e.adapter}`);
      break;
    case "search.fallback-skipped":
      console.error(`deepdive-mcp: fallback (${e.adapter}) skipped — cannot satisfy allow_domains`);
      break;
    case "synthesize.start":
      console.error(`deepdive-mcp: synthesizing from ${e.sourceCount} sources`);
      break;
  }
}

// A failed run must come back as tool output the calling model can act on,
// not a protocol error — NoSourcesError carries the honest #147 diagnostics
// and BudgetExceededError names the cap that fired.
function renderToolError(err: unknown): string {
  if (err instanceof NoSourcesError) {
    const lines = [err.message];
    if (err.fallbackSkipped) {
      lines.push(`fallback (${err.fallbackSkipped}) skipped: its results cannot satisfy allow_domains.`);
    }
    if (err.droppedByDomainFilter > 0) {
      lines.push(
        `search worked — the domain filter dropped all ${err.droppedByDomainFilter} result(s); widen allow_domains or check the host publishes on this topic.`,
      );
    }
    return lines.join("\n");
  }
  if (err instanceof BudgetExceededError) return err.message;
  if (err instanceof Error && err.name === "TimeoutError") {
    return "research run exceeded max_runtime and was aborted — raise max_runtime or narrow the question";
  }
  return err instanceof Error ? err.message : String(err);
}

export interface CreateMcpServerOptions {
  version: string;
  // Test seam: protocol-level tests inject a fake runner so no network, LLM,
  // or browser is touched.
  runResearch?: (args: ResearchToolArgs) => Promise<string>;
}

export function createDeepdiveMcpServer(opts: CreateMcpServerOptions): { server: McpServer } {
  const server = new McpServer({ name: "deepdive", version: opts.version });
  const run = opts.runResearch ?? runResearchDefault;

  server.registerTool(
    "deepdive_research",
    {
      title: "Research a question with cited, trust-scored sources",
      description:
        "Run deepdive's research agent: plan sub-queries, search the web, fetch and extract sources, " +
        "synthesize a cited answer, and lexically verify every citation. Returns the answer in markdown " +
        "followed by trust signals: the source-trust mix (primary/reputable/unknown/low), how many " +
        "citations survived verification, a confidence grade, and the LLM cost. Runs take one to " +
        "several minutes depending on the question. Uses the server's configured LLM endpoint and " +
        "search backends; results never leave your machine.",
      inputSchema: {
        question: z.string().min(1).describe("The research question to investigate"),
        search: z
          .string()
          .optional()
          .describe(
            "Search backend override: duckduckgo, searxng, wikipedia, arxiv, stackexchange, news, github, " +
              "pubmed, or a fan-out like multi:duckduckgo,wikipedia,arxiv (default: DEEPDIVE_SEARCH or duckduckgo)",
          ),
        allow_domains: z
          .array(z.string())
          .optional()
          .describe("Keep ONLY sources whose hostname matches one of these suffixes (e.g. nvlpubs.nist.gov)"),
        deny_domains: z
          .array(z.string())
          .optional()
          .describe("Drop sources whose hostname matches any of these suffixes (e.g. pinterest.com)"),
        since: z
          .string()
          .optional()
          .describe("Drop sources published before this: a date (2025, 2025-06) or duration ago (30d, 12h, 2w)"),
        deep: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe("Critic-loop rounds after the first draft (default 0; each round adds time and cost)"),
        max_cost_usd: z.number().positive().optional().describe("Abort if the run's LLM cost would exceed this"),
        max_sources: z.number().int().min(1).max(24).optional().describe("Cap on kept sources (default 12)"),
        source_authority: z
          .enum(["prefer", "strict", "off"])
          .optional()
          .describe("Domain-authority ranking: prefer (default), strict (drop known content farms), off"),
        max_runtime: z
          .string()
          .optional()
          .describe("Wall-clock cap for the run, e.g. 90s, 10m (default 10m)"),
      },
      annotations: {
        readOnlyHint: true,
        openWorldHint: true,
      },
    },
    async (args: ResearchToolArgs) => {
      try {
        const text = await run(args);
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return {
          content: [{ type: "text" as const, text: renderToolError(err) }],
          isError: true,
        };
      }
    },
  );

  return { server };
}

// Entry point used by `deepdive mcp` — resolves when the client disconnects
// (transport close), so the CLI can exit 0 without a process.exit racing
// in-flight protocol writes.
export async function startMcpStdio(version: string): Promise<void> {
  const { server } = createDeepdiveMcpServer({ version });
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    transport.onclose = () => resolve();
  });
  await server.connect(transport);
  console.error(`deepdive-mcp: v${version} listening on stdio (tool: deepdive_research)`);
  await closed;
}
