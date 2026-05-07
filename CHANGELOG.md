# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0] - 2026-05-06

Three independent features that round out the major surface for v1: the verifier and critic now talk to each other, the LLM client speaks OpenAI Chat Completions natively, and the planner's URL picks can be filtered by hostname.

### Added — verifier feeds the critic (closes the v0.5.0 loop)

In `--deep` mode, the citation verifier now runs once per round (not just at the end). When intermediate rounds produce sentences with weak citations, those sentences are forwarded to the critic in the next round's prompt as top-priority gaps to fill. The critic system prompt was updated to surface this signal explicitly: when weak cites are present, queries should target authoritative sources for the specific flagged claims rather than generic re-searches.

- New `WeakCite` type and optional `weakCites` parameter on `critique()` (additive — existing callers unaffected).
- `parseCritique` / `Critique` shape unchanged; only the user message construction changes.
- The end-of-run verifier pass that produces the user-facing `verification` report still runs once after the loop exits — that hasn't moved.

This is the v2 of v0.5.0 that was explicitly out-of-scope at v0.5.0 time. Now in scope and shipping.

### Added — OpenAI-compatible endpoint support (`src/llm-format.ts`, ~140 lines)

deepdive's pipeline is built around the Anthropic Messages shape because that's dario's native protocol. v0.8.0 adds a request/response adapter so the same pipeline talks transparently to any OpenAI Chat Completions endpoint — OpenAI itself, vLLM, Ollama, LiteLLM in OpenAI mode, etc.

