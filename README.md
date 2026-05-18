<p align="center">
  <h1 align="center">deepdive</h1>
  <p align="center"><strong>Your machine. Your LLM subscription. Your search backend. Your cited report.</strong><br>A local research agent: ask a question, it plans sub-queries, searches the web, reads the pages in a real browser, iterates with a critic loop until the answer stops having gaps, and writes you a cited markdown report. Nothing leaves your laptop except the searches you run and the URLs the planner picked to read. Every LLM call routes through <a href="https://github.com/askalf/dario">dario</a> (or any Anthropic-compat endpoint), so the 30-to-60 calls a deep query burns bill against the Claude Max subscription you're already paying for — not a hosted tool stacking its margin on top of Anthropic's API pricing.</p>
</p>

<p align="center"><em>Zero hosted dependencies. MIT. Independent, unofficial, third-party — see <a href="DISCLAIMER.md">DISCLAIMER.md</a>.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/deepdive"><img src="https://img.shields.io/npm/v/@askalf/deepdive?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/deepdive/actions/workflows/ci.yml"><img src="https://github.com/askalf/deepdive/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/deepdive/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/deepdive" alt="License"></a>
</p>

---

## What you keep

Every hosted research tool — Perplexity, OpenAI Deep Research, Gemini Deep Research — solves a real problem: one question → plan → search → read → cited answer. They also quietly take four decisions away from you:

**Your data.** The question, the sub-queries the planner invents, every URL the agent chose to read — all of it goes to the vendor's servers. Often to their analytics pipeline. Sometimes to their ad-targeting pipeline. With deepdive, none of that exists. The planner runs in your Node process. The searches hit whichever backend you point at (DuckDuckGo by default, zero keys required; SearXNG, Brave, Tavily, or Exa if you'd rather). The only outbound connections from your machine are: your chosen LLM endpoint, your chosen search endpoint, and the specific URLs the planner decided to read. No telemetry, no analytics, no data retention. Inspectable: `lsof -i` during a run.

**Your model.** Hosted tools pick for you — Perplexity routes through their own blend, OpenAI uses GPT-5, Gemini uses 2.5 Pro. deepdive runs whatever model your endpoint exposes. Default is `claude-sonnet-4-6` for a good quality/cost balance; switch to `claude-opus-4-7` for reasoning-heavy questions; point `--base-url` at a LiteLLM or vLLM instance and run a local model. Same one-line flag either way.

**Your search backend.** Hosted tools use their own search index and won't tell you its exact shape. deepdive swaps between DuckDuckGo HTML (default, no key), self-hosted SearXNG, Brave Search API, Tavily, or Exa with one flag. Adding a new adapter is ~30 lines of TypeScript.

**Your depth.** Hosted tools cap how far the agent will dig because unbounded research eats their unit economics. deepdive's `--deep` flag keeps iterating with a critic LLM — review draft → name the gaps → search for them → re-synthesize — until the critic says the answer is complete or you hit `--deep=N` rounds. You decide where the ceiling is.

## What you stop paying for

Most people reading this already pay Anthropic for Claude Max ($100–200/mo). A hosted research tool asks for another $20/mo subscription — on top of a subscription you already have — so some vendor's servers can run LLM calls that your Max plan would have covered for free.

Here's the math for one deep query — a question that needs the critic loop to finish well, roughly 50k–200k tokens across planner + synthesis + critique + re-synthesis:

| How you run it | Per-query cost | Per-month cost at 10 queries | Data stays local? |
|---|---|---|---|
| Per-token API (`claude-opus-4-7`) | **~$2–$8** | **~$20–$80** | Your infra, your call |
| Per-token API (`claude-sonnet-4-6`) | **~$0.30–$1.20** | **~$3–$12** | Your infra, your call |
| Perplexity Pro | Capped depth, fixed tier | **$20/mo** | ❌ Perplexity + upstream |
| OpenAI Deep Research (ChatGPT Plus) | Capped usage, fixed tier | **$20/mo** | ❌ OpenAI + upstream |
| Gemini Deep Research (AI Advanced) | Capped usage, fixed tier | **$20/mo** | ❌ Google + upstream |
| **deepdive + dario + Claude Max** | **$0 per query** | **$0** (included in Max) | **✅ your machine** |

