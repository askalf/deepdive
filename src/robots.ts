// robots.txt support — per-host fetch + parse + per-URL allow/deny check.
//
// Production-grade crawlers respect robots.txt. deepdive's fetch volume is
// low (~12 URLs per query) but it's still the polite thing; sites with
// explicit scraper deny rules shouldn't be surprised. --ignore-robots is
// provided for operators who know what they're doing.
//
// Cache is per-run (in-memory) and keyed by `<scheme>://<host>`. We don't
// persist to disk because the expected hit count per run is small and
// robots.txt content can change rapidly on the publisher's end.

export interface RobotsRule {
  allow: boolean;
  path: string;
}

export interface ParsedRobots {
  // Rules in file order. Path matching picks the longest-matching rule
  // (ties broken by Allow winning over Disallow per RFC 9309).
  rules: RobotsRule[];
  crawlDelaySec?: number;
}

export type RobotsCheckResult = "allow" | "deny" | "unknown";

export interface RobotsCache {
  get(origin: string): ParsedRobots | null | undefined;
  set(origin: string, parsed: ParsedRobots | null): void;
}

export interface CanFetchOptions {
  userAgent: string;
  cache?: RobotsCache;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export const DEFAULT_USER_AGENT = "deepdive-bot";

export function createRobotsCache(): RobotsCache {
  const store = new Map<string, ParsedRobots | null>();
  return {
    get: (origin) => store.get(origin),
    set: (origin, parsed) => void store.set(origin, parsed),
  };
}

export async function canFetch(
  url: string,
  opts: CanFetchOptions,
): Promise<RobotsCheckResult> {
  let origin: string;
  let path: string;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return "allow";
    origin = `${u.protocol}//${u.host}`;
    path = u.pathname + u.search;
  } catch {
    return "allow";
  }

  const cached = opts.cache?.get(origin);
  const parsed =
    cached === undefined
      ? await fetchAndParse(origin, opts)
      : cached;
  if (opts.cache && cached === undefined) opts.cache.set(origin, parsed);

  if (parsed === null) return "unknown"; // couldn't reach robots.txt
  return isPathAllowed(parsed, path, opts.userAgent) ? "allow" : "deny";
}

async function fetchAndParse(
  origin: string,
  opts: CanFetchOptions,
): Promise<ParsedRobots | null> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  try {
    const res = await fetchImpl(`${origin}/robots.txt`, {
      headers: { "user-agent": opts.userAgent },
      signal,
    });
    // Per RFC 9309: 4xx → no restrictions (no robots file); 5xx → treat as
    // "full disallow" conservatively. We lean permissive for 5xx too since
    // it's often transient and we don't want to lock out a run because the
    // publisher's server is flaky. Callers can pass --ignore-robots if they
    // want to bypass robots entirely.
    if (res.status >= 400) {
      return { rules: [] };
    }
    const text = await res.text();
    return parseRobotsTxt(text);
  } catch {
    return null;
  }
}

// Exported for unit tests.
export function parseRobotsTxt(text: string): ParsedRobots {
  const lines = text.split(/\r?\n/);
  // We track a current set of user-agents whose rules we're accumulating.
  // A rule applies to the most-specific matching user-agent (case-insensitive).
  // Simple strategy: collect all rules with their owning user-agents,
  // then at check time pick the right group.
  type GroupedRule = { agent: string; allow: boolean; path: string };
  const grouped: GroupedRule[] = [];
  let currentAgents: string[] = [];
  let sawRuleThisGroup = false;
  let crawlDelay: number | undefined;

  for (const rawLine of lines) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const match = /^([a-zA-Z-]+)\s*:\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, value] = match;
    const lower = key.toLowerCase();
    if (lower === "user-agent") {
      if (sawRuleThisGroup) {
        // new group
        currentAgents = [];
        sawRuleThisGroup = false;
      }
      currentAgents.push(value.trim().toLowerCase());
    } else if (lower === "disallow" || lower === "allow") {
      sawRuleThisGroup = true;
      for (const agent of currentAgents) {
        grouped.push({
          agent,
          allow: lower === "allow",
          path: value.trim(),
        });
      }
    } else if (lower === "crawl-delay") {
      const n = Number(value.trim());
      if (Number.isFinite(n) && n >= 0) crawlDelay = n;
    }
  }

  return {
    rules: grouped.map((g) => ({ allow: g.allow, path: g.path })),
    crawlDelaySec: crawlDelay,
    // We stash the grouping by keeping a hidden field. But since we want a
    // clean exported type, bake agent-matching in: we'll re-do the parse at
    // check time. Simpler: re-parse cheaply or store a bigger structure.
    // Actually let's just store the grouped form and compute at check time:
    ...({ _grouped: grouped } as object),
  } as ParsedRobots;
}

// Exported for unit tests.
export function isPathAllowed(
  parsed: ParsedRobots,
  path: string,
  userAgent: string,
): boolean {
  const grouped = (parsed as unknown as { _grouped?: { agent: string; allow: boolean; path: string }[] })._grouped ?? [];
  if (grouped.length === 0) return true;
  const ua = userAgent.toLowerCase();

  // Pick matching rules: prefer exact agent match; fall back to '*'.
  let applicable = grouped.filter((g) => g.agent && ua.includes(g.agent));
  if (applicable.length === 0) applicable = grouped.filter((g) => g.agent === "*");
  if (applicable.length === 0) return true;

  // Pick the longest-matching rule. Tie → allow wins (RFC 9309).
  let bestLen = -1;
  let bestAllow = true;
  for (const rule of applicable) {
    if (!rule.path) {
      // Empty Disallow: means allow everything. Empty Allow: is a no-op.
      if (!rule.allow) {
        if (bestLen < 0) {
          bestLen = 0;
          bestAllow = true; // empty Disallow explicitly grants
        }
      }
      continue;
    }
    if (!pathMatches(rule.path, path)) continue;
    if (rule.path.length > bestLen || (rule.path.length === bestLen && rule.allow)) {
      bestLen = rule.path.length;
      bestAllow = rule.allow;
    }
  }
  return bestLen < 0 ? true : bestAllow;
}

function pathMatches(pattern: string, path: string): boolean {
  // Robots.txt patterns support * as wildcard and $ as end-anchor. For the
  // simpler prefix patterns — which is what 95% of robots.txt files use — a
  // startsWith check suffices. Anything fancier: compile to a regex.
  if (!pattern.includes("*") && !pattern.endsWith("$")) {
    return path.startsWith(pattern);
  }
  // Convert to regex, escaping other regex-special chars.
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") re += ".*";
    else if (c === "$" && i === pattern.length - 1) re += "$";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp("^" + re).test(path);
  } catch {
    return false;
  }
}

function stripComment(s: string): string {
  const i = s.indexOf("#");
  return i === -1 ? s : s.slice(0, i);
}
