import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  runDoctor,
  renderDoctorText,
  renderDoctorJson,
  exitCodeFor,
  scrubPath,
  formatBytes,
  formatDuration,
  classifyFetchError,
  nodeMeetsMinimum,
} from "../dist/doctor.js";

// ───── pure helpers ─────────────────────────────────────────────────────────

test("scrubPath: home dir replaced with ~, backslashes normalized", () => {
  const home = homedir();
  const input = `error opening ${home}\\some\\file.json`;
  const out = scrubPath(input);
  assert.ok(!out.includes(home), `home should be scrubbed: ${out}`);
  assert.ok(out.includes("~"), `should contain ~: ${out}`);
  assert.ok(!out.includes("\\"), `backslashes should be forward: ${out}`);
});

test("scrubPath: string with no home dir is unchanged except slashes", () => {
  assert.equal(scrubPath("/var/log/foo"), "/var/log/foo");
  assert.equal(scrubPath("a/b/c"), "a/b/c");
});

test("formatBytes", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1024 * 1024 * 1024), "1.00 GB");
  assert.equal(formatBytes(1500), "1.5 KB");
});

test("formatDuration", () => {
  assert.equal(formatDuration(500), "0s");
  assert.equal(formatDuration(1_500), "1s");
  assert.equal(formatDuration(60_000), "1m");
  assert.equal(formatDuration(61_000), "1m");
  assert.equal(formatDuration(3_600_000), "1h");
  assert.equal(formatDuration(86_400_000), "1d");
});

test("classifyFetchError: ECONNREFUSED", () => {
  const err = new Error("fetch failed: ECONNREFUSED 127.0.0.1:3456");
  assert.match(classifyFetchError(err), /connection refused/);
});

test("classifyFetchError: ENOTFOUND", () => {
  const err = new Error("getaddrinfo ENOTFOUND bogus.example");
  assert.match(classifyFetchError(err), /DNS failure/);
});

test("classifyFetchError: timeout", () => {
  const err = new Error("The operation was aborted due to timeout (TimeoutError)");
  assert.match(classifyFetchError(err), /timeout/);
});

test("classifyFetchError: home paths scrubbed in fallthrough", () => {
  const home = homedir();
  const err = new Error(`some weird error involving ${home}/secret`);
  const out = classifyFetchError(err);
  assert.ok(!out.includes(home), `home should be scrubbed: ${out}`);
});

test("nodeMeetsMinimum", () => {
  assert.equal(nodeMeetsMinimum("v20.0.0"), true);
  assert.equal(nodeMeetsMinimum("v22.5.1"), true);
  assert.equal(nodeMeetsMinimum("v18.19.0"), false);
  assert.equal(nodeMeetsMinimum("v16.20.2"), false);
  assert.equal(nodeMeetsMinimum("not a version"), false);
});

// ───── rendering ────────────────────────────────────────────────────────────

test("renderDoctorText: groups by category and shows summary", () => {
  const report = {
    version: "0.3.0",
    generatedAt: 0,
    checks: [
      { id: "env.node", category: "environment", status: "ok", label: "Node", detail: "v22.1.0" },
      { id: "llm.reachable", category: "llm", status: "fail", label: "reachable", detail: "ECONNREFUSED" },
      { id: "llm.model", category: "llm", status: "info", label: "model", detail: "claude-sonnet-4-6" },
    ],
    summary: { total: 3, ok: 1, warn: 0, fail: 1, info: 1 },
  };
  const out = renderDoctorText(report);
  assert.match(out, /deepdive doctor — v0\.3\.0/);
  assert.match(out, /# environment/);
  assert.match(out, /# llm/);
  assert.match(out, /OK .*Node/);
  assert.match(out, /XX .*reachable/);
  assert.match(out, /--- .*model/);
  assert.match(out, /Summary: 3 checks · 1 ok · 0 warn · 1 fail/);
});

test("renderDoctorJson: round-trip valid JSON", () => {
  const report = {
    version: "0.3.0",
    generatedAt: 123,
    checks: [{ id: "x", category: "environment", status: "ok", label: "l", detail: "d" }],
    summary: { total: 1, ok: 1, warn: 0, fail: 0, info: 0 },
  };
  const parsed = JSON.parse(renderDoctorJson(report));
  assert.deepEqual(parsed, report);
});

test("exitCodeFor: 0 when no failures, 1 when any failure", () => {
  assert.equal(
    exitCodeFor({ summary: { total: 1, ok: 1, warn: 0, fail: 0, info: 0 } }),
    0,
  );
  assert.equal(
    exitCodeFor({ summary: { total: 3, ok: 1, warn: 1, fail: 1, info: 0 } }),
    1,
  );
  assert.equal(
    exitCodeFor({ summary: { total: 1, ok: 0, warn: 1, fail: 0, info: 0 } }),
    0,
    "warnings alone do not fail the doctor",
  );
});

// ───── integration ──────────────────────────────────────────────────────────

function makeMockLLMServer(responder) {
  const server = http.createServer((req, res) => responder(req, res));
  return server;
}

function startServer(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function stopServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function baseConfig(overrides = {}) {
  return {
    llm: {
      baseUrl: "http://127.0.0.1:1",
      apiKey: "test",
      model: "test-model",
      maxTokens: 1,
    },
    browser: { headless: true, timeoutMs: 5000, maxBytes: 1_000_000 },
    searchAdapter: "duckduckgo",
    resultsPerQuery: 1,
    maxSources: 1,
    maxWordsPerSource: 100,
    deepRounds: 0,
    concurrency: 1,
    cache: { enabled: true, dir: "/tmp/nonexistent", ttlMs: 60_000 },
    jsonOutput: false,
    verbose: false,
    ...overrides,
  };
}

test("runDoctor: healthy LLM endpoint produces ok checks", async () => {
  const { server } = {
    server: makeMockLLMServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "m",
            type: "message",
            role: "assistant",
            model: "test",
            content: [{ type: "text", text: "." }],
            usage: { input_tokens: 3, output_tokens: 1 },
          }),
        );
      });
    }),
  };
  const baseUrl = await startServer(server);
  const cacheDir = mkdtempSync(join(tmpdir(), "deepdive-doctor-"));
  try {
    const config = baseConfig({
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 1 },
      cache: { enabled: true, dir: cacheDir, ttlMs: 60_000 },
    });
    const report = await runDoctor({
      config,
      env: {},
      skipSearch: true,
      skipBrowser: true,
    });
    const llm = report.checks.filter((c) => c.category === "llm");
    const reachable = llm.find((c) => c.id === "llm.reachable");
    assert.equal(reachable?.status, "ok", JSON.stringify(reachable));
    const probe = llm.find((c) => c.id === "llm.probe");
    assert.equal(probe?.status, "ok");
    assert.match(probe.detail, /in=3.*out=1/);
    assert.equal(report.summary.fail, 0);
  } finally {
    await stopServer(server);
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("runDoctor: 500 from LLM endpoint surfaces as fail", async () => {
  const server = makeMockLLMServer((_req, res) => {
    res.writeHead(500, { "content-type": "text/plain" });
    res.end("boom");
  });
  const baseUrl = await startServer(server);
  try {
    const config = baseConfig({
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 1 },
      cache: { enabled: false, dir: "/tmp/never", ttlMs: 60_000 },
    });
    const report = await runDoctor({
      config,
      env: {},
      skipSearch: true,
      skipBrowser: true,
    });
    const reachable = report.checks.find((c) => c.id === "llm.reachable");
    assert.equal(reachable.status, "fail");
    assert.match(reachable.detail, /500/);
    assert.ok(report.summary.fail >= 1);
    assert.equal(exitCodeFor(report), 1);
  } finally {
    await stopServer(server);
  }
});

