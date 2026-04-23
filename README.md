<p align="center">
  <h1 align="center">deepdive</h1>
  <p align="center"><strong>A local research agent. One command, cited answer.</strong><br>Decomposes your question into sub-queries, runs web searches, fetches pages through a real headless browser, and hands everything to an LLM that writes a cited markdown report. Every LLM call goes through your own router — default target is <a href="https://github.com/askalf/dario">dario</a> at <code>localhost:3456</code>, so synthesis runs on your Claude Max subscription, your own OpenAI key, or any local model. Any Anthropic-compat endpoint works.</p>
</p>

<p align="center"><em>Zero hosted dependencies. MIT. Independent, unofficial, third-party — see <a href="DISCLAIMER.md">DISCLAIMER.md</a>.</em></p>

---

## 60 seconds

```bash
# 1. Have dario running (or any Anthropic-compat endpoint at a local URL).
#    See: https://github.com/askalf/dario
dario proxy   # http://localhost:3456, routes to Claude Max, OpenAI, etc.

# 2. Install deepdive.
npm install -g @askalf/deepdive
npx playwright install chromium   # first run only, ~300 MB

# 3. Ask.
deepdive "how does claude's rate limiter work"
```

Output is cited markdown printed to stdout. Pipe it, save it with `--out=report.md`, or stream progress with `--verbose`:

```bash
deepdive "how does claude's rate limiter work" --verbose --out=rate-limiter.md
```

Under the hood:
1. **Plan.** LLM decomposes your question into 3–5 searchable sub-queries.
2. **Search.** DuckDuckGo HTML by default (no API key). Pluggable: `--search=searxng|brave|tavily` with your own endpoint or key.
3. **Fetch.** Playwright-driven Chromium renders each result page (JS-rendered SPAs included). Parallelized via `--concurrency`, cached to `~/.deepdive/cache/` (1h TTL by default) so re-running is free.
4. **Extract.** Boilerplate stripped, main content capped to a word budget.
5. **Synthesize.** LLM writes the answer with inline `[N]` citations referencing the source list.
6. **Critique (optional, `--deep`).** LLM reviews its own draft, names the gaps, proposes follow-up queries, loop re-runs until the critic says done or `--deep=N` rounds elapse.

---

## Why this exists

Every hosted research tool (Perplexity, OpenAI Deep Research, Gemini Deep Research) sends your queries to someone else's server, charges per query, and gives you no say in which model synthesizes the answer or which sources get read. deepdive is the self-hosted alternative: your machine, your LLM subscription, your model choice, your search backend.

