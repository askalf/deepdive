# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `deepdive doctor` — aggregated health report covering Node version, platform, deepdive version, cache dir state, LLM endpoint reachability + response-shape check, configured search adapter probe, and Playwright/Chromium launch smoke-test. Paste the output when filing issues. 13 checks by default; exit code 1 on any fail, 0 otherwise. `--json` emits structured output. New module `src/doctor.ts` with pure helpers (`scrubPath`, `formatBytes`, `formatDuration`, `classifyFetchError`, `nodeMeetsMinimum`, `renderDoctorText`, `renderDoctorJson`, `exitCodeFor`) all exported for library use.
- **Retry + per-call timeout on LLM calls.** `callLLM` now wraps every request in a retry-with-exponential-backoff loop (default 3 attempts, 500ms base, 8s cap, ±25% jitter) and enforces a per-call timeout (default 120s). Retry policy is precise: HTTP 5xx and 429 are retriable, 4xx is not, fetch-level errors (network, DNS, TLS, timeout) are retriable unless the failure was from a user-initiated abort. Exposes new `LLMError` class with a `retriable: boolean` getter. Rationale: a 3-round deep query fires 30+ LLM calls — at a 1% per-call failure rate the overall success rate would be 74%; with retries that lifts above 99%.
- New CLI flags + env vars: `--llm-timeout-ms=<ms>` / `DEEPDIVE_LLM_TIMEOUT_MS` (default 120000), `--llm-attempts=<n>` / `DEEPDIVE_LLM_ATTEMPTS` (default 3).
- `retry(fn, opts)` helper (`src/retry.ts`) exported for library reuse — injectable `sleep`/`random` for deterministic tests, `shouldRetry` predicate, `onRetry` hook, abort-signal aware.
- Tests: 18 doctor assertions + 12 retry helper + 9 LLM-retry integration (mock HTTP server covering first-try-OK, 500 → 500 → 200, 429 → 200, 400 non-retry, 401 non-retry, exhausted 5xx, per-call timeout on hung server, user-abort short-circuits retry loop), plus 2 new parseArgs + 2 new config cases. 159 total, up from 96.

- **robots.txt respect.** Before every page fetch, deepdive now checks the site's `robots.txt` with User-Agent `deepdive-bot` (configurable via `AgentConfig.robotsUserAgent`). Disallowed URLs are skipped with a `fetch.skipped` event instead of fetched. `--ignore-robots` / `DEEPDIVE_IGNORE_ROBOTS=1` bypasses for cases where the operator has their own relationship with the target. robots.txt content is cached in-memory per run (one GET per host). Network errors on the robots.txt fetch err on the side of "fetch" rather than "deny" — publishers who care have working robots.txt.
- New exports: `canFetch`, `createRobotsCache`, `parseRobotsTxt`, `isPathAllowed`, `DEFAULT_USER_AGENT`. 17 new assertions (15 robots unit + 2 CLI).

### Security
- Addressed 7 CodeQL high-severity alerts: polynomial-ReDoS risks on URL trim/fragment strip regexes replaced with non-regex string walks in a new `src/url-util.ts`; tightened DuckDuckGo hostname match to rule out `evil-duckduckgo.com`-style spoofs; single-pass HTML entity decoder fixes the `&amp;#39;` double-unescape; defensive `stripTags` now also drops stray `<` so malformed partial tags can't leak a tag opener downstream.
- Home-dir scrubbing on all CLI error messages. `safeErrorMessage` (exported for library reuse) runs every user-facing error through `scrubPath` before printing, so a Playwright ENOENT, an LLM 500 echoing back a path from the request body, or any other downstream error can't include `/home/alice/...` or `C:\Users\alice\...` in the output a user would paste into a bug report. Library consumers of `runAgent` still get raw errors for debugging.

## [0.2.0] — 2026-04-22

Iterative research, parallel fetching, on-disk cache, structured output.

