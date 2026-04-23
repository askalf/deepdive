<p align="center">
  <h1 align="center">deepdive</h1>
  <p align="center"><strong>Open-source Perplexity for your own machine, running on your own Claude Max subscription.</strong><br>Ask it a question. It plans sub-queries, searches the web, reads the pages in a real browser, iterates with a critic loop until the answer stops having gaps, and hands you a cited markdown report. Every LLM call routes through <a href="https://github.com/askalf/dario">dario</a> (or any Anthropic-compat endpoint), so the 30-to-60 calls a single deep query burns bill against <em>your</em> subscription — not a hosted tool's margin on top of a hosted tool's margin.</p>
</p>

<p align="center"><em>Zero hosted dependencies. MIT. Independent, unofficial, third-party — see <a href="DISCLAIMER.md">DISCLAIMER.md</a>.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/@askalf/deepdive"><img src="https://img.shields.io/npm/v/@askalf/deepdive?color=blue" alt="npm version"></a>
  <a href="https://github.com/askalf/deepdive/actions/workflows/ci.yml"><img src="https://github.com/askalf/deepdive/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/askalf/deepdive/blob/master/LICENSE"><img src="https://img.shields.io/npm/l/@askalf/deepdive" alt="License"></a>
</p>

---

## The point

Hosted research tools (Perplexity, OpenAI Deep Research, Gemini Deep Research, etc.) solve a real problem: one question → plan → search → read → cited answer. They also:

- Send every query to their server.
- Charge a subscription fee on top of whatever LLM you're already paying for.
- Pick the model, the search backend, the fetch policy, the prompt, and the citation style for you.
- Cap research depth so it fits their unit economics — not your question.

deepdive does the same work, but the plan runs on your laptop, the LLM calls go through a router you control, the search adapter is yours to swap, and there is no cap on how deep the loop goes beyond the one you set on the command line. With `--deep`, a critic LLM reviews the draft answer, names the unanswered parts, and the loop runs again until the critic says it's complete. Paired with dario → Claude Max, every one of those iterations bills against the subscription you already pay for.

That's the product. The rest of this README is the operator's manual.

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

`--deep` turns on the critic loop (2 extra rounds by default). `--verbose` streams every plan / search / fetch / critique step to stderr so you can watch the agent think. `--out` writes the final cited markdown to a file in addition to stdout.

Pipe it, grep it, stick it in your research folder. It's plain markdown.

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

Citations are numbered and inline. The source table at the end records the exact URL and fetch timestamp for every source, so you can verify anything the model claimed.

---

## Why this exists

Three tools already do this and charge for it. deepdive exists because each one takes a decision away from you:

| | Perplexity | OpenAI Deep Research | Gemini Deep Research | **deepdive** |
|---|---|---|---|---|
| Who runs the agent loop | Their server | Their server | Their server | **Your machine** |
| Which model synthesizes | Their choice | GPT-5 | Gemini 2.5 Pro | **Any Anthropic-compat model** |
| Which search backend | Theirs | Theirs | Google | **DDG / SearXNG / Brave / Tavily — your pick** |
| Who sees your queries | Perplexity + upstream | OpenAI + upstream | Google + upstream | **Only the sites you searched** |
| How deep can it go | Capped | Capped | Capped | **You set the cap** |
| Billing path | Their subscription + their margin | GPT-5 tokens, metered | Gemini tokens, metered | **Your existing Claude Max, via dario** |
| Source code | Closed | Closed | Closed | **Open** |

Pair it with [dario](https://github.com/askalf/dario) and the deep-research workload — which is the single most token-hungry thing a consumer can do with an LLM, 50k to 200k tokens per question once the critic loop kicks in — lands on the subscription Anthropic built for exactly that profile. Per-token API pricing would put a single deep question at a few dollars. Through dario → Claude Max it's part of a flat monthly bill you're already paying.

That's why deepdive and dario are the same product in two pieces. dario is the routing layer that makes your subscription visible to any tool. deepdive is the first tool that uses the routing layer for a workload that nothing else in your toolchain runs.

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

**What this costs.** Each round is roughly `1 search_llm_call + N page_fetches + 1 synth_llm_call + 1 critic_llm_call`. A 3-round deep query against claude-sonnet-4-6 typically lands 40–80k tokens. On a Claude Max plan via dario: ~free. On per-token API pricing: several dollars. On Perplexity: limited by their internal cap regardless of what you're willing to spend.

---

## Common flags

Run `deepdive --help` for the full list. The ones you'll reach for:

| Flag | Default | Why |
|---|---|---|
| `--deep[=<n>]` | off (bare = 2) | Turn on the critic loop. This is the headline feature. |
| `--model=<name>` | `claude-sonnet-4-6` | Try `claude-opus-4-7` on questions that need real reasoning. |
| `--search=<adapter>` | `duckduckgo` | `searxng` for privacy, `brave` for quality, `tavily` for research-tuned results. |
| `--max-sources=<n>` | `12` per round | Upper bound. Deep mode adds sources across rounds, capped each round. |
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
| **Network scope** | LLM endpoint (your choice), search backend (your choice), and the actual URLs your planner picked to read. No other outbound traffic. |
| **Telemetry** | None. Zero analytics, tracking, or data collection. |
| **License** | MIT |

See [DISCLAIMER.md](DISCLAIMER.md) for the full AS IS / no-affiliation / user-responsibility terms.

---

## Contributing

PRs welcome. Code style matches [dario](https://github.com/askalf/dario) — small TypeScript, pure decision functions, `node --test` assertions on anything with logic in it. Run `npm run build && npm test` before submitting.

---

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).