- Auto-detection from `--base-url`: `api.openai.com`, `:11434` (Ollama default), and `:8000` (common vLLM port) all map to `openai`. Everything else stays on `anthropic` (preserves dario's behavior). Override with `--api-format=anthropic|openai` or `DEEPDIVE_API_FORMAT`.
- New module `src/llm-format.ts` exporting `detectApiFormat`, `toOpenAIRequest`, `fromOpenAIResponse`, `openaiSSEToAnthropic`, `authHeadersFor`, `pathFor`, plus the request/response/SSE shape types. All pure.
- Streaming works too — the SSE adapter translates `choices[].delta.content` frames to `content_block_delta` and final `usage` frames to `message_delta` on the fly. OpenAI streaming requests automatically get `stream_options.include_usage: true` so token counts still arrive.
- Auth headers swap automatically: `authorization: Bearer …` for OpenAI; `x-api-key` + `anthropic-version: 2023-06-01` for Anthropic.
- `LLMConfig.apiFormat?: ApiFormat` for library consumers.

```bash
# Local Ollama (auto-detected):
deepdive "explain how X works" --base-url=http://localhost:11434 --model=llama3.1

# OpenAI directly:
deepdive "..." --base-url=https://api.openai.com --api-key=$OPENAI_API_KEY --model=gpt-4o
```

Cost telemetry still works for OpenAI-shape endpoints; users plug in their own per-MTok numbers via `DEEPDIVE_PRICE_INPUT_PER_MTOK` / `DEEPDIVE_PRICE_OUTPUT_PER_MTOK` since the built-in table only covers Claude models.

### Added — domain allow / deny list (`src/domain-filter.ts`, ~60 lines)

Two new CLI flags applied between search and fetch:

- `--allow-domain=<list>` — keep only URLs whose hostname matches at least one comma-separated pattern.
- `--deny-domain=<list>` — drop URLs whose hostname matches any pattern.

Hostname-suffix matching: `github.com` matches `github.com` and `api.github.com` but not `githubcompany.com`. Filtered URLs surface as `fetch.skipped` events with reasons `domain-deny` or `domain-not-allowed` and never count toward fetches. Both flags can be combined; env equivalents `DEEPDIVE_ALLOW_DOMAIN` / `DEEPDIVE_DENY_DOMAIN`.

- New module `src/domain-filter.ts` exporting `classifyUrl`, `matchesAny`, `normalizePattern`, `parseDomainList`, plus types. All pure.
- `AgentConfig.domainFilter?: DomainFilter` for library consumers.
- New `fetch.skipped` reasons in the agent event union.

### Tests

38 new across `test/llm-format.test.mjs` (15 — adapter pure tests covering request/response/SSE/headers/path), `test/domain-filter.test.mjs` (12 — classification, hostname-suffix lookalike rejection, allow/deny precedence, malformed-URL passthrough), `test/agent-loop.test.mjs` (3 — critic-verifier weak-cite forwarding, deny-list end-to-end, allow-list end-to-end), `test/llm-retry.test.mjs` (1 — OpenAI request/response round-trip via mock server), plus 8 CLI/config flag-plumbing tests across both new flags and the api-format auto-detect / flag / env precedence chain. Total test footprint now 352 across 9 suites.

## [0.7.0] - 2026-05-06

Adds **PDF source support** and **local file ingestion** — the two biggest content-coverage gaps left in deepdive. Real research questions hit PDFs constantly (academic papers, RFCs, standards bodies); the most useful sources are often already on the user's laptop (project notes, internal docs). Both now work.

Also closes a small loop on the v0.6.0 cost-telemetry commitment: the price table is now timestamped and `deepdive doctor` warns if it's been more than 90 days since the maintainer audited it against vendor pricing.

### Added — PDF extraction (`src/pdf.ts`, ~180 lines, no new runtime deps)

PDFs are detected by URL extension or `Content-Type: application/pdf` and routed through a separate extractor path instead of the headless browser's DOM. The extractor uses [`pdfjs-dist`](https://github.com/mozilla/pdfjs-dist), Mozilla's reference PDF.js library — but it is **not** a runtime dependency. To preserve deepdive's "one runtime dependency" headline guarantee, `pdfjs-dist` is dynamically imported on first use; if it's missing, the source is skipped cleanly with a `fetch.skipped` event whose reason is `pdf-no-extractor` and a one-line install hint.

Enable PDF support with:

```bash
npm install -g pdfjs-dist
```

- New module `src/pdf.ts` exporting `extractPdfText`, `isPdfExtractorAvailable`, `looksLikePdf`, `joinTextItems`, `dedupeRunningHeadersFooters`, and `PdfExtractorMissingError`. All testable in isolation.
- New CLI flag `--pdf-max-pages=<n>` (default 50). Large papers are truncated rather than blowing the synth context.
- New env var `DEEPDIVE_PDF_MAX_PAGES`.
- New `fetch.skipped` reason `"pdf-no-extractor"`.
- `BrowserSession.fetch` now short-circuits PDF URLs to a plain HTTP GET via Playwright's request context (Chromium's PDF viewer never exposes useful text via the DOM, and `page.goto()` on a PDF can hang on `networkidle` waits). `FetchedPage` gains optional `mimeType` and `bytes` fields.
- A frequency-based deduper drops running headers / footers / page-number lines that appear on more than 60% of pages.

### Added — local file source ingestion (`src/local.ts`, ~140 lines, no new runtime deps)

The `--include=<path>[,<path>]` flag pre-loads files or directories as sources before any web search runs. Local sources sit at the head of the kept-sources list, so they receive the lowest `[N]` citation IDs and stay most prominent to the synthesizer. Files are exposed as `file:///abs/path` URLs in the citation footer — clickable from the user's terminal/editor.

Supported extensions:

| Extension | How |
|---|---|
| `.pdf` | via `extractPdfText` (requires `pdfjs-dist`) |
| `.md`, `.markdown`, `.txt`, `.text` | read as plain text |
| `.html`, `.htm` | tags stripped + a small entity decoder |

- New module `src/local.ts` exporting `ingestLocalPaths`, `expandPaths`, `stripTags`. Pure decision functions, no I/O outside `expandPaths` / `ingestLocalPaths` themselves.
- Directory expansion is one level deep — recursing into arbitrary trees is not the default to avoid surprising users who point at their home directory.
- New CLI flag `--include=<path>[,<path>]` and env var `DEEPDIVE_INCLUDE`. Files that fail to extract (e.g. PDF without `pdfjs-dist`, unsupported extension) are recorded in `LocalIngestResult.skipped[]` and surfaced as the `include.done` agent event.
- `AgentConfig.include?: string[]` for library consumers.

### Added — `deepdive doctor`: pdf + pricing checks

