# deepdive bench — 2026-06-15

model: `claude-sonnet-4-6 (default)` · base-url: `http://localhost:3456 (default)` · search: `searxng` · deepdive v0.25.1

> Clean stock-master baseline on the SearXNG search layer — supersedes the DuckDuckGo-confounded `2026-06-12-v0.25.0-validation.md`. `factual-lookup`'s FAIL is the #104 fetch wedge (infra, intermittent), **not** a search/synth regression; treat the other 5 questions as the baseline.

| question | run completed | enough sources | citation support | answer length | topical keywords | under cost ceiling | verdict | time |
|---|---|---|---|---|---|---|---|---|
| factual-lookup | ❌ exit 1 | ❌ 0/4 | ❌ no citations | ❌ 0 words | ❌ missing: tier, requests, tokens | ✅ $0.000 / $2.00 | **FAIL** | 418s |
| technical-deep | ✅ exit 0 | ✅ 12/5 | ✅ 34/36 (0.94) | ✅ 1023 words | ✅ all present | ✅ $0.302 / $2.00 | **PASS** | 205s |
| academic | ✅ exit 0 | ✅ 11/5 | ✅ 14/15 (0.93) | ✅ 598 words | ✅ all present | ✅ $0.110 / $2.00 | **PASS** | 127s |
| comparison | ✅ exit 0 | ✅ 11/4 | ✅ 33/36 (0.92) | ✅ 999 words | ✅ all present | ✅ $0.133 / $2.00 | **PASS** | 98s |
| recent | ✅ exit 0 | ✅ 9/3 | ✅ 39/39 (1.00) | ✅ 1044 words | ✅ all present | ✅ $0.141 / $2.00 | **PASS** | 98s |
| niche-ops | ✅ exit 0 | ✅ 10/3 | ✅ 32/33 (0.97) | ✅ 708 words | ✅ all present | ✅ $0.115 / $2.00 | **PASS** | 100s |

**5/6 passed.** Structural gates only — read the answers before trusting a comparison.
