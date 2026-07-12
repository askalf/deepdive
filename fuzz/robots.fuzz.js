// Fuzz the robots.txt boundary — the one parser that runs over bytes an
// arbitrary web server controls before deepdive decides whether a fetch is
// permitted. Its fail-safe contract: parseRobotsTxt never throws and always
// returns a well-formed ParsedRobots, and isPathAllowed always returns a
// boolean without hanging. The hand-rolled two-pointer wildcard matcher in
// pathMatches exists precisely because compiling attacker-controlled `*`
// patterns to a regex is a ReDoS — a hang here is a crash to the fuzzer's
// timeout, so this target also guards that linearity claim.
import {
  parseRobotsTxt,
  isPathAllowed,
  DEFAULT_USER_AGENT,
} from "../dist/robots.js";

export function fuzz(data) {
  const s = data.toString("utf8");

  const parsed = parseRobotsTxt(s);
  if (!parsed || !Array.isArray(parsed.rules)) {
    throw new Error("parseRobotsTxt returned a malformed ParsedRobots");
  }
  if (
    parsed.crawlDelaySec !== undefined &&
    !(Number.isFinite(parsed.crawlDelaySec) && parsed.crawlDelaySec >= 0)
  ) {
    throw new Error(
      `parseRobotsTxt let a bad crawl-delay through: ${parsed.crawlDelaySec}`,
    );
  }

  // Check paths/agents derived from the same hostile bytes, so wildcard-heavy
  // rule patterns get matched against adversarial paths too.
  const cut = s.length >> 1;
  const path = "/" + s.slice(0, cut);
  const agents = [DEFAULT_USER_AGENT, "*", s.slice(cut) || "a"];
  for (const ua of agents) {
    const verdict = isPathAllowed(parsed, path, ua);
    if (typeof verdict !== "boolean") {
      throw new Error(`isPathAllowed returned non-boolean: ${typeof verdict}`);
    }
  }
}
