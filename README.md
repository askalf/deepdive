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

**Your data.** The question, the sub-queries the planner invents, every URL the agent chose to read — all of it goes to the vendor's servers. Often to their analytics pipeline. Sometimes to their ad-targeting pipeline. With deepdive, none of that exists. The planner runs in your Node process. The searches hit whichever backend you point at (DuckDuckGo by default, zero keys required; SearXNG, Brave, or Tavily if you'd rather). The only outbound connections from your machine are: your chosen LLM endpoint, your chosen search endpoint, and the specific URLs the planner decided to read. No telemetry, no analytics, no data retention. Inspectable: `lsof -i` during a run.

**Your model.** Hosted tools pick for you — Perplexity routes through their own blend, OpenAI uses GPT-5, Gemini uses 2.5 Pro. deepdive runs whatever model your endpoint exposes. Default is `claude-sonnet-4-6` for a good quality/cost balance; switch to `claude-opus-4-7` for reasoning-heavy questions; point `--base-url` at a LiteLLM or vLLM instance and run a local model. Same one-line flag either way.

**Your search backend.** Hosted tools use their own search index and won't tell you its exact shape. deepdive swaps between DuckDuckGo HTML (default, no key), self-hosted SearXNG, Brave Search API, or Tavily with one flag. Adding a new adapter is ~30 lines of TypeScript.

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

**Why this is the whole point.** The critic loop is the axis hosted tools cap on. Per-query unit economics force them to ship a fixed depth — if they let you run a 5-round loop, some users would and their margins would collapse. On your own subscription, the only cap is the one you set on the command line.

---

## Common flags

Run `deepdive --help` for the full list. The ones you'll reach for:

| Flag | Default | Why |
|---|---|---|
| `--deep[=<n>]` | off (bare = 2) | Turn on the critic loop. This is the headline feature. |
| `--model=<name>` | `claude-sonnet-4-6` | Try `claude-opus-4-7` on reasoning-heavy questions. |
| `--search=<adapter>` | `duckduckgo` | `searxng` for privacy, `brave` for quality, `tavily` for research-tuned results. |
| `--max-sources=<n>` | `12` per round | Upper bound. Deep mode accumulates across rounds, capped each round. |
| `--concurrency=<n>` | `4` | Parallel fetches. Bump on a fast connection. |
| `--json` | markdown | Emit `{question, plan, rounds, sources, answer, usage}` for piping. |
| `--out=<path>` | — | Save to file. |
| `--verbose`, `-v` | — | Stream plan / search / fetch / critique events to stderr. |

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

Adding a new adapter is ~30 lines: implement `SearchAdapter` in `src/search/*.ts`, register in `src/search.ts`.

---

## Caching

Every successful fetch goes to `~/.deepdive/cache/<sha256>.json` with a 1-hour TTL. A re-run of the same question — or a follow-up run that re-fetches overlapping URLs — never re-opens Chromium for sources it already has. Iteration during question refinement is free.

Disable with `--no-cache` or `DEEPDIVE_NO_CACHE=1`. Change the dir with `DEEPDIVE_CACHE_DIR`. Change the TTL with `--cache-ttl-ms` or `DEEPDIVE_CACHE_TTL_MS`.

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
