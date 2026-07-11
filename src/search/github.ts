// GitHub repository search adapter. Works without a key (60 search
// requests/hour unauthenticated); set DEEPDIVE_GITHUB_TOKEN for the
// authenticated rate limit (30 req/min). A fit for "what library / project
// does X" sub-queries — the kept source is the repo's GitHub page, whose
// rendered README deepdive's fetch step then extracts.

import { searchTimeoutSignal, type SearchAdapter, type SearchResult } from "../search.js";

interface GitHubRepoItem {
  html_url?: string;
  full_name?: string;
  description?: string | null;
  stargazers_count?: number;
}

export class GitHubSearch implements SearchAdapter {
  readonly name = "github";
  // Repository search returns github.com html_url pages only — #147.
  readonly servesDomains = ["github.com"];
  constructor(private readonly token?: string) {}

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const url = new URL("https://api.github.com/search/repositories");
    url.searchParams.set("q", query);
    url.searchParams.set("per_page", String(Math.min(Math.max(limit, 1), 100)));
    url.searchParams.set("sort", "best-match");
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      // GitHub rejects requests with no User-Agent.
      "user-agent": "deepdive (+https://github.com/askalf/deepdive)",
    };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(url, { headers, signal: searchTimeoutSignal(signal) });
    if (!res.ok) throw new Error(`github ${res.status} ${res.statusText}`);
    const json = (await res.json()) as { items?: GitHubRepoItem[] };
    return mapGitHubRepos(json.items ?? [], limit);
  }
}

// Exported for unit tests. Pure mapper. Snippet is the repo description with a
// star count appended when known, so the planner/critic can weigh popularity.
export function mapGitHubRepos(items: GitHubRepoItem[], limit: number): SearchResult[] {
  return items
    .filter((r) => typeof r.html_url === "string" && r.html_url.length > 0)
    .slice(0, limit)
    .map((r, i) => ({
      url: r.html_url as string,
      title: r.full_name ?? r.html_url ?? "",
      snippet: buildSnippet(r),
      rank: i + 1,
    }));
}

function buildSnippet(r: GitHubRepoItem): string {
  const desc = (r.description ?? "").trim();
  if (typeof r.stargazers_count === "number" && r.stargazers_count > 0) {
    const stars = `★ ${formatStars(r.stargazers_count)}`;
    return desc ? `${desc} (${stars})` : stars;
  }
  return desc;
}

function formatStars(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}
