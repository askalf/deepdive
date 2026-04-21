# Security Policy

## Supported Versions

Only the latest minor version on the `0.x` line is supported with security fixes during the pre-1.0 period. Once a `1.x` release is cut, this policy will be revised.

## Reporting a Vulnerability

If you discover a security vulnerability in deepdive, please report it responsibly:

1. **Do NOT open a public GitHub issue.**
2. Email **security@askalf.org** with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
3. **Response goal:** acknowledgment within 72 hours. This is a goal, not a contractual service-level agreement — see [DISCLAIMER.md](DISCLAIMER.md).
4. We will coordinate disclosure with you before publishing a fix.

## Scope

The following are in scope for security reports:

- Credential or API-key leakage via logs, errors, or network responses
- Arbitrary code execution via crafted search input, page content, or LLM output
- SSRF or open-redirect issues in the fetch path
- Path traversal via `--out` or any file-writing flag
- Prompt-injection paths where fetched page content can manipulate the synthesizer into executing actions outside the current run's scope
- Missing or incorrect sanitization of URLs, titles, or snippets that end up in the rendered markdown

Out of scope (non-issues):
- The model producing inaccurate, biased, or hallucinated content — see DISCLAIMER.md
- DuckDuckGo / SearXNG / Brave / Tavily terms of service compliance — the operator's responsibility
- Individual websites blocking the headless browser via anti-bot measures

## Security Architecture

- **No credentials on disk.** deepdive reads API keys from environment variables or CLI flags at runtime. It does not write credentials anywhere.
- **URL selection is LLM-driven.** The pages deepdive fetches are chosen by your LLM from search results the configured search adapter returned. Users with sensitive LLMs should consider constraining the network egress of the deepdive process.
- **Playwright launches a fresh browser context per run.** No persistent cookies, no user-data directory on disk, no shared state between runs.
- **Per-fetch timeout** (`--timeout-ms`, default 30s) and **max-bytes cap** (2 MB by default) bound each page fetch.
- **No telemetry.** Zero analytics, tracking, or data collection.