### Added
- `--deep[=N]` iterative research loop. After the first synthesis a "critic" LLM call reviews the draft, names the gaps, and proposes follow-up queries; the loop re-runs up to N more rounds (bare `--deep` defaults to 2). Critic can declare the answer complete to terminate early. `critique()` / `parseCritique()` are exported from `src/plan.ts` for programmatic use.
- `--concurrency=N` parallel page fetches (default: 4). The agent now uses a worker-pool pattern (`src/concurrency.ts`) instead of a serial loop, cutting fetch phase wall-time roughly N× on a mix of fast and slow pages.
- Per-URL on-disk cache at `~/.deepdive/cache/` (configurable via `DEEPDIVE_CACHE_DIR`). Atomic `.tmp` + `rename` writes. TTL default 1 hour (`--cache-ttl-ms=<ms>`). Disable with `--no-cache` or `DEEPDIVE_NO_CACHE=1`. Cache hits skip the browser entirely — an all-cached run never launches Chromium.
- `--json` output mode. Prints `{question, plan, rounds, sources, answer, usage}` instead of markdown — pipeable into `jq` and other tools. `DEEPDIVE_JSON=1` env var also works.
- `AgentConfig.browserFactory` — optional factory for injecting a mock `BrowserLike` in tests and custom deployments. The default factory returns a real `BrowserSession`, so existing callers see no behavior change.
- `AgentResult.rounds` — per-round trace with queries, candidates found, fetches, kept-count, and the critic's verdict.
- `AgentResult.usage.cacheHits` — how many fetches hit the cache this run.
- New agent events: `round.start`, `critique.start`, `critique.done`. Existing `fetch.start` / `fetch.done` gained a `cached: boolean` field.
- Tests: cache round-trip + TTL + atomicity, concurrency cap + ordering + abort, parseCritique, new CLI flag coverage, full agent loop integration test with a mock LLM HTTP server, mock search, and mock browser — 42 new assertions (96 total, up from ~53).

### Changed
- README — new flag table covering `--deep`, `--concurrency`, `--no-cache`, `--json`; examples for deep mode and JSON piping; library-mode snippet updated to wire cache + deepRounds. Also: demoted promotional "Claude Max / Pro" phrasing to "Claude Max" to match dario's README after the 2026-04-21 Anthropic Pro/CC incident.
- `AgentConfig` is additive — new required fields `deepRounds` and `concurrency` (non-breaking: `resolveConfig` sets sensible defaults so library callers that go through it pick them up for free).

## [0.1.0] — 2026-04-21

Initial scaffolding. One-shot research agent: plan → search → fetch → extract → synthesize → cited markdown.

### Added
- CLI entry point `deepdive` with `--help`, `--verbose`, `--out`, and Anthropic-compat `--base-url` / `--api-key` / `--model` flags.
- Agent loop in `src/agent.ts` — single-pass, emits structured events.
- Planner (`src/plan.ts`) — LLM decomposes the question into 3–5 sub-queries, returns strict JSON.
- Pluggable search adapters: DuckDuckGo HTML (default, no key), SearXNG, Brave Search API, Tavily API. Interface in `src/search.ts`.
- Playwright-driven headless Chromium fetcher (`src/browser.ts`) with stealth-flavored launch args.
- Content extractor (`src/extract.ts`) — normalizes whitespace, drops chrome / cookie-banner paragraphs, caps per-source words.
- Citation renderer (`src/citations.ts`) — numbered inline `[N]` with a `## Sources` block.
- Synthesizer (`src/synthesize.ts`) — cited-markdown answer from the numbered source packet.
- Config resolution (`src/config.ts`) — CLI flags win over `DEEPDIVE_*` env vars.
- Library exports in `src/index.ts` for programmatic use.
- Tests via `node --test` covering parser, config, citations, extract, search parsing, and CLI argument parsing.
- MIT LICENSE, DISCLAIMER.md (AS IS / no-affiliation / user-responsibility), SECURITY.md, CLAUDE.md.