test("runDoctor: non-Anthropic-shaped 200 response surfaces as warn", async () => {
  const server = makeMockLLMServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ this: "is not anthropic shape" }));
  });
  const baseUrl = await startServer(server);
  try {
    const config = baseConfig({
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 1 },
      cache: { enabled: false, dir: "/tmp/never", ttlMs: 60_000 },
    });
    const report = await runDoctor({
      config,
      env: {},
      skipSearch: true,
      skipBrowser: true,
    });
    const shape = report.checks.find((c) => c.id === "llm.shape");
    assert.equal(shape?.status, "warn", JSON.stringify(shape));
    // Warnings alone do not fail the doctor.
    assert.equal(exitCodeFor(report), 0);
  } finally {
    await stopServer(server);
  }
});

test("runDoctor: --no-cache produces info-only cache entry", async () => {
  const server = makeMockLLMServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        role: "assistant",
        content: [{ type: "text", text: "." }],
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
    );
  });
  const baseUrl = await startServer(server);
  try {
    const config = baseConfig({
      llm: { baseUrl, apiKey: "t", model: "test", maxTokens: 1 },
      cache: { enabled: false, dir: "/tmp/never", ttlMs: 60_000 },
    });
    const report = await runDoctor({
      config,
      env: {},
      skipSearch: true,
      skipBrowser: true,
    });
    const cache = report.checks.filter((c) => c.category === "cache");
    assert.equal(cache.length, 1);
    assert.equal(cache[0].status, "info");
    assert.match(cache[0].detail, /disabled/);
  } finally {
    await stopServer(server);
  }
});

test("runDoctor: inspects existing cache dir with entries", async () => {
  const cacheDir = mkdtempSync(join(tmpdir(), "deepdive-doctor-cache-"));
  writeFileSync(join(cacheDir, "a.json"), '{"x":1}');
  writeFileSync(join(cacheDir, "b.json"), '{"x":2}');
  writeFileSync(join(cacheDir, "notjson.txt"), "ignored");
  try {
    const config = baseConfig({
      cache: { enabled: true, dir: cacheDir, ttlMs: 60_000 },
    });
    const report = await runDoctor({
      config,
      env: {},
      skipLLM: true,
      skipSearch: true,
      skipBrowser: true,
    });
    const entries = report.checks.find((c) => c.id === "cache.entries");
    assert.ok(entries, JSON.stringify(report.checks));
    assert.match(entries.detail, /2 files/);
    const writable = report.checks.find((c) => c.id === "cache.state");
    assert.equal(writable.status, "ok");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("runDoctor: exit code 1 when any fail, 0 otherwise", async () => {
  // All-skipped: only env + cache checks. No fails expected.
  const config = baseConfig({
    cache: { enabled: false, dir: "/tmp/never", ttlMs: 60_000 },
  });
  const report = await runDoctor({
    config,
    env: {},
    skipLLM: true,
    skipSearch: true,
    skipBrowser: true,
  });
  assert.equal(report.summary.fail, 0);
  assert.equal(exitCodeFor(report), 0);
});
