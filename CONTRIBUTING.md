# Contributing to deepdive

Thanks for your interest in improving **deepdive** — a local research agent that
turns one command into a cited answer with its trust signals: source-authority
mix, lexical citation verification, confidence, and cost. Ships as a CLI and an
MCP server, runs on your own LLM router, with zero hosted dependencies. Part of
[Own Your Stack](https://github.com/askalf).

## Ground rules

- Be respectful. This project follows our [Code of Conduct](CODE_OF_CONDUCT.md).
- Found a security issue? **Do not open a public issue** — follow
  [SECURITY.md](SECURITY.md) to report it privately.

## Development setup

deepdive is a Node.js (TypeScript) package. You need Node.js **20 or 22** (the
versions CI tests against).

```bash
git clone https://github.com/askalf/deepdive.git
cd deepdive
npm ci        # install from the frozen lockfile
npm test      # builds first, then runs the full test suite
```

The tests use a mock browser (`AgentConfig.browserFactory`) and never launch
Chromium, so you can skip Playwright's ~100 MB browser download while working:

```bash
PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm ci
```

Useful scripts: `npm run typecheck` (tsc `--noEmit`), `npm run build` (compile to
`dist/`), `npm run dev` (run the CLI from source via tsx).

## Making a change

1. Branch off `master`.
2. Keep the change focused — one concern per PR.
3. Add or update tests for any behavior change. deepdive's trust signals
   (citation verification, source-authority scoring, confidence, cost) are the
   product, so changes there must be covered by tests.
4. Run `npm run typecheck && npm test` locally before pushing.
5. Open a pull request against `master`.

## What CI requires

Every PR must pass these checks to merge:

- `build (20)` and `build (22)` — typecheck, build, test suite, and a
  `deepdive --help` smoke on Node **20** and **22**
- `analyze` — **CodeQL** static analysis (`javascript-typescript`)

OpenSSF Scorecard and actionlint also run on the repo; a new high-severity
finding or a workflow-lint error will block the change.

## Conventions

- GitHub Actions are **pinned to a commit SHA**, never a mutable tag. New or
  updated workflow steps must keep this.
- Commit messages: short imperative subject, with a wrapped body explaining the
  *why* when it isn't obvious.

## Releases

Releases are automated: bump `version` in `package.json` on `master` and
`auto-release.yml` creates the matching `vX.Y.Z` tag + GitHub release, then
dispatches `publish.yml`, which publishes `@askalf/deepdive` to npm via OIDC
trusted publishing (no tokens). A normal PR needs no release steps.