- New check `pdf.extractor`: `ok` when `pdfjs-dist` resolves, `info` (with install hint) otherwise.
- New check `pricing.table`: prints the model count and the verification age. Warns if the table is more than `PRICE_TABLE_STALE_AFTER_DAYS` (90) days old. Closes the loop on v0.6.0's "drift is intentional, audit happens at PR time" commitment — undeclared drift now produces a visible warning. New `PRICE_TABLE_VERIFIED_AT` constant in `src/pricing.ts` and `daysAgo(isoDate, now?)` helper, both exported.

### Tests

35 new across `test/pdf.test.mjs` (11 — pure helpers + an in-memory minimal-PDF round-trip), `test/local.test.mjs` (9 — `stripTags` / `expandPaths` / `ingestLocalPaths`), `test/agent-loop.test.mjs` (2 — `--include` and PDF-byte routing end-to-end), `test/pricing.test.mjs` (5 — `daysAgo` and drift-constant coherence), `test/doctor.test.mjs` (3 — fresh / stale / pdf checks), plus 4 CLI/config flag-plumbing tests. Total test footprint now 310 across 7 suites.

## [0.6.0] - 2026-05-05

Adds **per-run cost telemetry**: every run now prints a one-line summary of the LLM tokens it consumed and what the same workload would have cost at API list prices, reinforcing the README cost-arbitrage table with real numbers from real runs.

### Added — cost telemetry (`src/pricing.ts`, ~110 lines, no new runtime deps)

- New module `src/pricing.ts` with `priceFor`, `estimateCost`, `formatCostLine`, `formatUsd`, `formatTokens`, `looksLikeDario`, plus a `PRICE_TABLE` covering `claude-sonnet-4-6` (3/15 per MTok), `claude-opus-4-7` (15/75), and `claude-haiku-4-5` (0.80/4). All pure — no LLM, no network, no disk.
- Token counts come straight from Anthropic's response/SSE `usage` field — already returned by both `callLLM` and `callLLMStream`. Newly threaded up through `planQueries`, `synthesize`, and `critique` via an optional `onUsage` callback (additive — existing callers see no behavior change).
- Agent accumulates input/output tokens across plan + synth + critique calls. Exposes `AgentResult.cost: CostEstimate` and `AgentResult.usage.{llm: {inputTokens, outputTokens, calls}, estimatedCostUsd}` for library consumers.
- New `llm.call` agent event with `phase` (`plan` / `synth` / `critique`), `round`, and per-call token counts; renders as a `llm` line in `--verbose`.
- End-of-run summary on stderr (always; CI-suitable since it never touches stdout). When `--base-url` matches dario's default port (`http://localhost:3456`), an honesty-framing hint is appended:
  ```
  cost · ~$0.0085 · 412 in / 234 out · 4 LLM calls · claude-sonnet-4-6
         (≈ at API list price; $0 on Claude Max via dario)
  ```
  Pointing at a different base URL auto-suppresses the hint.
- Unknown models render as `$?` (no fabricated numbers). Self-hosted endpoints can plug in pricing via `DEEPDIVE_PRICE_INPUT_PER_MTOK` and `DEEPDIVE_PRICE_OUTPUT_PER_MTOK`. Env override only fills in for unknown models — known models always use the table (which is canonical).
- `--json` output gains a top-level `cost` key alongside the existing `usage` block.

### Added — CLI flag

- `--no-cost` / `DEEPDIVE_NO_COST=1` — suppress the stderr summary line.

### Tests

24 new pricing unit tests + 3 new agent-loop integration tests (usage accumulation across plan/synth/critique with mock token counts; `llm.call` event emission; unknown-model graceful path) + 2 CLI/config flag-plumbing tests + 2 cost-summary render tests. Total test footprint now 275 across 6 suites.

## [0.5.0] - 2026-05-05