The cost-arbitrage argument is: the deep-research workload is *exactly* the shape Claude Max was priced for — 50k–200k tokens per question, sustained, bursty. Running it through a second subscription that marks up LLM calls on top of LLM calls is paying twice for something you already bought. dario unlocks the subscription; deepdive is the tool that uses it for this workload.

---

## 60 seconds

```bash
# 1. Start dario (your local LLM router — https://github.com/askalf/dario).
dario proxy                         # http://localhost:3456, routes to Claude Max, OpenAI, etc.

# 2. Install deepdive.
npm install -g @askalf/deepdive
npx playwright install chromium     # first run only, ~300 MB

# 3. Ask.
deepdive "how does claude's rate limiter work" --deep --verbose --out=report.md
```

`--deep` turns on the critic loop (2 extra rounds by default). `--verbose` streams every plan / search / fetch / critique step to stderr so you can watch the agent think. `--out` writes the cited markdown to a file in addition to stdout.

---

## What the output looks like

A real deepdive run produces a file like this (excerpt):

```markdown
# how does claude's rate limiter work

Claude's rate limiter uses a two-tier rolling window: a **5-hour bucket**
and a **7-day bucket**, both scoped per OAuth session [1][2]. Requests
are billed against the short-term bucket first; when that window is
exhausted, the `representative-claim` response header switches from
`five_hour` to `seven_day` and Anthropic begins charging against the
longer bucket — still subscription billing, not API overage [3].

Exhausting both buckets triggers `overage` state, at which point per-token
Extra Usage charges apply if the account has enabled them; otherwise the
request gets a 429 [3][4]. The `anthropic-ratelimit-unified-*` response
headers expose the current utilization at request-response time so
clients can pool-balance intelligently [5].

...

## Sources

1. [Anthropic rate-limit headers docs](https://docs.anthropic.com/...) — fetched 2026-04-22
2. [Claude Code /usage command reference](https://code.claude.com/...) — fetched 2026-04-22
3. [Discussion #32 — seven_day claim explainer](https://github.com/...) — fetched 2026-04-22
4. [Anthropic overage billing documentation](https://docs.anthropic.com/...) — fetched 2026-04-22
5. [dario pool-mode implementation notes](https://github.com/...) — fetched 2026-04-22
```

Citations are numbered and inline. The source table at the end records the exact URL and fetch timestamp for every source, so you can verify any claim the model made.

---

## The `--deep` loop

Single-pass mode (no `--deep` flag) is what other local "research CLI" tools do: plan → search → fetch → synthesize → done. Good enough for simple factual lookups. Not great for "explain how X actually works."

`--deep` adds a critic:

```
plan ──▶ search ──▶ fetch ──▶ synthesize ──▶ critic ─┐
                                                      │
                              ◀───── "here's what's missing, try: q4, q5" ──┘
                              │
                              ▼
                          search ──▶ fetch ──▶ synthesize ──▶ critic ──▶ ...
```

The critic reads its own draft, flags gaps ("the draft didn't source the 429 header format"), and proposes up to three follow-up queries. The loop re-runs with those queries, re-synthesizes from every source gathered so far, and passes to the critic again. When the critic says the draft is complete — or when you hit `--deep=N` rounds — the loop stops.

Bare `--deep` = 2 extra rounds. `--deep=5` = up to 5. `--deep=0` is explicit single-pass.

In a TTY, every round's draft streams as it's written — round 0 lands under the question's H1; subsequent rounds are separated by a `---` divider and a `## Round N (deep)` header so you can read along as the agent iterates. The final round is whichever one the critic declared `done` on, or the round you set as the ceiling. The `--out` file gets only the final markdown answer; the streamed intermediate drafts are visible in the terminal but not persisted there.

