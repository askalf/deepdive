# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.28.0] - 2026-07-02

### Changed — the per-source word cap now spends its budget on query-relevant spans, not the document head (#145)

The first real PDF ingest on a production runner (v0.27.1) fetched the 129-page NIST SP 800-63B-4, extracted all 18,265 words flawlessly — and then head-first truncation (`words.slice(0, maxWords)`) reduced it to title page, authors, abstract, and table of contents. The synthesizer, correctly refusing to cite what it could not see, answered from front matter and said so. Head-first is the worst heuristic for exactly the documents the source-authority axis works hardest to keep: long formal publications put their least informative words first.

New `src/relevance-window.ts` (deterministic, LLM-free, zero new dependencies): when a source exceeds `--max-words-per-source`, the budget now goes to (1) a head anchor for document identity, (2) the fixed-size word windows scoring highest on content-token overlap with the question and the round's queries — the same token machinery as the keyword ladder (#86), reusing `trimPunctuation`'s index-walk normalization (the CodeQL-safe alternative to trim regexes) — and (3) document-order fill for any remaining budget, reassembled chronologically with `…` elision markers. Applied to both cap sites: the PDF path in `agent.ts` and `extractContent` (long HTML specs had the same failure mode). With no query terms or no matches, behavior degrades to exactly the old head-first cap. Pinned by `test/relevance-window.test.mjs`, including a fixture in the NIST failure shape — 2,600 words of front matter with the normative "SHALL NOT" text buried past the cap — asserting the old behavior misses it and the new behavior reaches it.

## [0.27.1] - 2026-07-02

### Fixed — OpenSSH/OpenBSD project hosts were invisible to source authority (#142)