Adds **lexical citation verification**: every `[N]` reference in a synthesized answer is now checked against the extracted text of source N before the markdown is finalized, catching the dominant failure mode of cited-answer tools (confident sentences pointing at sources that don't actually support them).

### Added — citation verifier (`src/verify.ts`, ~150 lines, no new runtime deps)

After the final synthesis, the agent splits the answer body into sentences, extracts every `[N]` citation, and computes the fraction of distinct content tokens in the claim that appear in source N's extracted text. Stop-words are dropped; numbers and digit-letter compounds (`5h`, `7d`) are preserved as the strongest hallucination-tell anchors. A multi-cite sentence (`[1][3]`) is supported only when **every** cited source clears the threshold — a bogus `[3]` in an otherwise-true sentence is still flagged.

- New module `src/verify.ts` exporting `verifyCitations`, `splitSentences`, `extractCiteIds`, `contentTokens`, `recall`, `stripSourcesBlock`, and `DEFAULT_CITE_MIN_RECALL`. All pure — no LLM, no network, no disk.
- New CLI flags: `--strict-cites` (exit non-zero on any unsupported citation), `--cite-min-recall=<0..1>` (threshold knob, default `0.4`), `--no-verify-cites` (skip the pass entirely).
- Env vars: `DEEPDIVE_STRICT_CITES`, `DEEPDIVE_CITE_MIN_RECALL`, `DEEPDIVE_NO_VERIFY_CITES`.
- New agent event `verify.done` with the full report; renders one summary line in `--verbose` plus one warning line per unsupported sentence. Clean runs stay quiet.
- `AgentResult.verification: VerificationReport | undefined` and `AgentResult.usage.{citationsTotal, citationsSupported}` added for library consumers.
- `--json` payload now includes a `verification` key.
- When any citation fails, the markdown output gets a `## Citation health` footer at the end. Clean answers are unchanged.

```bash
# Routine use — verifier runs by default, only complains when something's off:
deepdive "how does claude's rate limiter work" --deep --verbose

# CI / scripted use — fail the build if any citation is unsupported:
deepdive "..." --strict-cites --cite-min-recall=0.5
```

What it is not: a semantic judge. Lexical recall has high precision on hallucinated proper nouns, dates, and numbers but can flag paraphrased-but-truthful sentences below threshold and miss topic-aligned-but-incorrect ones above it. Adding a second LLM "judge" pass would reintroduce exactly the hallucination class we're trying to detect, so v1 sticks to deterministic lexical scoring.

39 new tests across `test/verify.test.mjs` (pure-function coverage of all five exported helpers + the integration shape), plus 2 new agent-loop integration tests (verifies the bogus-cite flag end-to-end and confirms `verifyCitations: false` skips), plus 4 new CLI/config tests covering the flag plumbing. Total test footprint now 251 across 5 suites.

## [0.4.0] - 2026-05-02

Adds **Exa** as a fifth search adapter alongside DuckDuckGo, SearXNG, Brave, and Tavily — the first community-contributed adapter ([@tgonzalezc5](https://github.com/tgonzalezc5), [#19](https://github.com/askalf/deepdive/pull/19)). This release also exercises the `auto-release.yml` inline-publish chain end-to-end for the first time (the latent bug fixed in v0.3.0's CHANGELOG entry).

### Added — Exa search adapter (community contribution, #19)

New `ExaSearch` adapter at `src/search/exa.ts` (~75 lines, no new runtime deps). Exa is a neural-search API tuned for long, intent-rich queries — the shape deepdive's planner sub-queries and the critic loop's gap-filling follow-ups tend to take. Uses raw `fetch` matching the Tavily / Brave pattern.

- Wired into `resolveSearchAdapter` behind `--search=exa` and `DEEPDIVE_EXA_KEY`.
- Pure mapping function `mapExaResults` extracted for testability per the project's "pure decision functions" principle.
- Snippet cascade: highlights → text → summary → "" so the adapter degrades gracefully across content modes.
- Includes `x-exa-integration: deepdive` header for usage attribution.
- `deepdive doctor` picks up the new adapter automatically via `resolveSearchAdapter`.
- 14 new tests in `test/exa-adapter.test.mjs` covering parsing, snippet fallback cascade, resolver wiring, request shape (headers, body, numResults cap), and HTTP error handling. Total test footprint now 212 across 4 suites.

```bash
export DEEPDIVE_EXA_KEY=...
deepdive "how does claude's rate limiter work" --search=exa --deep --verbose --out=report.md
```

README adapter table, flag table, sovereignty paragraph, `--help` output, and env-var list all updated.

### CI — auto-release workflow now publishes to npm inline (validates v0.3.0's pending fix)

v0.3.0 surfaced a latent chain-break: the newly-ported `auto-release.yml` created the GitHub release via `GITHUB_TOKEN`, but **GitHub intentionally doesn't fire workflows for events created by `GITHUB_TOKEN`** (loop protection). So `publish.yml`'s `release:published` trigger never fired, and v0.3.0 needed a manual delete+recreate of the release (from a human token) to kick publish. Same latent bug ported cleanly from dario — the chain worked there only because every dario release so far had been a manual `gh release create` from the maintainer, which *does* fire downstream workflows.

Fix: inline the build + test + publish steps into `auto-release.yml` itself. Net chain is now:

- PR merge → `auto-release.yml` single run → build + typecheck + test + `--help` smoke → `gh release create` → `npm publish --access public --provenance`.

`publish.yml` stays in place for the *manual* release case: a maintainer running `gh release create` locally still fires `publish.yml` via the release-published event (that release isn't from `GITHUB_TOKEN`, so it does trigger workflows).

Added `id-token: write` permission to `auto-release.yml` for the SLSA provenance attestation. **v0.4.0 is the first release that exercises this fixed chain end-to-end.**

## [0.3.0] - 2026-04-23

Streaming synthesis, `deepdive doctor`, LLM retry + per-call timeout, robots.txt respect, CI foundation parity with dario / claude-bridge, auto-release workflow preemptively ported, CodeQL pass, home-dir scrubbing on error output.

### CI — foundation parity with dario / claude-bridge

Brings deepdive's CI surface up to the maturity of the sibling repos:

- **`actionlint.yml`** — `actionlint` v1.7.1 runs on every PR + push. No path filter (required-checks gate would never report on src-only PRs if filtered — classic footgun fixed on dario + claude-bridge already).
- **`dependabot.yml`** — weekly (Monday 09:00 UTC) npm + github-actions version updates. Non-major grouped per ecosystem; majors open individually so they get real review.
- **`stale.yml`** — `actions/stale@v10.2.0` daily at 04:30 UTC. 60 days to warn, 14 to close. Exempts `security`/`auth`/`review-feedback`/`help-wanted`/`good-first-issue`/`pinned` for issues, plus `wip`/`blocked`/`security` for PRs.
- **`ci.yml`** — added `typecheck` step (`tsc --noEmit`) as a separate CI step before `build`, so type errors surface before the tsc emit step does. Matrix stays at Node 20 / 22 (engines `>=20.0.0` rules out 18; `node --test --test-concurrency` also needs 20.11+).
- **Labels** — `security`, `auth`, `pinned`, `wip`, `blocked`, `review-feedback` created out-of-band to match the dario / claude-bridge vocabulary. Referenced by the stale-bot exempts above.
- Repo setting `allow_update_branch` toggled on so auto-merge can rebase PRs against master without the maintainer clicking "Update branch".

### CI — auto-release workflow (ports the dario pattern preemptively)

New `.github/workflows/auto-release.yml`. Fires on merge of any PR to master; exits in ~10s unless `package.json.version` changed from the parent commit, in which case it creates the matching `vX.Y.Z` tag and GitHub release (extracting the CHANGELOG section for the version as release notes). `publish.yml` then fires on `release:published` and runs `npm publish --access public --provenance`.

Ported from dario where it was added as a root-cause fix after v3.31.8–v3.31.11 sat on master for a week without reaching npm (maintainer bumped the version, merged the PR, and forgot `gh release create` four times in a row). Deepdive is in the same position today — v0.2.0 CHANGELOG-dated but only v0.1.0 on npm. Shipping this workflow before the next release prevents the gap from opening again.

Guards stacked: `merged == true`, version must differ from HEAD^1, new version must match `X.Y.Z`, tag must not already exist. Any guard tripped → skip cleanly rather than fail silently.

### Added
- **Streaming synthesis.** The final-answer synthesizer now uses Anthropic's SSE streaming endpoint, so tokens land on stdout as the model writes them instead of the user staring at a blank terminal for 30+ seconds on a deep query. On by default for single-pass, TTY-connected, non-JSON runs. Auto-disabled for `--json`, `--deep` (intermediate rounds would print multiple full drafts back-to-back), non-TTY stdout (pipes), or `--no-stream`. New exports: `callLLMStream`, `parseSSE`, `parseBlocks`, `StreamOptions`. New CLI flag `--no-stream` and env var `DEEPDIVE_NO_STREAM=1`. Retry applies to the initial connect only — once we start emitting tokens, a mid-stream failure can't be undone.
- New agent hook `AgentConfig.onSynthesizeToken?: (chunk, round) => void` for library consumers that want to surface tokens during synthesis.
- `deepdive doctor` — aggregated health report covering Node version, platform, deepdive version, cache dir state, LLM endpoint reachability + response-shape check, configured search adapter probe, and Playwright/Chromium launch smoke-test. Paste the output when filing issues. 13 checks by default; exit code 1 on any fail, 0 otherwise. `--json` emits structured output. New module `src/doctor.ts` with pure helpers (`scrubPath`, `formatBytes`, `formatDuration`, `classifyFetchError`, `nodeMeetsMinimum`, `renderDoctorText`, `renderDoctorJson`, `exitCodeFor`) all exported for library use.
- **Retry + per-call timeout on LLM calls.** `callLLM` now wraps every request in a retry-with-exponential-backoff loop (default 3 attempts, 500ms base, 8s cap, ±25% jitter) and enforces a per-call timeout (default 120s). Retry policy is precise: HTTP 5xx and 429 are retriable, 4xx is not, fetch-level errors (network, DNS, TLS, timeout) are retriable unless the failure was from a user-initiated abort. Exposes new `LLMError` class with a `retriable: boolean` getter. Rationale: a 3-round deep query fires 30+ LLM calls — at a 1% per-call failure rate the overall success rate would be 74%; with retries that lifts above 99%.
- New CLI flags + env vars: `--llm-timeout-ms=<ms>` / `DEEPDIVE_LLM_TIMEOUT_MS` (default 120000), `--llm-attempts=<n>` / `DEEPDIVE_LLM_ATTEMPTS` (default 3).
- `retry(fn, opts)` helper (`src/retry.ts`) exported for library reuse — injectable `sleep`/`random` for deterministic tests, `shouldRetry` predicate, `onRetry` hook, abort-signal aware.
- Tests: 18 doctor assertions + 12 retry helper + 9 LLM-retry integration + 14 streaming (6 parseBlocks unit, 4 parseSSE reader, 4 callLLMStream mock-server integration) + 5 error-scrub + new CLI/config cases. 180 total, up from 96.

- **robots.txt respect.** Before every page fetch, deepdive now checks the site's `robots.txt` with User-Agent `deepdive-bot` (configurable via `AgentConfig.robotsUserAgent`). Disallowed URLs are skipped with a `fetch.skipped` event instead of fetched. `--ignore-robots` / `DEEPDIVE_IGNORE_ROBOTS=1` bypasses for cases where the operator has their own relationship with the target. robots.txt content is cached in-memory per run (one GET per host). Network errors on the robots.txt fetch err on the side of "fetch" rather than "deny" — publishers who care have working robots.txt.
- New exports: `canFetch`, `createRobotsCache`, `parseRobotsTxt`, `isPathAllowed`, `DEFAULT_USER_AGENT`. 17 new assertions (15 robots unit + 2 CLI).

### Security
- Addressed 7 CodeQL high-severity alerts: polynomial-ReDoS risks on URL trim/fragment strip regexes replaced with non-regex string walks in a new `src/url-util.ts`; tightened DuckDuckGo hostname match to rule out `evil-duckduckgo.com`-style spoofs; single-pass HTML entity decoder fixes the `&amp;#39;` double-unescape; defensive `stripTags` now also drops stray `<` so malformed partial tags can't leak a tag opener downstream.
- 8th ReDoS flagged after #4 merged — `doctor.ts:177`'s `baseUrl.replace(/\/+$/, "")`. Same class, same fix: swapped to `trimTrailingSlashes` from `src/url-util.ts`. The regex was benign in isolation (no nested repetition) but using the standard helper keeps the pattern consistent across the codebase and CodeQL's query clean.
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