Pair it with [dario](https://github.com/askalf/dario) and every research query routes through your Claude Max subscription instead of per-token API pricing — a single deep query can be 50k–200k tokens, which is exactly the workload subscription billing was built for.

---

## LLM routing (default: dario)

deepdive speaks the Anthropic Messages API. The default target is `http://localhost:3456` (dario's default port), with `x-api-key: dario`:

```bash
deepdive "…" --base-url=http://localhost:3456 --api-key=dario --model=claude-sonnet-4-6
```

Any Anthropic-compat endpoint works. If you already have Claude Code credentials and dario installed, there is nothing else to configure.

---

## Search adapters

| Adapter | Flag | Needs | Notes |
|---|---|---|---|
| DuckDuckGo HTML | `--search=duckduckgo` (default) | nothing | Scrapes `html.duckduckgo.com`. No key, no account. Quality is fine for v1; if DDG changes their HTML, the parser may need an update. |
| SearXNG | `--search=searxng` | `DEEPDIVE_SEARXNG_URL` | Self-hosted metasearch. Best quality/privacy combo. |
| Brave Search | `--search=brave` | `DEEPDIVE_BRAVE_KEY` | Brave Search API. Paid, but high quality. |
| Tavily | `--search=tavily` | `DEEPDIVE_TAVILY_KEY` | Research-tuned API. Returns pre-extracted content, which deepdive re-fetches for consistency. |

Adding a new adapter is ~30 lines — implement `SearchAdapter` in `src/search/*.ts` and register in `src/search.ts`.

---

## Flags

Run `deepdive --help` for the full list. The ones you'll actually use:

| Flag | Default | Description |
|---|---|---|
| `--base-url=<url>` | `http://localhost:3456` | LLM endpoint (dario / Anthropic / any compat URL) |
| `--api-key=<key>` | `dario` | LLM key |
| `--model=<name>` | `claude-sonnet-4-6` | Model for both planning and synthesis |
| `--search=<adapter>` | `duckduckgo` | Search backend (see table above) |
| `--max-sources=<n>` | `12` | Total pages fetched per query |
| `--results-per-query=<n>` | `5` | Candidates pulled per sub-query |
| `--max-words-per-source=<n>` | `2000` | Per-source content cap before synthesis |
| `--timeout-ms=<ms>` | `30000` | Per-fetch timeout |
| `--deep[=<n>]` | off (bare `--deep` = 2) | Critic-driven iterative research: after the initial answer, LLM names gaps and proposes follow-up queries for up to N more rounds |
| `--concurrency=<n>` | `4` | Parallel page fetches |
| `--no-cache` | — | Skip the on-disk page cache (default: enabled, 1h TTL) |
| `--cache-ttl-ms=<ms>` | `3600000` | Cache TTL in ms |
| `--json` | — | Emit structured JSON (question, plan, rounds, sources, answer, usage) instead of markdown |
| `--out=<path>` | — | Also write output (markdown or JSON) to file |
| `--verbose`, `-v` | — | Stream progress events to stderr |

All flags mirror to `DEEPDIVE_*` env vars (e.g. `DEEPDIVE_MODEL`, `DEEPDIVE_MAX_SOURCES`, `DEEPDIVE_DEEP_ROUNDS`, `DEEPDIVE_CONCURRENCY`). CLI flags win over env vars.

### Example: deep iterative research

```bash
deepdive "compare bun's TLS ClientHello to node's" --deep=3 --verbose --out=tls.md
```

With `--deep=3`, after the first synthesis the critic can run up to three more rounds of "look at the draft, find what's missing, search for it, re-synthesize." Each round can add up to `--max-sources` new pages, so plan the cap. The loop stops early as soon as the critic says the draft is complete.

### Example: JSON output for piping into other tools

```bash
deepdive "latest CVE in openssl" --json | jq '.sources[] | .url'
```

---

## Library mode

```ts
import {
  runAgent,
  resolveSearchAdapter,
  resolveConfig,
  createCache,
} from "@askalf/deepdive";

const config = resolveConfig({}, process.env);
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
  deepRounds: 2,        // iterate up to 2 extra critic-driven rounds
  concurrency: 4,       // parallel page fetches
  cache,
  onEvent: (e) => console.error(e),
});

console.log(result.markdown);
console.log("rounds:", result.usage.rounds, "sources:", result.usage.kept);
```

---

## Trust and transparency

| Signal | Status |
|---|---|
| **Source** | One TypeScript package, small enough to audit in an evening |
| **Runtime dependencies** | One — `playwright`. No hosted services, no telemetry. |
| **Credentials** | API keys live in env vars or CLI flags; deepdive never persists them |
| **Network scope** | LLM endpoint (your choice), search backend (your choice), and the actual URLs your LLM picked to read |
| **Telemetry** | None. Zero analytics, tracking, or data collection. |
| **License** | MIT |

See [DISCLAIMER.md](DISCLAIMER.md) for the full AS IS / no-affiliation / user-responsibility terms.

---

## Contributing

PRs welcome. Code style matches [dario](https://github.com/askalf/dario) — small TypeScript, pure decision functions, `node --test` assertions on anything with logic in it. Run `npm run build && npm test` before submitting.

---

## License

MIT — see [LICENSE](LICENSE) and [DISCLAIMER.md](DISCLAIMER.md).