**Why this is the whole point.** The critic loop is the axis hosted tools cap on. Per-query unit economics force them to ship a fixed depth — if they let you run a 5-round loop, some users would and their margins would collapse. On your own subscription, the only cap is the one you set on the command line.

---

## Citation verification

After every synthesis, deepdive checks each `[N]` citation in the answer against the extracted text of source N. This is a cheap, deterministic, lexical pass — no second LLM call — that catches the dominant failure mode of cited-answer tools: the model writing a confident sentence with a `[3]` whose source 3 doesn't actually contain the claim.

For each sentence with a citation, the verifier tokenizes the claim into content tokens (lowercased, stop-words dropped, numbers preserved) and scores recall against each cited source's tokens. A multi-cite sentence like `"X happened in 2024 [1][3]"` is supported only when **every** cited source clears the threshold — a bogus `[3]` buried in an otherwise-true sentence is still flagged.

When something fails, deepdive prints a small `## Citation health` footer at the end of the answer and surfaces the offending sentences in `--verbose`. Clean runs stay clean: no footer, no noise. Use `--strict-cites` in scripts to fail the run with a non-zero exit code.

In `--deep` mode the verifier runs once per round, not just at the end: when intermediate rounds produce sentences with weak citations, those sentences are forwarded to the critic as top-priority gaps to fill in the next round of search. The critic and verifier close the loop — instead of "find more sources, hope they help," the next round explicitly hunts for authoritative support for the exact sentences that lack it.

What this is not: a semantic judge. Lexical recall flags hallucinated names, numbers, and dates with high precision, but a paraphrased-but-truthful sentence can score below threshold and a topic-aligned-but-incorrect sentence can score above. Treat the report as a sanity check and a reading guide, not a proof of correctness. To dial the strictness, raise `--cite-min-recall` above the default `0.4`; to disable entirely, pass `--no-verify-cites`.

---

## PDFs and local files

Two long-standing gaps closed in v0.7: real research questions hit PDFs constantly (academic papers, RFCs, standards docs), and the most useful sources are often already on your laptop (project notes, internal docs, exported chats). deepdive now reads both.

**PDFs** are detected by URL extension or `Content-Type` and routed through a separate extractor instead of the headless browser's DOM (Chromium's PDF viewer doesn't expose useful text). Page cap defaults to 50 (`--pdf-max-pages=<n>`); large papers are truncated rather than blowing the synth context.

