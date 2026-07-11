// MCP server mode. Protocol-level tests use the SDK's in-memory transport
// pair with an injected fake research runner — no network, no LLM, no
// browser. One stdio smoke test spawns the real `deepdive mcp` entrypoint to
// prove stdout stays a clean protocol channel end-to-end.

import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  createDeepdiveMcpServer,
  flagsFromToolArgs,
  renderResearchFooter,
} from "../dist/mcp.js";
import { NoSourcesError } from "../dist/agent.js";

async function connectedPair(opts) {
  const { server } = createDeepdiveMcpServer({ version: "0.0.0-test", ...opts });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("mcp: lists deepdive_research with its input schema", async () => {
  const { client } = await connectedPair({ runResearch: async () => "unused" });
  const tools = await client.listTools();
  assert.equal(tools.tools.length, 1);
  const tool = tools.tools[0];
  assert.equal(tool.name, "deepdive_research");
  assert.ok(tool.description.includes("trust"), "description sells the trust signals");
  const props = tool.inputSchema.properties;
  for (const key of [
    "question", "search", "allow_domains", "deny_domains", "since",
    "deep", "max_cost_usd", "max_sources", "source_authority", "max_runtime",
  ]) {
    assert.ok(key in props, `schema exposes ${key}`);
  }
  assert.deepEqual(tool.inputSchema.required, ["question"]);
});

test("mcp: callTool returns the runner's text and threads the arguments", async () => {
  const seen = [];
  const { client } = await connectedPair({
    runResearch: async (args) => {
      seen.push(args);
      return "# Answer\n\nGrounded [1].";
    },
  });
  const res = await client.callTool({
    name: "deepdive_research",
    arguments: {
      question: "what is QUIC connection migration",
      allow_domains: ["rfc-editor.org"],
      deep: 1,
    },
  });
  assert.equal(res.isError ?? false, false);
  assert.equal(res.content[0].type, "text");
  assert.match(res.content[0].text, /Grounded \[1\]/);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].question, "what is QUIC connection migration");
  assert.deepEqual(seen[0].allow_domains, ["rfc-editor.org"]);
  assert.equal(seen[0].deep, 1);
});

test("mcp: a NoSourcesError comes back as isError tool output with the honest diagnostics", async () => {
  const { client } = await connectedPair({
    runResearch: async () => {
      throw new NoSourcesError("multi(searxng,wikipedia)", ["q1", "q2"], 0, [], {
        droppedByDomainFilter: 9,
        fallbackSkipped: "wikipedia",
      });
    },
  });
  const res = await client.callTool({
    name: "deepdive_research",
    arguments: { question: "q", allow_domains: ["nvlpubs.nist.gov"] },
  });
  assert.equal(res.isError, true);
  const text = res.content[0].text;
  assert.match(text, /domain filter dropped every one/);
  assert.match(text, /fallback \(wikipedia\) skipped/);
  assert.match(text, /widen allow_domains/);
});

test("mcp: missing question is rejected at the schema layer, runner never runs", async () => {
  let ran = 0;
  const { client } = await connectedPair({
    runResearch: async () => {
      ran++;
      return "nope";
    },
  });
  const res = await client.callTool({ name: "deepdive_research", arguments: {} });
  assert.equal(res.isError, true);
  assert.equal(ran, 0);
});

// ── pure helpers ─────────────────────────────────────────────────────────────

test("flagsFromToolArgs: maps tool args onto the CLI flag surface, stateless defaults", () => {
  const flags = flagsFromToolArgs({
    question: "q",
    search: "multi:searxng,wikipedia",
    allow_domains: ["nist.gov"],
    deny_domains: ["pinterest.com"],
    since: "30d",
    deep: 2,
    max_cost_usd: 0.5,
    max_sources: 8,
    source_authority: "strict",
    max_runtime: "5m",
  });
  assert.equal(flags.search, "multi:searxng,wikipedia");
  assert.deepEqual(flags.allowDomain, ["nist.gov"]);
  assert.deepEqual(flags.denyDomain, ["pinterest.com"]);
  assert.equal(flags.since, "30d");
  assert.equal(flags.deepRounds, 2);
  assert.equal(flags.maxCostUsd, 0.5);
  assert.equal(flags.maxSources, 8);
  assert.equal(flags.sourceAuthority, "strict");
  assert.equal(flags.maxRuntime, "5m");
  assert.equal(flags.noSessions, true, "MCP calls are stateless");
});

test("flagsFromToolArgs: defaults — sessions off, 10m runtime cap, everything else falls to env", () => {
  const flags = flagsFromToolArgs({ question: "q" });
  assert.deepEqual(flags, { noSessions: true, maxRuntime: "10m" });
});

test("renderResearchFooter: trust mix, citation support, confidence, cost", () => {
  const footer = renderResearchFooter({
    sources: [
      { url: "https://nvlpubs.nist.gov/doc.pdf" },
      { url: "https://en.wikipedia.org/wiki/x" },
    ],
    usage: { kept: 2, citationsTotal: 15, citationsSupported: 14 },
    cost: { amountUsd: 0.052, knownModel: true },
  });
  assert.match(footer, /source trust: high \(1P 1R 0U 0L\)/);
  assert.match(footer, /citations supported: 14\/15/);
  assert.match(footer, /confidence/i);
  assert.match(footer, /cost: \$0\.052/);
  assert.doesNotMatch(footer, /unknown model/);
});

// ── stdio smoke: the real entrypoint keeps stdout protocol-clean ─────────────

test("mcp: `deepdive mcp` over real stdio lists tools and shuts down on close", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["dist/cli.js", "mcp"],
    stderr: "pipe",
  });
  const client = new Client({ name: "stdio-smoke", version: "0.0.0" });
  await client.connect(transport);
  try {
    const tools = await client.listTools();
    assert.equal(tools.tools[0].name, "deepdive_research");
  } finally {
    await client.close();
  }
});