A live v0.27.0 run asked what changed in the latest stable OpenSSH release. The answer was fully cited — 18/18 citations supported, 16 of them grounded in the official OpenSSH release notes — yet the trust badge read `mixed`, because `openssh.org` scored `unknown (0.4)` while the set's one recognized "primary" was a marginally relevant Windows install guide on `learn.microsoft.com`. Beyond the badge, `prefer`'s keep-stage ranking (#113) would rank the actual release notes below any recognized domain under slot competition. Same coverage class as #130 (canonical project sites with no `docs.` prefix), fixed the same way — three receipted entries in the curated primary list, no heuristics: `openssh.com`, `openssh.org` (the mirror search actually surfaces), `openbsd.org` (the parent project). Re-scoring the live run's five kept sources moves it from 1 primary / 4 unknown to 3 primary / 2 unknown. Pinned by a new case in `test/source-authority.test.mjs`.

## [0.27.0] - 2026-07-02

### Added — the ops/infra canon becomes visible to source authority (#130)

The v0.26.1 before/after board (`bench/results/2026-07-02-v0.26.1-source-authority.md`) had one dead row: the `niche-ops` question kept **0 primary sources with authority ranking off AND on** — ranking can only promote what scoring can see, and the scorer was blind to the very sources that answer ops questions. Two auditable coverage holes, both fixed by extending the curated lists (no heuristics, no denylist changes, per the module's boost-led philosophy):

- **Official project-documentation hosts that carry no `docs.` prefix** now score `primary`: `nginx.org` (the canonical source for the bench question's literal fix, `proxy_buffer_size`), `apache.org`, `kernel.org`, `php.net`, `git-scm.com` — the same class as the `redis.io`/`postgresql.org` entries already present.
- **The Stack Exchange network's flagship sites live on their own domains** — `serverfault.com`, `superuser.com`, `askubuntu.com` are *not* subdomains of `stackexchange.com`, so listing `stackexchange.com` never covered them and the canonical ops Q&A scored `unknown`. They now score `reputable`, the same class as the already-listed `stackoverflow.com`.

### Fixed — StackExchange search returned zero results for natural-language queries (#131)

`/2.3/search/advanced?q=` is literal-match against the question corpus, so the planner's long natural-language queries routinely returned **zero items** — live-verified with the niche-ops bench question: 0 results on both `stackoverflow` and `serverfault`, even though the network is full of answers to that exact error. This is the same failure v0.23.0 fixed for wikipedia (#86), now closed for StackExchange with the same machinery: when the verbatim query finds nothing, the adapter walks the pure `keywordLadder` (4 → 2 → 1 leading content tokens) until a variant hits — at most 3 extra keyless-API calls, only on the would-have-been-empty path. Live before → after on the bench question: **0 → 12 results on both sites** (first hit at `nginx return 502 upstream`). Pinned by three new adapter tests, including the real bench question.

## [0.26.1] - 2026-06-27

### Fixed — user-publishable `docs.` hosts no longer score as authoritative (#111)

- **`docs.google.com` was scored `primary` (top authority, 1.0) by the `docs.` documentation-subdomain boost** — but `docs.google.com` is the Google Docs *app*, where anyone can publish a document (`/document/d/.../pub`), not Google's product documentation. So an arbitrary user-published Google Doc ranked as authoritative as `arxiv.org` or a `.gov` source: exactly the fabricable-source-scoring-as-trustworthy failure mode the source-authority axis exists to catch (#111), leaking in through the prefix rule's own blind spot. The `docs.` / `developer.` prefix boost now skips a small, auditable `DOCS_PREFIX_EXCLUSIONS` set; excluded hosts fall through to neutral `unknown` (not punished, just not boosted). Google's real product docs live at `developers.google.com` / `cloud.google.com` and are unaffected (the latter is already a curated primary domain). Pinned by a new case in `test/source-authority.test.mjs`.

### Added — the source-trust badge reaches the HTML report (#111)

- **The HTML export now carries the source-trust signal.** v0.26.0 surfaced source trust — the axis orthogonal to citation support: whether the sources themselves are credible, not just whether the claims are cited — in the CLI footer and `--json`, but not in the HTML export, so a fully-cited report built on content farms could be handed off looking clean. `renderTrustBadge()` adds the trust label to the report's meta line, reusing the same deterministic, LLM-free `summarizeSourceTrust` every other surface uses — one consistent signal everywhere. Only rendered when there is something to flag (`mixed`/`low`); a high-trust report stays clean, mirroring the CLI footer. The tooltip is HTML-escaped, with matching `.trust-low`/`.trust-mixed` styles. Pinned by new cases in `test/html-export.test.mjs`.

### Added — source authority reaches the search stage (#111 P4)

v0.26.0 added domain-authority ranking at the keep stage — but the keep stage can only reorder candidates search already returned. On a farm-heavy topic a `multi:` fan-out could fill its result cap with content farms a backend ranked first and truncate a primary source that ranked low, so the keep stage never saw it. The `--source-authority` setting now also biases the fan-out merge: the deduped pool from `--search=multi:…` is reordered by authority (the same `rankByAuthority` primitive) **before** the result cap, so low-ranked primary sources survive into the pool. `strict` drops known farms there too, with the same min-keep floor; `off` and single-backend searches are unchanged (plain round-robin / the backend's own ranking). Completes the issue's P4 stretch goal — search-side bias toward primary sources — closing the gap the keep stage alone left open.

### Fixed — synthesis no longer fails the whole run on an intermittent upstream stall (#104)

- **The streaming synthesis call now retries an intermittent upstream stall instead of fast-failing the run.** Since v0.25.2 synthesis always streams, bounded by an idle-token deadline — but `callLLMStream` wrapped only the *initial connect* in retry, so once the stream was flowing a mid-generation stall tripped the idle deadline and the `TimeoutError` killed the whole run. On a single-pass factual lookup, synthesis is the only synthesis call, so an upstream that stalls ~20% of the time failed ~20% of those queries (#104). `callLLMStream` now wraps the **whole connect+stream** in retry, gated on whether any token has reached the user: in buffered mode (`--json` / non-TTY — the path #104 measured) and before the first visible token in interactive mode, a stall is retried transparently with backoff; once visible tokens have streamed to a TTY the stall surfaces instead (a retry would duplicate already-printed output). The accumulated text is reset per attempt, so a recovered retry never concatenates a previous attempt's partial output.
- **The connect timeout no longer aborts a healthy long generation.** The connect deadline is now a clearable timer that bounds only time-to-headers and is cleared the instant the response headers land; past that, the body stream is governed solely by the idle-token deadline (and the user's abort signal). Previously the connect timeout signal stayed attached to the body, so a healthy generation longer than `--llm-timeout-ms` (120s default) could be aborted mid-stream — contradicting the client's stated "bounds only the connect" contract. Pinned by new `test/llm-stream-retry.test.mjs` (buffered-stall retry + fresh-buffer, pre-first-token retry, post-first-token no-retry, and a long-but-healthy stream that outlives the connect timeout).

## [0.26.0] - 2026-06-18

### Added — source authority: a second, orthogonal trust axis (#111)

deepdive already verifies that each cited claim actually appears in its source (lexical *citation support*). That says nothing about whether the source itself was worth citing — and on recency/trending topics, where AI content farms outrank primary sources, an answer can be fully cited, score perfect citation support, and be built entirely on fabricable spam. A 2026-06-15 dogfood caught exactly this: "the latest open-weight LLMs" pulled sources that were 100% content farms and synthesized a confident answer at 1.00 citation support, indistinguishable in the report from a primary-sourced one. This release adds the missing axis — *source authority* — measured and reported separately so neither signal is mistaken for the other. Like the citation verifier, it has **no LLM in it** (a model asked to rate "credibility" just pattern-matches the credibility-shape farms are built to fake); it's pure, deterministic domain scoring.

- **Domain-authority scoring** (`src/source-authority.ts`, pure / no network). `scoreAuthority(url) → { tier: primary | reputable | unknown | low, score, reason }`. Boost-led, because that's where precision is high: `*.gov`/`*.edu`/`*.mil` + `.ac.*` TLDs, standards/academia (arXiv, IETF, W3C, Nature…), and official docs (a curated vendor set + `docs.`/`developer.` subdomains) score **primary**; Wikipedia/Stack Overflow/GitHub score **reputable**; unrecognized domains stay **unknown / neutral — never punished** (a niche-but-legit source shouldn't lose for being unfamous); a small, conservative, hand-curated denylist of observed content farms scores **low** (precision over recall — a missed farm is acceptable, a misflagged real source is not).
- **Keep-stage ranking** so authority wins the limited fetch slots. Before the slot-limited fetch selection, candidates are reordered by authority — authoritative sources get read ahead of whatever search ranked first. `--source-authority` / `DEEPDIVE_SOURCE_AUTHORITY`: **`prefer`** (default — reorder only, drops nothing), **`strict`** (also drops `low`-tier farms, with a min-keep floor so an all-farm round still returns sources), **`off`** (identity).
- **Source-trust signal in the output and `--json`.** The citation-health footer now also reports the authority axis when it's not clean — `Source trust: high | mixed | low` with per-tier counts — so a fully-cited answer built on content farms is flagged instead of silently confident (`citation support: 1.00 · source trust: low` reads as the honest two-axis result). `--json` gains a per-source `authority: { tier, score, reason }` and a top-level `sourceTrust` summary; high-trust runs stay silent so clean output stays clean.

## [0.25.3] - 2026-06-15

### Fixed — the installed `deepdive` command was a silent no-op

- **`npm i -g @askalf/deepdive` then `deepdive …` ran nothing** (exit 0, no output); only `node dist/cli.js …` worked. npm installs the bin as a symlink, so `process.argv[1]` was the symlink path while `import.meta.url` was the resolved module path — the entry-point guard compared them raw, never matched, and skipped `main()`. The guard now compares `realpathSync(argv[1])` to `realpathSync(import.meta.url)`, so `deepdive`, `npx deepdive`, and `node dist/cli.js` all run while imports (tests) still don't. Pinned by `test/cli-entrypoint.test.mjs` (spawns the CLI through a symlink). Went unnoticed because the bench and tests invoke `node dist/cli.js` directly, never the installed bin.

## [0.25.2] - 2026-06-15

### Fixed — synthesis reliability on long / stalling generations

- **The final synthesis call now streams in every mode, bounded by an idle-token deadline.** Non-interactive runs (`--json`, non-TTY) previously synthesized through the non-streaming client, which waits for the whole response under a single whole-call timeout (`DEFAULT_LLM_TIMEOUT_MS`, 120s) and retries the entire generation on expiry — so a slow or briefly-stalling upstream that intermittently timed out mid-generation re-ran the full synthesis up to three times (~360s) before failing. Synthesis now always uses the streaming client (`callLLMStream` accumulates to a string when there is no token sink), so a long-but-healthy generation finishes in one pass. A new idle-token deadline on the SSE read (`parseSSE`) fails a genuinely stalled stream fast — no token for the timeout — instead of hanging to the global `--max-runtime`, or forever when it is unset, which also closes a latent gap in the interactive streaming path. Connect-only retry is preserved. Pinned by new `parseSSE` / `callLLMStream` tests.

## [0.25.1] - 2026-06-12

### Fixed — the fetch-stage wedge (#87)

- **A single unresponsive page can no longer hang the whole run.** Root cause of the observed 18-minute idle wedge: the per-fetch page work includes Playwright calls the per-call timeouts cannot cover — `page.evaluate` accepts no timeout, so a renderer main thread blocked after `domcontentloaded` (a dialog, `window.print()`, a never-settling document) left the fetch promise pending forever and the concurrency slot never freed. `fetch()` now races the entire page lifecycle against a hard deadline (2× the fetch timeout + 10s — only reachable when the per-call timeouts have already failed to fire); on expiry the page is force-closed without being awaited and the run records one failed fetch and continues. The browser context also gets `setDefaultTimeout(timeoutMs)` so every timeout-accepting protocol call is bounded by the configured fetch timeout instead of Playwright's 30s default. New `FetchWedgeError` + `withHardDeadline` pinned by `test/fetch-wedge.test.mjs`.

## [0.25.0] - 2026-06-12

### Changed — date-grounded planner and critic

- **The planner and critic prompts now carry today's date** (`Today's date: YYYY-MM-DD`). Without it, recency-sensitive questions got sub-queries anchored to the model's training-time sense of "recent" — and with `--since` set, the post-fetch freshness filter then culled most of what those stale queries returned (the v0.23.0 bench's `recent` question kept 1 source against a 3-source minimum, deterministically).
- **Event-shaped sub-queries** (releases, announcements, news, versions) are directed to use absolute dates instead of "latest"/"recent"; **conceptual and scholarly sub-queries are directed to stay timeless**. The counterweight matters: blanket year-anchoring measurably hurt the scholarly bench question (citation support 0.68 → 0.44, reproduced) because bare year tokens distort keyword-matched sources like arXiv/OpenAlex. With the scoped rules, academic recovered to 0.92 and `recent` rose from a deterministic 1 source to 2–4 across runs (single-change board in `bench/results/2026-06-12-v0.25.0-date-grounding.md`, run at the pre-0.24.0 base — combined with 0.24.0's news fallback, `recent` holds its gate).
- **With `--since`, the prompts disclose the cutoff** ("a freshness filter will DROP every source published before …") so every sub-query is shaped to the surviving window. New `PlanContext` (`now`, `sinceMs`) threaded from the agent at both `planQueries`/`critique` call sites; prompt contracts pinned by `test/plan-prompt.test.mjs`.

## [0.24.0] - 2026-06-12

### Added — news adapter (keyless) + recency-aware fallback

- **`--search=news`** — recent, dated news articles via the Bing News RSS feed, no API key. Bing wraps result links in an `apiclick.aspx` redirect; the adapter unwraps the embedded `url` param so deepdive fetches and cites the **publisher directly** (non-http(s) targets rejected). Each snippet is prefixed with the article's `YYYY-MM-DD` pubDate so the planner and synthesizer can see recency at a glance; 403/429 classify as rate-limit errors, so `multi:` benching and degradation visibility work as for every other adapter. Hand-rolled bounded-regex RSS parsing, zero new dependencies.
- **Recency-aware fallback default**: when `--since` is set (and no explicit `--search-fallback`/env is given), the default fallback becomes **`news,wikipedia`** instead of `wikipedia`. The v0.23.0 validation bench showed why: with DDG throttled, the `recent` question fell back to encyclopedia pages that the `--since=180d` freshness filter culled as undated/stale, completing with 1/3 sources. A recency-filtered run now degrades into dated, fresh sources. Explicit flag/env always wins; `=none` still disables.
- Bench: `recent` passes on two independent runs with the change (6/3 sources at 1.00 citation support, then 5/3 at 0.80), and the full board hit **6/6 — the first perfect scoreboard** (trajectory 1/6 → 4/6 → 5/6 → 6/6 since v0.21.0). Disclosure in `bench/results/2026-06-12-v0.24.0-news-fallback.md`: a concurrent planner-prompt edit shared the build during that board, so re-run at this tag for a single-change reading.

## [0.23.0] - 2026-06-12

### Added — Wikipedia keyword ladder (the fallback actually lands now)

- **Zero-result Wikipedia queries retry with progressively shorter keyword variants** (4 → 2 → 1 leading content tokens; new pure `src/query-keywords.ts` drops stopwords and generic instruction words while keeping technical tokens like `HTTP/3`, `php-fpm`, `fastcgi_buffer_size` intact). MediaWiki search matches article titles/text and returned zero for the planner's long natural-language queries — which hollowed out wikipedia exactly where it matters most: as the default fallback when the primary backend is rate-limited. Both stress benches died on this exact gap. At most 3 extra keyless API calls, only on the would-have-been-empty path; verbatim hits are untouched. Applies to all wikipedia usage (direct, `multi:` sub-adapter, fallback). New exports: `extractKeywords`, `keywordLadder`.
- Checked in: the 2026-06-12 healthy-DDG bench scoreboard (4/6 PASS at v0.22.0 — the two failures were this gap; DDG re-throttled mid-bench and the un-laddered fallback came back empty).

### Upstream note

- The morning's "planner did not return JSON" failures on default runs were **not** a deepdive bug: an upstream serving-side shift made `claude-sonnet-4-6` ignore client system prompts bare-appended after dario's CC persona. Fixed in dario **4.8.66** (`CLIENT_SYSTEM_PREFACE` precedence framing). deepdive users on dario should upgrade: `npm i -g @askalf/dario`.

## [0.22.0] - 2026-06-11

### Changed — search fallback defaults ON (`wikipedia`)

- **`searchFallback` now defaults to `wikipedia`** — keyless, reliable, and never sharing the primary backend's failure mode. The v0.21.0 baseline bench made the case (scoreboard committed under `bench/results/`): with DuckDuckGo rate-limiting the test box, **5 of 6** default-config questions died with zero sources while the one multi-backend question passed with 12 sources and 0.86 citation support. A default run dying on a single backend's throttle was the largest reliability gap vs hosted competitors, who never return nothing.
- The fallback only engages when a round's primary searches produced **zero candidates** — healthy runs are byte-identical to before. Disable with `--search-fallback=none` (or `off`, or `DEEPDIVE_SEARCH_FALLBACK=none`).
- Because the fallback engaging changes where the answer's sources come from, the notice now prints to stderr **even without `--verbose`** — a degraded run can never be mistaken for a normal one.
- Live-proven under an active DDG rate limit: a question that exited 3 minutes earlier completed via the fallback — 3 sources, 9/9 citations supported, $0.044.

## [0.21.0] - 2026-06-11

### Added — PDFs out of the box

- **`pdfjs-dist` ships as an optional dependency** — a default `npm install -g @askalf/deepdive` now reads PDFs with zero extra steps. The academic adapters (arxiv, pubmed, semanticscholar, openalex) surface PDFs constantly; silently skipping them gutted exactly the queries those adapters exist for. Degradation stays graceful: `--omit=optional` installs (and Node versions below pdfjs-dist's `>=22.13` engines floor, where npm engine-skips the optional dep) still run fully — PDF sources are skipped with the existing `pdf-no-extractor` event and `doctor` reports the state. CI's Node matrix now tests both worlds.

### Added — `--max-runtime` global deadline

- **`--max-runtime=<dur>`** (env `DEEPDIVE_MAX_RUNTIME`, config key `maxRuntime`) — wall-clock deadline for the whole run, so a wedged stage can never hang a run forever (observed in the wild: an indefinite fetch-stage wedge with all per-fetch timeouts "passing"). Graceful unwind via the run's AbortSignal at the deadline (browser closes, the message names the cause, exit 1) plus an unref'd hard-exit backstop 15s later if the unwind itself wedges. Unit required (`90s`, `10m`, `1h`) — the shared duration parser defaults bare numbers to *days*, and a silent `--max-runtime=300` → 300 days would be worse than no deadline.

### Added — `multi:` degradation visibility + rate-limit benching

- **`search.degraded` event** — a fan-out (`multi:`) search that succeeds overall but loses sub-adapters now reports them (`MultiSearch.lastFailures`, duck-read by the agent). Previously partial-failure tolerance *hid* a rate-limited backend: the first live bench run validated this — DDG was throttled the entire run and the answer quietly synthesized from a single StackExchange source.
- **Benching** — a sub-adapter that rate-limits once is not re-asked for the rest of the run (it keeps appearing in `lastFailures` so the degradation stays visible). When every sub-adapter is benched, `multi:` throws `SearchRateLimitError`, composing with the round short-circuit and `--search-fallback`.
- New export: `SubAdapterFailure`.

### Added — quality bench harness

- **`bench/run.mjs` + `bench/questions.json`** — six golden questions (factual, deep technical, scholarly, comparison, recency, practitioner) run through the built CLI against a live endpoint and scored on structural gates: completed, enough sources, citation-verifier support ratio, answer length, topical keywords, cost ceiling. Markdown scoreboard out. Manual dev tool by design (live LLM + live web) — never in CI. CLAUDE.md now requires a before/after bench run for any planner/synthesizer prompt change. Scoring functions are pure and unit-tested.

## [0.20.0] - 2026-06-11

### Added — search resilience: rate-limit detection, zero-source abort, recovery fallback

Built from a live dogfood failure: DuckDuckGo silently rate-limits a burst of queries, every search returns 0 results with no warning, and the run still burned a synthesis LLM call to produce "unable to answer".

- **Rate-limit detection** — the DuckDuckGo adapter now recognizes throttling (HTTP 202/403/429, or a 200 bot-challenge page with zero parsed results) and throws a typed `SearchRateLimitError` instead of silently returning nothing. Challenge detection only runs when the parse found zero results, so it can't false-positive on a real results page. New exports: `SearchRateLimitError`, `isRateLimitError`, `looksLikeDdgChallenge`.
- **Request spacing** — consecutive DDG requests are spaced 1s apart so a normal multi-query round no longer trips the limiter (`DEEPDIVE_DDG_DELAY_MS` to tune; `0` disables).
- **Per-query error tolerance** — a failed search emits a new `search.error` event and the round continues (previously any adapter throw killed the run after the plan call was already paid for). A rate-limited query skips the round's remaining queries — don't hammer a limiter that just refused. `multi:` classifies its every-sub-adapter-failed error as a rate limit when *all* failures were rate limits.
- **Zero-source abort** — when nothing survived search + fetch + filters, the agent throws `NoSourcesError` **before** the synthesis call. The CLI renders a what-to-try-next message naming the cause (rate limit vs. fetch-side losses vs. genuinely empty) and exits with new code **3** so wrapping scripts can branch. Saved (`continue`) and `--include` sources still avert the abort. New exports: `NoSourcesError`, `SearchErrorInfo`.
- **`--search-fallback=<adapters>`** (env `DEEPDIVE_SEARCH_FALLBACK`, config key `searchFallback`) — opt-in recovery: when a round's primary searches produce zero candidates, the round's queries re-run once through the fallback adapter (new `search.fallback` event). A comma list fans out (`wikipedia,arxiv` → `multi:wikipedia,arxiv` via new pure `normalizeAdapterList`). The fallback pass runs *all* the round's queries, including ones the primary's short-circuit skipped.

### Added — `--version`

- **`--version` / `-V`** prints the bare version (script-friendly). Previously the version was only visible via `doctor`.

### Fixed

- Unknown search adapter names / missing adapter keys in the research path now exit 2 with a clean message instead of an unhandled rejection.

## [0.19.0] - 2026-06-09

### Added — HTML export: heading anchors + table of contents

- **Heading anchors** — `markdownToHtml` gains `headingIds`: headings get slug `id`s (lowercased, dashed, deduped with `-2`/`-3`; derived from the readable text with inline markup and `[N]` citations stripped). Off by default; the HTML export enables it, so deep links like `report.html#pricing-changes` work.
- **Table of contents** — exported reports with 3+ `h2`/`h3` headings get a `<nav class="toc">` after the meta line, linking to the heading anchors (h3s indented). Short answers stay clean (no TOC). Labels are HTML-escaped.
- New pure exports: `extractHeadings` (fence-aware, slug-consistent with `markdownToHtml`), `headingPlainText`, `slugify`.

## [0.18.0] - 2026-06-09

### Added — `--search=multi:<a>,<b>` fan-out

- **Multi-adapter fan-out** (`src/search/multi.ts`) — `--search=multi:duckduckgo,wikipedia,arxiv` queries every listed adapter **concurrently**, interleaves results round-robin in adapter order, dedupes on the normalized URL, and re-ranks densely. Partial failures are tolerated (a throttled backend doesn't sink the round); it throws only when *every* sub-adapter failed, naming each failure. Sub-adapters resolve recursively (keys still required where applicable); nesting `multi:` is refused. Composite name (`multi(a,b)`) shows up in `doctor` and `search`. New exports: `MultiSearch`, `interleaveResults`.

### Added — `deepdive rerun <id>`

- **`deepdive rerun <id> [--narrate]`** — the longitudinal workflow in one command: re-run a saved session's question **fresh** (new search + fetches; the parent's sources are deliberately *not* seeded — unlike `continue`, the runs are independent snapshots), save it as a new session linked via `parentId` with the parent's tags inherited (`--tag` overrides), then automatically print the source-set + answer diff against the original. `--narrate` adds the one-shot LLM change summary. In `--json` mode stdout stays a single JSON envelope; a stderr hint points at `deepdive diff a b --json` for the structured delta. `rerun` requires session persistence (errors under `--no-sessions`).
- Internal: `runResearch` now returns `{ code, sessionId }` so subcommands can post-process the saved record; `persistSession` accepts a tags override.

## [0.17.0] - 2026-06-09

### Added — session tags

- **`--tag=<name>[,<name>]`** (env `DEEPDIVE_TAGS`, config-file key `tags`) — label a run's saved session. Tags are normalized (trimmed, lowercased, `#`-stripped, deduped) and stored as an additive optional `tags` field on the record (older sessions load unchanged).
- **`deepdive sessions tag <id> <tags>` / `sessions untag <id> <tags>`** — retro-label a saved session; atomic load→merge→save. Untagging to empty removes the field.
- **Tag filtering** — `sessions ls --tag=<t>` and `stats --tag=<t>` scope to sessions carrying *every* listed tag, so per-client/per-project research cost is one command. The filter comes only from the explicit `--tag` flag — a config-file default tag labels new runs but never silently hides sessions from listings. Tags render as `#name` in `sessions ls`.
- New exports: `normalizeTags`, `tagSession`, `untagSession`.

### Added — near-duplicate source dedup

- **Near-duplicate detection** (`src/similarity.ts`) — a fetched source whose extracted content is ≥ 90% shingle-similar (word 5-gram Jaccard) to an already-kept source is dropped with a new `near-duplicate` `fetch.skipped` reason. Catches the same article syndicated across hosts (wire copies, mirrors, AMP), which URL-level dedupe can't. **Default on** — the conservative 0.9 threshold only fires on genuine copies (different articles on the same topic typically score < 0.3). Tune with `--dedupe-threshold=<0..1>` (`DEEPDIVE_DEDUPE_THRESHOLD`); disable with `--no-dedupe` (`DEEPDIVE_NO_DEDUPE=1`). Config-file keys: `dedupe` (boolean), `dedupeThreshold`. `--include` / `continue` sources are never dropped — they act as dedupe anchors so a re-search can't re-add a copy of what you already have. New pure exports: `contentShingles`, `jaccard`, `findNearDuplicate`, `DEFAULT_NEAR_DUPE_THRESHOLD`.

## [0.16.0] - 2026-06-09

### Added — two scholarly search adapters (Semantic Scholar, OpenAlex)

- **`--search=semanticscholar`** (alias `s2`, `src/search/semanticscholar.ts`) — academic paper search via the S2 Graph API. Keyless works but is heavily rate-limited (frequent 429s); `DEEPDIVE_S2_KEY` makes it reliable. Snippet shows citations/year/authors.
- **`--search=openalex`** (`src/search/openalex.ts`) — ~250M scholarly works across all disciplines, keyless. `DEEPDIVE_OPENALEX_MAILTO` joins the faster polite pool. URL prefers the open landing page, falling back to the DOI.

Both keep their transform in an exported pure mapper and reuse `searchTimeoutSignal`. OpenAlex verified live; deepdive now ships **14 search adapters**.

### Added — `stats` + `sessions ls` filter

- **`deepdive stats [--json]`** (`src/stats.ts`) — aggregate insights across all saved sessions: run count, total calculated cost, sources fetched + avg/session, total rounds + deep-run count, a per-model breakdown (runs + cost), and the date span. New pure `aggregateSessionStats` / `renderStats` (exported) and a `loadAllSessions` reader.
- **`deepdive sessions ls [<filter>]`** — optional case-insensitive substring filter on the question text, so a large history stays navigable.

## [0.15.0] - 2026-06-09

### Added — `search` and `open` convenience commands

- **`deepdive search "<query>"`** — run just the configured search adapter and print the raw candidate list (no LLM, no fetch, no browser). Honors `--search` and `--json`; `--results-per-query` sets the count (default 10). A cheap way to preview a backend or debug an adapter.
- **`deepdive open <id>`** — render a saved session to a self-contained HTML file (temp dir, or `--out=<path>`) and open it in the default browser. The file path is always printed, so it works on a headless box. Cross-platform opener (`open`/`xdg-open`/`start`) selected by a pure, tested `browserOpenCommand`; the target is passed as a single argv entry (no shell).

### Added — three more keyless research adapters

- **`--search=hackernews`** (alias `hn`, `src/search/hackernews.ts`) — Algolia-hosted HN search, no key. Community discussion / release threads; Ask/Show HN posts fall back to the HN thread URL. Snippet shows points/comments.
- **`--search=stackexchange`** (aliases `stackoverflow`/`so`, `src/search/stackexchange.ts`) — Q&A search, no key (throttled). Default site `stackoverflow`; `DEEPDIVE_STACKEXCHANGE_SITE` selects another (serverfault, superuser, …). Entity-decoded titles; snippet shows score/answers/accepted.
- **`--search=pubmed`** (`src/search/pubmed.ts`) — biomedical literature via NCBI E-utilities (esearch → esummary), no key. Kept sources are abstract pages; snippet shows authors/journal/date.

All three reuse `searchTimeoutSignal`, keep their transform in an exported pure mapper, and were verified against the live APIs. deepdive now ships 12 search adapters.

### Added — `--since` recency filter

- **`--since=<date|duration>`** (env `DEEPDIVE_SINCE`) — drop fetched sources published before a cutoff, building on v0.14's published-date extraction. Accepts an absolute date (`2024`, `2024-06`, `2024-06-15`) or a relative duration meaning "that long ago" (`30d`, `12h`, `2w`). A web source whose detected publication date precedes the cutoff is skipped (new `stale` `fetch.skipped` reason); sources with no detectable date are kept (no penalty for missing metadata). Doesn't apply to `--include` / `continue` sources. New pure `resolveSince` (exported); persistable as `since` in the config file. A supplied-but-unparseable `--since` is a hard error (exit 2), not a silent no-op.

## [0.14.0] - 2026-06-09

### Added — config file, named profiles, shell completion

- **`~/.deepdive/config.json`** (override path with `DEEPDIVE_CONFIG`) — persist defaults so you stop retyping `--base-url` / `--model` / `--search`. Friendly keys mirror the flags (`model`, `search`, `deep`, `denyDomain`, `tldr`, … and `"cache": false`-style toggles), plus an optional `profiles` map and `defaultProfile`. Implemented by translating the file to the `DEEPDIVE_*` env strings `resolveConfig` already reads and layering them *under* the real environment — so `resolveConfig` is untouched and precedence is **CLI flags > env vars > profile > config-file base > defaults**.
- **`--profile=<name>`** — named setting bundles. Built-ins: `deep`, `thorough`, `fast`, `cheap`, `strict`. A config-file profile of the same name overrides the built-in; `defaultProfile` applies one every run. Unknown names error with the available list.
- **`deepdive completion <bash|zsh|fish>`** — print a shell completion script (`source <(deepdive completion bash)`), completing subcommands + common flags.

New modules `src/config-file.ts`, `src/profiles.ts`, `src/completion.ts`; new library exports `loadConfigFile`, `fileConfigToEnv`, `BUILTIN_PROFILES`, `resolveProfile`, `listProfiles`, `completionScript`. 20 new tests; precedence chain verified end-to-end.

### Added — answer quality: published dates, recency-aware synthesis, confidence, TL;DR

- **Published-date extraction** (`src/dates.ts`) — recover a page's publication date from its rendered HTML (JSON-LD `datePublished` → publication `<meta>` tags → `<time datetime>` → modified-date fallbacks), range-validated to reject parse noise. Surfaced on the source row (`fetched … · published …`), in the HTML export, and in `--json` as `publishedAt`. Sources without a date degrade silently.
- **Recency-aware synthesis** — the synthesizer's source packet now carries `(published YYYY-MM-DD)` per source, and the system prompt tells it to prefer the more recent source when sources conflict. No behavior change when no dates are present.
- **Confidence signal** (`src/confidence.ts`) — a deterministic coverage read printed alongside the cost line (`confidence · high · 11 sources · 18/18 citations supported`) and included in `--json` as `confidence`. `low` flags a thin source base, an uncited answer, or weakly-supported citations. Suppressed by `--no-cost`. Explicitly a sanity read, not a correctness claim.
- **`--tldr`** (env `DEEPDIVE_TLDR`) — opt-in: lead the answer with a one-paragraph, still-cited TL;DR before the full detail. Output is identical to before when unset.

`Source` gains an optional `publishedAt`. `synthesize()` now takes an options object (`{ onToken, onUsage, tldr }`) instead of trailing positional callbacks. New library exports: `extractPublishedDate`, `assessConfidence`, `formatConfidenceLine`. 21 new tests; date extractor verified against live pages.

### Added — three keyless-friendly search adapters + adapter contract doc

- **`--search=wikipedia`** (`src/search/wikipedia.ts`) — MediaWiki search API, no key. Encyclopedia-first retrieval for definitional/factual sub-queries. Language via `DEEPDIVE_WIKIPEDIA_LANG` (default `en`). Search-match snippets are tag-stripped and entity-decoded; kept sources are canonical `/wiki/<Title>` URLs.
- **`--search=arxiv`** (`src/search/arxiv.ts`) — arXiv Atom API, no key. Research-paper/preprint search; kept sources are abstract pages (the PDF path handles linked PDFs). Hand-rolled Atom parser, https-forced, arxiv.org-only.
- **`--search=github`** (`src/search/github.ts`) — GitHub repository search. Works keyless (60 req/hr); `DEEPDIVE_GITHUB_TOKEN` raises the limit. Snippet carries the repo description + star count.
- **`docs/search-adapter.md`** — the `SearchAdapter` contract (URL/limit/rank/error/timeout/no-deps rules) plus a copy-paste scaffold, so community adapter PRs have a spec to build against. README "Search adapters" table and CLI `--help` updated.

All three reuse `searchTimeoutSignal` for the hardened per-request timeout and keep their response→`SearchResult[]` transform in an exported pure function. 21 new tests; verified against the live APIs.

### Added — research workspace: export, diff, session lifecycle

Your saved sessions are a local research corpus you own. Three commands turn that history into a workspace hosted tools structurally can't offer (your data never left your machine, so it's there to revisit):

- **`deepdive export <id> [--format=html|md] [--out=path]`** — render a saved session as a shareable artifact. HTML output is a **single self-contained document**: inline CSS, no scripts, no remote assets, light/dark aware, print-friendly; inline `[N]` citations become superscript anchors into the source list. Format is inferred from `--out`'s extension (`.html`/`.md`), defaulting to HTML. The markdown→HTML renderer (`src/markdown.ts`) is hand-rolled, so export adds **no runtime dependency**.
- **`deepdive diff <id-a> <id-b> [--narrate] [--json]`** — show how the answer and its source set changed between two runs. Source-set delta (added/removed/shared) keyed on the normalized URL; a deterministic LCS line diff of the answer with collapsed unchanged context; metadata deltas (model, sources, rounds, cost). `--narrate` adds a one-shot LLM summary of what *substantively* changed (new/dropped claims, reversals). The longitudinal "what changed since last month?" view, answered entirely from local history.
- **`deepdive sessions rm <id> [<id>...]`** and **`deepdive sessions prune [--older-than=<dur>] [--keep=<n>] [--dry-run]`** — lifecycle management so the corpus doesn't grow unbounded. `--older-than` takes `30d`/`12h`/`90m`/`2w`/bare-days; `--keep=N` always retains the newest N; both together prune only sessions past the keep-set *and* older than the cutoff. `--dry-run` previews. With neither flag, `prune` refuses to run — history is never wiped by default.

New modules: `src/markdown.ts` (Markdown→HTML), `src/html-export.ts` (report renderer), `src/diff.ts` (session diff). New `sessions.ts` helpers: `deleteSession`, `pruneSessions`, `selectSessionsToPrune`, `parseDuration`. All exported from the library entry point. 44 new tests.

## [0.13.2] - 2026-06-04

### Added

- **`--browser-cdp-endpoint=<url>` (env `DEEPDIVE_BROWSER_CDP_ENDPOINT`)** — attach to an existing CDP browser instead of launching a local Chromium. `BrowserSession.start()` calls `connectOverCDP` when set, runs the fetch in an isolated context on the remote browser, and never downloads or launches Chromium — so containerized/fleet installs can share one hardened browser (e.g. a browser bridge) and skip the Playwright browser download. Launch args/stealth are owned by the remote browser; deepdive still sets the per-run context (UA, viewport, locale). `deepdive doctor` reports the CDP connection + remote Chrome version when the endpoint is set. Default (unset) behavior is unchanged.

### Fixed

- **Fetch batch over-allocated when the source pool was nearly full** (`src/agent.ts`). The per-round batch was sliced to `Math.max(headroom, candidatesFoundThisRound)` — the *larger* of the two — so a round with 1 slot left but 5 candidates dispatched 5 Playwright fetches, discarding 4 once the keep-loop hit `maxSources`. Now capped at `Math.min`: the batch never exceeds the remaining headroom. Adds an agent-loop regression test (maxSources=2, 5 candidates → 2 fetches).
- **`robots.txt` re-fetched once per URL instead of once per origin** (`src/cli.ts`). `runResearch` built the agent config but never supplied a `robotsCache`, so `canFetch`'s cache-miss path issued a fresh `GET <origin>/robots.txt` for every URL even when many shared a host. Now passes a per-run in-memory `createRobotsCache()`.

## [0.13.0] - 2026-05-28

### Added — `--search=auto` fallback mode

New search adapter `auto` runs DuckDuckGo first and transparently falls back to Brave Search when DDG throws (rate-limit / 5xx / network error) or returns zero results.

```bash
# DDG primary, Brave fallback (only if DEEPDIVE_BRAVE_KEY is set).
export DEEPDIVE_BRAVE_KEY=<your-brave-key>
deepdive "test query" --search=auto

# Equivalent via env.
DEEPDIVE_SEARCH=auto deepdive "test query"
```

If `DEEPDIVE_BRAVE_KEY` is unset, `auto` degrades to DDG-only (does not error) — same effective behavior as the prior default. With the key set, transient DDG failures are masked by the Brave retry.

Brave Search itself has been wired as a first-class `--search=brave` adapter since before this release (`src/search/brave.ts`); this change adds the orchestration layer.

### Internal

- `src/search/auto.ts` (new): `AutoSearch` wraps a primary + optional secondary `SearchAdapter`. On primary error OR empty result it retries the secondary, unless the abort signal is already tripped (in which case it rethrows the primary error to preserve cancellation semantics).
- `src/search.ts`: new `auto` case in `resolveSearchAdapter`. Brave secondary is constructed only when `DEEPDIVE_BRAVE_KEY` is present, so `auto` works in unconfigured environments (DDG-only degrade) without an env-var error.
- `src/cli.ts`: `--search` help text lists `auto` and documents the DDG→Brave fallback contract.

### Tests

- `test/search-auto.test.mjs` (new, 9 cases): primary success, primary error → fallback, primary empty → fallback, primary error with no secondary rethrows, primary empty with no secondary throws zero-results, signal/limit pass-through, aborted signal skips fallback, and the two `resolveSearchAdapter("auto", env)` paths (with and without `DEEPDIVE_BRAVE_KEY`).

## [0.12.0] - 2026-05-18

Adds **`deepdive continue <id> [<refined-question>]`** — a new subcommand that runs a *full* agent loop seeded with a saved session's sources. Unlike `resume` (which just re-synthesizes against the saved corpus — cheap, no fetches), `continue` plans + searches + fetches new pages with the parent's sources kept in the pool. Saved as a new session linked to the parent via a new `parentId` field on the record.

### Added — `deepdive continue <id> [<refined-question>]`

```bash
# Original run.
deepdive "how does Claude's rate limiter work?"
# → session  2026-05-18_140312_abc12345

# Inspect the answer, decide we want to drill deeper.
deepdive continue 2026-05-18_140312 "specifically, what's the per-org vs per-key fallback?"
# → session  2026-05-18_141207_def67890   (parentId: 2026-05-18_140312_abc12345)
```

What it does, step by step:
1. Resolves the id prefix (same logic as `show` / `resume`).
2. Loads the parent's `SessionRecord`.
3. Runs `runAgent` with `preKept: record.sources` — the saved sources are seeded into the kept-sources pool, their URLs added to `seenUrls`, so the fetch loop *won't re-fetch what the parent already paid for*.
4. Persists the result as a new session with `parentId` set to the parent's id.

**Resume vs. continue** — pick by intent:

| | `resume` | `continue` |
|---|---|---|
| Re-asks the LLM? | yes (synth only) | yes (full pipeline) |
| Re-runs search? | no | yes |
| Fetches new pages? | no | yes (deduped against parent sources) |
| Cost profile | cheap (1 synth call) | similar to a fresh run |
| Persisted as | not persisted | new session, `parentId` set |

`resume` is for "I worded the question wrong, try again with the same sources." `continue` is for "this got close, now go further" — the parent's corpus rides along but the planner is free to expand it.

### Internal

- `src/agent.ts`: `AgentConfig` gains optional `preKept?: SourceWithContent[]`. After the `include[]` ingestion block (so local files still take precedence) and before the search loop, preKept entries are placed into the kept-sources pool with sequentially reassigned `id`s and their `url`s added to `seenUrls`. `maxSources` is respected — preKept may be partially truncated if the cap is small.
- `src/sessions.ts`: `SessionRecord` gains optional `parentId?: string`. Additive — pre-v0.12.0 records load with `parentId === undefined`. No migration needed.
- `src/cli.ts`: `continue` joins `SUBCOMMAND_VERBS`. `main()`'s research path extracted into a shared `runResearch({question, parsed, config, preKept?, parentId?})` helper used by both the default invocation and the new `continueCommand`. `persistSession` gains an optional `parentId` parameter, written into the record only when set so pre-v0.12.0 JSON shape is preserved for runs that don't use `continue`.

### Tests

+6 new across:
- `test/sessions.test.mjs` (2): `parentId` round-trips when set; pre-v0.12.0 records (no `parentId` on disk) load with `parentId === undefined`.
- `test/agent-loop.test.mjs` (2): preKept seeds appear alongside fresh-fetched sources with reassigned sequential ids; preKept URLs dedupe against fresh search results — the saved URL is never re-fetched even when the planner surfaces it.
- `test/parse-args.test.mjs` (2): `continue <id>` and `continue <id> <refined-question>` both parse correctly into `question` + `extras`.

**423/423 default suite green** (417 prior + 6 new).

### Why a minor bump

New CLI subcommand (`continue`), new exported library surface (`preKept?: SourceWithContent[]` on `AgentConfig`, `parentId?: string` on `SessionRecord`), new on-disk session-record field (`parentId`). Purely additive — `resume`, `show`, and the default research path are byte-identical to v0.11.0 for runs that don't use `continue`.

## [0.11.0] - 2026-05-18

Adds **`--max-cost`** — a hard budget cap on what a single run can spend. After each LLM call completes, the agent re-aggregates the cost across every model used (v0.10.0 multi-model layer) and throws `BudgetExceededError` if the running total crosses the cap. The CLI maps the error to a distinct exit code (2, vs 1 for real errors) so wrapping scripts can branch on it.

### Added — `--max-cost=<$X.YY>` / `DEEPDIVE_MAX_COST`

```bash
# Cap at 50 cents. Aborts before the next call if the running total exceeds.
deepdive "what changed in the python 3.13 GIL?" --deep --max-cost=$0.50

# Bare numeric form works too.
deepdive "..." --max-cost=0.25

# Hit the cap mid-run:
$ echo $?
2
$ deepdive: budget cap exceeded: spent $0.534 of $0.500
```

Semantics — the check fires **after** each call, not before. So the cap is a guarantee about "we will not start a NEXT call that would push past X", not "we will not exceed X by a single token." A long synth call can slightly over-spend; we accept that single overrun rather than try to predict per-token cost mid-stream (which isn't possible without per-streamed-token usage callbacks that aren't universally available on the wire formats deepdive supports). Same approach as dario's overage-guard: detect on the response, halt before the next request.

**Unknown models — partial enforcement.** When any model in the run isn't priced (no `PRICE_TABLE` entry AND no `DEEPDIVE_PRICE_*_PER_MTOK` env override), the cost estimator returns $0 for that model. The cap *still* enforces against the priced subset, but the abort message includes a one-line warning: `"N call(s) on unpriced models contributed $0 to the running total — cap enforcement is incomplete"`. Honest signal: you know the cap was enforced against what we could price.

### Internal

- New `src/budget.ts` (~70 lines): `parseMaxCost`, `formatMaxCost`, `enforceBudget`, `BudgetExceededError`. Pure; no I/O.
- `src/agent.ts`: the per-call usage sink now (a) tracks running unpriced-call count via `priceFor` lookup, (b) recomputes `estimateCostMultiModel` after each call when a cap is set, (c) calls `enforceBudget` which throws on exceed.
- `src/cli.ts`: parses `--max-cost=` via `parseMaxCost`; threads `maxCostUsd` to `runAgent`; catches `BudgetExceededError` distinctly and exits 2.
- `src/config.ts`: `RuntimeConfig` and `CLIFlags` gain `maxCostUsd?: number`; resolves env `DEEPDIVE_MAX_COST` via `parseMaxCost`.
- `AgentConfig` gains `maxCostUsd?: number` for direct library use.

### Tests

+21 new across:
- `test/budget.test.mjs` (14): `parseMaxCost` (bare number, leading `$`, whitespace, empty/null, zero/negative rejection, junk rejection, scientific-notation rejection), `formatMaxCost`, `enforceBudget` (undefined cap = no-op, under cap, boundary equality, exceed throws with right fields, unpriced-call message), `BudgetExceededError` class shape, integration-shape multi-model estimate.
- `test/parse-args.test.mjs` (4): `--max-cost=$0.50` parses to 0.5, `--max-cost=5` to 5, malformed throws with helpful message, negatives rejected.
- `test/agent-loop.test.mjs` (2): a real agent run with `maxCostUsd: 0.5` aborts as `BudgetExceededError` with `spentUsd > capUsd`; the same scenario with `maxCostUsd: undefined` completes successfully.

**417/417 default suite green** (396 baseline + 21 new).

### Why a minor bump

New CLI surface (`--max-cost`), new env var (`DEEPDIVE_MAX_COST`), new exported error class (`BudgetExceededError`) on the library surface, new `maxCostUsd?` field on `AgentConfig`. New exit code 2 for "cap hit" — distinguishable from exit 1 ("error"). Purely additive — runs without `--max-cost` are byte-identical to v0.10.0.

## [0.10.0] - 2026-05-18

Adds **per-stage model overrides** — plan, synthesize, and critic can each run on a different model, paid against the right price tier. The pipeline already tagged every LLM call with `phase: "plan" | "synth" | "critique"` (since v0.6.0's cost telemetry); v0.10.0 lets you actually act on that tag.

### Added — `--plan-model` / `--synth-model` / `--critic-model`

Three optional CLI flags, three matching env vars (`DEEPDIVE_PLAN_MODEL`, `DEEPDIVE_SYNTH_MODEL`, `DEEPDIVE_CRITIC_MODEL`). Each falls back to `--model` / `DEEPDIVE_MODEL` / the default `claude-sonnet-4-6` when unset. Resolution precedence: per-stage flag > per-stage env > base flag > base env > default.

```bash
# Plan with cheap, synth with expensive, critic with cheap. Typical 60-70% cost cut
# at synthesis-quality parity for a `--deep` run.
deepdive "what changed in the python 3.13 GIL?" --deep \
  --model=claude-sonnet-4-6 \
  --plan-model=claude-haiku-4-5 \
  --critic-model=claude-haiku-4-5

cost · ~$0.034 · 12.1k in / 4.2k out · 7 LLM calls · multi-model
     · ~$0.003 · 800 in / 200 out · 1 LLM call · claude-haiku-4-5    (plan)
     · ~$0.001 · 600 in / 150 out · 3 LLM calls · claude-haiku-4-5   (critic)
     · ~$0.030 · 10.7k in / 3.85k out · 3 LLM calls · claude-sonnet-4-6  (synth)
     (≈ at API list price; $0 on Claude Max via dario)
```

### Changed — cost telemetry is now per-model

`AgentResult.cost` is now `MultiModelCostEstimate` — a strict superset of the prior `CostEstimate`, with an added `byModel` array. Library consumers reading `amountUsd` / `inputTokens` / `outputTokens` / `calls` / `knownModel` keep working unchanged. The new `byModel` carries `{ model, estimate: CostEstimate }` for each model that actually saw a call, sorted alphabetically for deterministic ordering.

When all stages run on the same model (the default and pre-v0.10.0 behavior), the cost summary renders identically — single-line `cost · ~$X.XX · ... · <model>`. When two or three models were used, the CLI prints an aggregate line plus per-model breakdown lines.

### Changed — `llm.call` events carry the model used

The `llm.call` event union gained a `model: string` field. Library consumers building their own cost UIs against the event stream can now break down by model. Existing consumers reading only `phase` / `round` / `inputTokens` / `outputTokens` are unaffected.

### Internal

- `src/llm.ts`: new pure helper `withModel(base, model)` — returns a fresh `LLMConfig` with `model` swapped, preserves auth/baseUrl/format/timeouts.
- `src/pricing.ts`: new `estimateCostMultiModel(usageByModel, env)` + `MultiModelCostEstimate` interface. Sums priced costs across models; `knownModel` stays true only when every model used has a vendor-table or env-priced match.
- `src/agent.ts`: replaces the single `llmTotals` accumulator with `llmTotalsByModel`, builds a per-stage `LLMConfig` map at run start, threads the right config to `planQueries` / `synthesize` / `critique`. The aggregate `usage.llm` summary remains stable for existing library readers.
- `src/cli.ts`: new `renderMultiModelCostSummary` (called from the main run; `resume` mode still uses single-model `renderCostSummary` against the synth model since it's a one-call path).

### Tests

`+18 across` `test/config.test.mjs` (7 — per-stage defaults, individual flag overrides, env vars, precedence ladder, all-three combo), `test/pricing.test.mjs` (7 — empty input, single-model equivalence, two-known sum, stable ordering, unknown-model fall-through, zero-bucket skip, env override behavior including `knownModel` semantic), `test/parse-args.test.mjs` (4 — each flag captured, all-three plus base coexist). **396/396 default suite green** (378 baseline + 18 new).

### Why a minor bump

New observable surface: three CLI flags, three env vars, a new event field, a new cost-summary shape when multiple models are used. `AgentResult.cost` changed type (additive). Library consumers reading the agent event stream see a new `model` field on `llm.call`. Pre-v0.10.0 runs (no per-stage flags) produce byte-identical CLI output.

## [0.9.0] - 2026-05-07

Adds **session persistence** — every successful run is saved to disk and can be listed, re-printed, or resumed for cheap iteration — and **streaming during `--deep`** with round-header separators between intermediate drafts. The two features compose: you can watch a deep run stream all four rounds, then `deepdive resume <id> "what about Y instead of X"` to spend one more synthesis call against the same source corpus.

### Added — sessions (`src/sessions.ts`, ~190 lines, no new runtime deps)

Every successful agent run is persisted as a JSON record at `~/.deepdive/sessions/<id>.json` (atomic `.tmp` + `rename` semantics, mirroring the page cache). The record carries the full plan, round trace, kept sources **with their extracted content**, the answer, the verification report, and the cost estimate — enough to re-synthesize without touching the network.

- New module `src/sessions.ts` exporting `generateSessionId`, `saveSession`, `loadSession`, `listSessions`, `resolveSessionId`, `renderSessionsList`, `defaultSessionsDir`, `humanDuration`, plus `SessionRecord` / `SessionMeta` / `SessionStorageOptions` types.
- IDs are timestamp-prefixed: `YYYY-MM-DD_HHMMSS_<8-hex>`. Sortable chronologically, recognizable, collision-resistant within a second. `resolveSessionId` accepts unique prefixes — `deepdive resume 2026-05-07_134509` is enough when only one session matches.
- Three new subcommands:
  - `deepdive sessions ls` — list newest first; columns are id, age, source count, round count, model, truncated question
  - `deepdive show <id>` — re-render the original markdown answer + sources
  - `deepdive resume <id> [<new question>]` — re-synthesize against the saved sources (one LLM call), optionally with a refined question. No re-search, no re-fetch, no critic loop.
- New CLI flag `--no-sessions` and env vars `DEEPDIVE_NO_SESSIONS`, `DEEPDIVE_SESSIONS_DIR`.
- After every run deepdive prints a one-line stderr hint: `session  <id>  (deepdive resume <id>)`.
- Session persistence is non-fatal: a failure to save is reported as a warning to stderr but doesn't fail the run.
- `AgentResult.sources` type tightened from `Source[]` to `SourceWithContent[]` — the runtime value was already `SourceWithContent`, so this is a type-only change. Library consumers reading `id` / `url` / `title` / `fetchedAt` are unaffected (`SourceWithContent extends Source`).

```bash
$ deepdive "how does claude's rate limiter work" --deep
... (run completes) ...
session  2026-05-07_134509_5959f102  (deepdive resume 2026-05-07_134509_5959f102)

$ deepdive sessions ls
  2026-05-07_134509_5959f102      8s ago  12 src · 3 round  how does claude's rate limiter work

$ deepdive resume 2026-05-07_134509 "what changed in the 2024 redesign?"
... new answer streams against the same 12 sources ...
session  resumed from 2026-05-07_134509_5959f102
```

The cache solves "don't re-fetch URLs"; sessions solve "don't re-run the entire pipeline." Refining a question into a follow-up costs one LLM call instead of plan + N×search + N×fetch + N×synth + N×critique.

### Changed — streaming during `--deep` mode

`--deep` mode used to auto-disable streaming because intermediate rounds would print multiple full drafts back-to-back with no visual separation. v0.9 enables streaming again with a clear UX:

- Round 0 streams under the question's H1 header (current single-pass behavior, unchanged).
- Round 1+ each get a `\n\n---\n\n## Round N (deep)\n\n` separator before their tokens start streaming.
- The terminal scrolls naturally as each round's draft writes itself.
- `--out=file.md` still writes only the final answer's markdown — intermediate drafts are visible in the terminal but not persisted.
- `--no-stream` and `--json` still suppress streaming as before.

This is the v2 of the streaming UX from v0.3.0 that was scoped down to single-pass at the time. Now the headline `--deep` feature gets the same live-tokens treatment.

### Tests

23 new across `test/sessions.test.mjs` (15 — id format / round-trip / atomic write / schema rejection / list with bad files / prefix resolution including ambiguity / render), `test/parse-args.test.mjs` (6 — sessions/show/resume verbs capture extras; `--no-sessions`; sanity check that bare unquoted multi-word questions still throw), `test/config.test.mjs` (2 — sessions enabled/disabled, `DEEPDIVE_SESSIONS_DIR` override). Total test footprint now 378 across 10 suites. Existing streaming-config test updated to reflect the v0.9 behavior change.

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