PDF extraction uses [`pdfjs-dist`](https://github.com/mozilla/pdfjs-dist) — Mozilla's reference PDF.js library. To preserve deepdive's "one runtime dependency" guarantee on default installs, `pdfjs-dist` is **not** a runtime dep. The extractor is dynamically imported the first time a PDF is seen; if the library isn't installed, the source is skipped with a clear `pdf-no-extractor` event. Enable with one command:

```bash
npm install -g pdfjs-dist
```

`deepdive doctor` reports the install state under the `pdf` category.

**Local files** are ingested via `--include=<path>[,<path>]`. Each path may be a file or a directory (one level deep, supported extensions only). Files become pre-fetched sources at the head of the kept-sources list — they get the lowest `[N]` citation IDs, so they're most prominent to the synthesizer. Supported types: `.pdf` (needs `pdfjs-dist`), `.md`, `.txt`, `.html`.

```bash
# Mix your project notes with web research:
deepdive "what's our policy on retroactive billing?" \
  --include=~/notes/billing,./CONTRIBUTING.md \
  --search=brave --deep
```

This is the kind of thing hosted research tools cannot do — your notes don't leave your machine, and the resulting answer cites them as `file:///abs/path` URLs the user can click open.

---

## Cost telemetry

Every run prints a one-line summary on stderr at the end:

```
cost · ~$0.0085 · 412 in / 234 out · 4 LLM calls · claude-sonnet-4-6
       (≈ at API list price; $0 on Claude Max via dario)
```

Token counts come straight from the Anthropic API responses. The dollar amount is computed against a small built-in price table covering the headline Claude models — see `src/pricing.ts` for current values; verify against [docs.anthropic.com/en/docs/about-claude/pricing](https://docs.anthropic.com/en/docs/about-claude/pricing) before relying on it for billing decisions. Unknown models render as `$?`; tokens are always shown.

The "$0 on Claude Max via dario" hint only appears when `--base-url` matches dario's default port (`http://localhost:3456`) — pointing at a different endpoint suppresses it automatically. Self-hosted or unfamiliar models can plug in their own pricing via `DEEPDIVE_PRICE_INPUT_PER_MTOK` and `DEEPDIVE_PRICE_OUTPUT_PER_MTOK` (per million tokens). Suppress the line entirely with `--no-cost` or `DEEPDIVE_NO_COST=1`. The same numbers also appear in `--json` output as `cost` and `usage.{llm,estimatedCostUsd}` for piping into your own dashboards.

**Per-stage model overrides** *(v0.10.0)*. The pipeline has three LLM stages: **plan** (decomposes the question into sub-queries), **synth** (writes the cited answer), and **critic** (only in `--deep` mode — reviews drafts and proposes follow-up queries). They have very different cost / quality trade-offs: planning is structurally simple; critique is structurally simple; synthesis is where quality matters. Override each independently:

```bash
deepdive "what changed in the python 3.13 GIL?" --deep \
  --model=claude-sonnet-4-6 \
  --plan-model=claude-haiku-4-5 \
  --critic-model=claude-haiku-4-5
# → cost · ~$0.034 · 12.1k in / 4.2k out · 7 LLM calls · multi-model
#        · ~$0.003 · 800 in / 200 out · 1 LLM call · claude-haiku-4-5
#        · ~$0.030 · 10.7k in / 3.85k out · 3 LLM calls · claude-sonnet-4-6
#        · ~$0.001 · 600 in / 150 out · 3 LLM calls · claude-haiku-4-5
```

Env vars too: `DEEPDIVE_PLAN_MODEL`, `DEEPDIVE_SYNTH_MODEL`, `DEEPDIVE_CRITIC_MODEL`. Any stage left unset falls back to `--model` / `DEEPDIVE_MODEL`. Cost telemetry breaks down per model when more than one was used; identical to v0.9 output when only one model was used.

**Hard budget cap** *(v0.11.0)*. `--max-cost=$X.YY` (or `DEEPDIVE_MAX_COST`) sets a dollar ceiling. After every LLM call, the agent re-aggregates spend across all models and aborts before the next call if the running total has crossed the cap. The CLI exits with code **2** on cap-hit (distinct from code 1 for real errors), so wrapping scripts can branch on it.

```bash
deepdive "..." --deep --max-cost=$0.50
# ...
# deepdive: budget cap exceeded: spent $0.534 of $0.500
# $ echo $?
# 2
```

The check fires *after* each call completes, so a long synth call may slightly over-spend before aborting — predicting per-token cost mid-stream isn't possible on every wire format deepdive supports. When the run uses any unpriced model (no entry in the built-in table and no `DEEPDIVE_PRICE_*_PER_MTOK` override), the abort message warns that enforcement was against the priced subset only.

---

## OpenAI-compatible endpoints

deepdive's wire format is Anthropic Messages by default — that's what dario speaks natively, and it's the format every Claude provider exposes. But the same pipeline works against any OpenAI Chat Completions endpoint via a built-in request/response adapter. Auto-detected from `--base-url`:

| URL pattern | Detected as |
|---|---|
| `api.openai.com/...` | `openai` |
| `localhost:11434` (Ollama default) | `openai` |
| `localhost:8000` (vLLM convention) | `openai` |
| anything else | `anthropic` |

Override with `--api-format=anthropic|openai` or `DEEPDIVE_API_FORMAT`. The adapter translates request shape, headers (Bearer for OpenAI, `x-api-key` + `anthropic-version` for Anthropic), the streaming SSE event format (`choices[].delta.content` ↔ `content_block_delta`), and the `usage` field (`prompt_tokens` / `completion_tokens` ↔ `input_tokens` / `output_tokens`).

```bash
# Run against an Ollama-served local model:
deepdive "explain how X works" --base-url=http://localhost:11434 --model=llama3.1

# Run against OpenAI directly (auto-detected):
OPENAI_API_KEY=sk-... deepdive "..." \
  --base-url=https://api.openai.com --api-key=$OPENAI_API_KEY --model=gpt-4o
```

Cost telemetry still works for OpenAI-shape endpoints — you'll need to plug in the pricing yourself via `DEEPDIVE_PRICE_INPUT_PER_MTOK` / `DEEPDIVE_PRICE_OUTPUT_PER_MTOK` since the built-in price table only covers the Claude models.

---

## Domain allow / deny lists

When the planner picks URLs, you sometimes want to force-pin to authoritative sources or drop noisy ones. Two flags, hostname-suffix matching:

```bash
# Drop low-signal sources:
deepdive "what's the difference between X and Y" \
  --deny-domain=pinterest.com,quora.com,reddit.com

# Pin to authoritative sources for a sensitive question:
deepdive "what does Anthropic's TOS say about Y" \
  --allow-domain=anthropic.com,docs.anthropic.com
```

Patterns match exactly OR as a strict subdomain (`github.com` matches `github.com` and `api.github.com`, but not `githubcompany.com`). Filtered URLs surface as `fetch.skipped` events with reason `domain-deny` or `domain-not-allowed` in `--verbose`. Both flags can be combined: a URL must pass the allow list AND not match the deny list. Env equivalents: `DEEPDIVE_ALLOW_DOMAIN`, `DEEPDIVE_DENY_DOMAIN`.

---

## Common flags

Run `deepdive --help` for the full list. The ones you'll reach for:

| Flag | Default | Why |
|---|---|---|
| `--deep[=<n>]` | off (bare = 2) | Turn on the critic loop. This is the headline feature. |
| `--model=<name>` | `claude-sonnet-4-6` | Try `claude-opus-4-7` on reasoning-heavy questions. |
| `--search=<adapter>` | `duckduckgo` | `searxng` for privacy, `brave` for quality, `tavily` or `exa` for research-tuned results. |
| `--max-sources=<n>` | `12` per round | Upper bound. Deep mode accumulates across rounds, capped each round. |
| `--concurrency=<n>` | `4` | Parallel fetches. Bump on a fast connection. |
| `--strict-cites` | off | Exit non-zero if any citation in the answer fails lexical verification. |
| `--cite-min-recall=<0..1>` | `0.4` | Citation-support threshold. Lower = more permissive. |
| `--no-verify-cites` | off | Skip the citation-verification pass entirely. |
| `--no-cost` | off | Suppress the end-of-run cost summary on stderr. |
| `--include=<paths>` | — | Comma-separated local files / dirs to ingest as sources (`.pdf`, `.md`, `.txt`, `.html`). |
| `--pdf-max-pages=<n>` | `50` | Per-PDF page cap. Larger PDFs are truncated. |
| `--allow-domain=<list>` | — | Comma-separated hostname suffixes — keep only matching URLs. |
| `--deny-domain=<list>` | — | Comma-separated hostname suffixes — drop matching URLs. |
| `--api-format=<anthropic\|openai>` | auto | Wire format for the LLM endpoint. Auto-detected from `--base-url`. |
| `--no-sessions` | off | Don't persist this run to `~/.deepdive/sessions/`. |
| `--json` | markdown | Emit `{question, plan, rounds, sources, answer, verification, cost, usage}` for piping. |
| `--out=<path>` | — | Save to file. |
| `--verbose`, `-v` | — | Stream plan / search / fetch / critique / verify events to stderr. |

Every flag mirrors a `DEEPDIVE_*` env var. CLI flags win over env.

---

## Search adapters

One adapter per backend. Default (DuckDuckGo) needs no key.

| Adapter | Flag | Needs | Notes |
|---|---|---|---|
| DuckDuckGo HTML | `--search=duckduckgo` (default) | nothing | Scrapes `html.duckduckgo.com`. Good enough for most questions. |
| SearXNG | `--search=searxng` | `DEEPDIVE_SEARXNG_URL` | Self-hosted metasearch. Best privacy. |
| Brave Search | `--search=brave` | `DEEPDIVE_BRAVE_KEY` | Paid, high quality. |
| Tavily | `--search=tavily` | `DEEPDIVE_TAVILY_KEY` | Research-tuned. Returns pre-extracted content; deepdive re-fetches anyway for consistency. |
| Exa | `--search=exa` | `DEEPDIVE_EXA_KEY` | Neural search tuned for long, intent-rich queries — a fit for the kind of sub-queries the planner and critic loop generate. Highlights only; deepdive re-fetches the page for full content. |

Adding a new adapter is ~30 lines: implement `SearchAdapter` in `src/search/*.ts`, register in `src/search.ts`.

---

## `deepdive doctor`

One command, aggregated health report. Paste the output when filing issues.

```bash
$ deepdive doctor
deepdive doctor — v0.3.0

# environment
  OK  Node        v22.21.1
  --- Platform    win32 x64
  --- deepdive    v0.3.0

# cache
  --- dir         ~/.deepdive/cache
  OK  writable    yes
  --- entries     42 files · 18.3 MB
  --- oldest      3h ago

# llm
  --- base URL    http://localhost:3456
  --- model       claude-sonnet-4-6
  OK  reachable   200 in 142ms
  OK  probe       max_tokens=1 · in=3 out=1

# search
  --- adapter     duckduckgo
  OK  probe       4 results in 380ms

# browser
  OK  playwright  module loaded
  OK  chromium    launch + close in 244ms

Summary: 13 checks · 8 ok · 0 warn · 0 fail
```

Exit code is 1 if anything's broken, 0 otherwise. `--json` for structured output.

---

## Caching

Every successful fetch goes to `~/.deepdive/cache/<sha256>.json` with a 1-hour TTL. A re-run of the same question — or a follow-up run that re-fetches overlapping URLs — never re-opens Chromium for sources it already has. Iteration during question refinement is free.

Disable with `--no-cache` or `DEEPDIVE_NO_CACHE=1`. Change the dir with `DEEPDIVE_CACHE_DIR`. Change the TTL with `--cache-ttl-ms` or `DEEPDIVE_CACHE_TTL_MS`.

---

## Sessions

Every successful run is saved to `~/.deepdive/sessions/<id>.json` — the full plan, round trace, kept sources (with their extracted content), the answer, the verification report, and the cost estimate. After each run deepdive prints the session id on stderr:

```
session  2026-05-07_134509_5959f102  (deepdive resume 2026-05-07_134509_5959f102)
```

Four subcommands operate on saved sessions:

```bash
deepdive sessions ls                          # newest first; id, age, source/round counts, question
deepdive show <id>                            # re-print the original markdown answer
deepdive resume <id> [<new-question>]         # re-synthesize against the saved sources (cheap)
deepdive continue <id> [<refined-question>]   # full run seeded with saved sources (adds new pages)
```

`resume` is the cheap iteration path: it re-runs the synthesizer (one LLM call) against the existing source corpus, optionally with a new question or refinement. No re-search, no re-fetch, no critic loop. This closes the iteration loop that the page cache opens — the cache stops re-fetching pages, but `resume` stops re-running the entire pipeline. Refining "what does X say about Y" into "what does X say about Y in the post-2024 era" costs one synthesis instead of an entire deep run.

`continue` (v0.12.0) is the deepening path: it runs the *full* agent loop — plan, search, fetch — with the parent session's sources seeded into the pool. URLs already in the parent are deduped against the new search results so you never re-fetch what you already paid for. The new run is saved as a fresh session with `parentId` set to the parent. Use this when the original got close and you want the planner to expand the corpus with a tighter question.

IDs are timestamp-prefixed (`YYYY-MM-DD_HHMMSS_<8-hex>`), so they sort chronologically and you can pass a unique prefix instead of typing the full id (`deepdive resume 2026-05-07_134509`).

Disable with `--no-sessions` or `DEEPDIVE_NO_SESSIONS=1`. Change the dir with `DEEPDIVE_SESSIONS_DIR`.

---

## Library mode

```ts
import {
  runAgent,
  resolveSearchAdapter,
  resolveConfig,
  createCache,
} from "@askalf/deepdive";

const config = resolveConfig({ deepRounds: 2 }, process.env);
const search = await resolveSearchAdapter(config.searchAdapter, process.env);
const cache = config.cache.enabled
  ? createCache({ dir: config.cache.dir, ttlMs: config.cache.ttlMs })
  : undefined;

const result = await runAgent("how does claude's rate limiter work", {
  llm: config.llm,
  search,
  browser: config.browser,
  resultsPerQuery: config.resultsPerQuery,
  maxSources: config.maxSources,
  maxWordsPerSource: config.maxWordsPerSource,
  deepRounds: config.deepRounds,
  concurrency: config.concurrency,
  cache,
  onEvent: (e) => console.error(e),
});

console.log(result.markdown);
console.log(`rounds: ${result.usage.rounds} · sources: ${result.usage.kept} · cache hits: ${result.usage.cacheHits}`);
```

All event types, the round-trace structure, and the browser-factory injection point are exported for programmatic use. See `src/index.ts`.

---

## Trust and transparency

| Signal | Status |
|---|---|
| **Runtime dependencies** | One — `playwright`. No hosted services, no telemetry. |
| **Credentials** | API keys live in env vars or CLI flags; deepdive never persists them. Cache files store fetched page content only, never auth. |
| **Network scope** | LLM endpoint (your choice), search backend (your choice), and the actual URLs your planner picked to read. No other outbound traffic. Verify with `lsof -i` during a run. |
| **Telemetry** | None. Zero analytics, tracking, or data collection. Deliberately, not aspirationally. |
| **License** | MIT |

See [DISCLAIMER.md](DISCLAIMER.md) for the full AS IS / no-affiliation / user-responsibility terms.

---

## Contributing

PRs welcome. Code style matches [dario](https://github.com/askalf/dario) — small TypeScript, pure decision functions, `node --test` assertions on anything with logic in it. Run `npm run build && npm test` before submitting.

---

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).

---

## Also by askalf

| Project | What it does |
|---------|-------------|
| [arnie](https://github.com/askalf/arnie) | Portable IT troubleshooting companion. Networking, AD, Windows Update, package managers, log triage, hardware checks. |
| [browser-bridge](https://github.com/askalf/browser-bridge) | Stealth headless Chromium in a container. CDP on 9222 — Playwright/Puppeteer/MCP-compatible. |
| [dario](https://github.com/askalf/dario) | Local LLM router. Use your Claude Max/Pro subscription as an API. |
| [git-providers](https://github.com/askalf/git-providers) | Unified GitHub + GitLab + Bitbucket Cloud REST clients behind one GitProvider interface. Plus a 44-entry api-key-provider taxonomy. |
| [hands](https://github.com/askalf/hands) | Cross-platform computer-use agent. Mouse, keyboard, screen. |
| [install-kit](https://github.com/askalf/install-kit) | curl-pipe-bash template for self-hosted Docker apps. |
| [pgflex](https://github.com/askalf/pgflex) | One Postgres API. Two modes (real PG ↔ PGlite WASM). |
| [redisflex](https://github.com/askalf/redisflex) | One Redis API. Two modes (ioredis ↔ in-process). |
