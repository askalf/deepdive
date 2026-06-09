# Writing a search adapter

A search adapter is the only thing standing between deepdive and a new search
backend. Each one is a small class that turns a query string into a ranked list
of candidate URLs. Adding one is ~30 lines plus a test. This doc is the
contract every adapter must satisfy and a copy-paste scaffold to start from.

deepdive ships these: `duckduckgo` (default, no key), `searxng`, `brave`,
`tavily`, `exa`, `auto`, `wikipedia`, `arxiv`, `github`.

## The interface

From `src/search.ts`:

```ts
export interface SearchResult {
  url: string;     // absolute http(s) URL of the page to fetch
  title: string;   // display title ("" if unknown)
  snippet: string; // short context excerpt ("" if unknown)
  rank: number;    // 1-based position in this query's result list
}

export interface SearchAdapter {
  readonly name: string;
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]>;
}
```

## The contract

1. **Return absolute `http:`/`https:` URLs.** The agent fetches each `url`
   verbatim through the headless browser (or the PDF path). Relative URLs,
   `javascript:`, and tracking-redirect wrappers must be resolved/unwrapped
   before you return them.
2. **Honor `limit`.** Return at most `limit` results. Asking the backend for
   more and slicing is fine; returning 200 when asked for 5 is not.
3. **Rank from 1.** `rank` is 1-based and dense. The agent uses it for ordering
   only; the cross-query dedupe (`dedupeByUrl` in `src/search.ts`) happens
   upstream, so you don't need to dedupe across calls — but don't emit the same
   URL twice within one call.
4. **Throw on failure, don't return `[]` to hide an error.** A non-2xx response
   or malformed payload should `throw new Error("<name> <status> ...")`. Empty
   results for a genuinely empty backend response are fine; swallowing a 500 as
   `[]` is not — it hides outages and breaks the `auto` adapter's fallback
   logic, which keys on thrown errors.
5. **Respect the signal + apply a timeout.** Wrap the caller's `signal` with
   `searchTimeoutSignal(signal)` (from `src/search.ts`) so a hung endpoint can't
   block the whole run. It composes the caller's abort signal with a hard
   per-request timeout (`DEEPDIVE_SEARCH_TIMEOUT_MS`, default 15s).
6. **No new runtime dependencies.** Use `fetch` (global in Node 20+) and
   hand-rolled parsing. If the backend returns HTML/XML, parse it with a regex
   and a `// fix the parser if it breaks` comment — see `duckduckgo.ts` /
   `arxiv.ts`. Do not add `cheerio`, `xml2js`, etc.
7. **Keep the parsing pure and exported.** Put the response→`SearchResult[]`
   transform in an exported function (`mapXResults` / `parseXHtml`) that takes
   the already-parsed payload and returns the array. That function is what your
   test exercises — no network needed.
8. **Never log or persist credentials.** API keys arrive via the constructor
   (resolved from env in `resolveSearchAdapter`). They must not appear in any
   thrown error message, event, or returned field.

## Steps

1. **Create `src/search/<name>.ts`** implementing `SearchAdapter` (scaffold
   below). Keep the network call in `search()` and the transform in an exported
   pure function.
2. **Register it in `src/search.ts`** — add a `case "<name>":` to
   `resolveSearchAdapter`. Read any key from `env` there and throw a clear
   `"<name> adapter requires DEEPDIVE_<NAME>_KEY"` if it's required and missing.
   Keyless adapters just construct and return.
3. **Add a test `test/<name>-adapter.test.mjs`** importing from
   `../dist/<name>.js`: cover the pure mapper (mapping, ranking, limit, missing
   fields), the `resolveSearchAdapter` wiring (key required/optional), and a
   `globalThis.fetch`-stubbed `search()` call asserting the request shape +
   that non-2xx throws.
4. **Document it** — add a row to the README "Search adapters" table and list
   any `DEEPDIVE_*` env var in the CLI `--help` Environment block (`src/cli.ts`)
   and `--search` adapter list.
5. **Run `npm run build && npm test`** — `tsc --strict` must pass and your new
   tests must be green.

## Scaffold

```ts
// src/search/example.ts
// Example search adapter. <one line on the backend + whether it needs a key.>

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface ExampleItem {
  link?: string;
  name?: string;
  blurb?: string;
}

export class ExampleSearch implements SearchAdapter {
  readonly name = "example";
  // Drop the constructor arg if the backend needs no key.
  constructor(private readonly key?: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.example.com/search");
    url.searchParams.set("q", query);
    url.searchParams.set("count", String(Math.min(limit, 50)));
    const headers: Record<string, string> = {
      accept: "application/json",
      "user-agent": "deepdive (+https://github.com/askalf/deepdive)",
    };
    if (this.key) headers.authorization = `Bearer ${this.key}`;
    const res = await fetch(url, { headers, signal: searchTimeoutSignal(signal) });
    if (!res.ok) throw new Error(`example ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { items?: ExampleItem[] };
    return mapExampleResults(json.items ?? [], limit);
  }
}

// Pure, exported for unit tests — no I/O.
export function mapExampleResults(items: ExampleItem[], limit: number): SearchResult[] {
  return items
    .filter((r) => typeof r.link === "string" && r.link.length > 0)
    .slice(0, limit)
    .map((r, i) => ({
      url: r.link as string,
      title: r.name ?? "",
      snippet: (r.blurb ?? "").trim(),
      rank: i + 1,
    }));
}
```

```ts
// in src/search.ts → resolveSearchAdapter(name, env)
case "example": {
  const { ExampleSearch } = await import("./search/example.js");
  return new ExampleSearch(env.DEEPDIVE_EXAMPLE_KEY); // omit arg if keyless
}
```

That's the whole surface. PRs adding adapters are welcome — keep them small,
keyless-by-default where the backend allows it, and tested.
