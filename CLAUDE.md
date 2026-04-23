# deepdive — CLAUDE.md

This file is the project-local instructions for Claude Code and similar agents working in this repo.

## What deepdive is

A local research agent. CLI entry point `deepdive`. Given a question, it:
1. Asks an LLM to decompose the question into 3–5 sub-queries.
2. Runs each sub-query through a pluggable search adapter.
3. Fetches each result page through a Playwright-driven headless Chromium (parallelized, optionally cached to `~/.deepdive/cache/`).
4. Extracts main content, caps per-source word count.
5. Asks an LLM to synthesize a cited markdown answer.
6. (Optional, `--deep`) A critic LLM reviews the draft, names the gaps, and the loop re-runs until the critic says done or N rounds elapse.

Every LLM call goes to an Anthropic-compat endpoint. Default target is [dario](https://github.com/askalf/dario) at `http://localhost:3456`. Any Anthropic-compat URL works — Anthropic directly, a self-hosted LiteLLM, another proxy.

## Architecture principles

- **One runtime dependency.** `playwright` is required because we actually need to render JS-heavy pages. Nothing else. No `axios`, `node-fetch`, `readability`, `jsdom`, `chalk`, `yargs`, `zod`. Node built-ins and hand-rolled code.
- **Pure decision functions.** Anything with logic goes in a module that can be tested without a browser or an LLM: `parsePlan`, `parseCritique`, `parseArgs`, `resolveConfig`, `parsePositiveInt`, `parseNonNegativeInt`, `extractContent`, `dedupeByUrl`, `parseDuckDuckGoHTML`, `buildSourceTable`, `renderAnswerMarkdown`, `buildSourcePacket`, `cacheKey`, `runConcurrent`.
- **I/O at the edges.** `cli.ts`, `browser.ts`, `llm.ts`, and the individual search adapters touch the network or disk. Everything else is synchronous over strings and objects.
- **Events, not prints.** The agent emits structured events via `onEvent`; the CLI renders them. Do not `console.log` from inside `src/agent.ts` or any library module.
- **Hand-rolled regex parsers are fine** for DDG HTML. If the parser breaks, fix the parser. Do not reach for `cheerio`.
- **Fail loud, fail early.** Bad flags, bad JSON from the planner, zero-source outcomes — throw with a specific message rather than silently degrade.

## When making changes

1. Run `npm run build` — the TypeScript has to compile cleanly with `strict: true`.
2. Run `npm test` — all `node --test` suites must pass. Add a new test for any new pure function.
3. Do not add new runtime deps without a written reason in the PR description. Two-thirds of the product's value is that it's small enough to audit.
4. Do not add telemetry or analytics. Ever.
5. Do not log credentials anywhere. The LLM `apiKey` and any search-adapter keys must not appear in any event, log line, or error message.

## What to read first when you land here

- `src/agent.ts` — the whole pipeline in one file.
- `src/cli.ts` — the CLI entry point + how flags / events become the user-facing experience.
- `src/plan.ts` — the planner's system prompt is the single highest-leverage tuning knob in the project.
- `src/synthesize.ts` — the synthesizer's system prompt is the second.

## What not to do

- Don't add a web UI. The product is a CLI; a UI is a separate product.
- Don't promote the research loop to the default path — `--deep` is opt-in for a reason (cost / latency predictability).
- Don't reach for LangChain / LlamaIndex / anything that turns 300 lines into 3,000 and adds 40 deps.
- Don't bundle SearXNG. Ship it as an adapter that points at a URL the user provides.

## User / session context

The user runs Claude Code on Windows 11. The author also ships [dario](https://github.com/askalf/dario). deepdive is the second product in the askalf portfolio; it's positioned as the flagship consumer of dario.
