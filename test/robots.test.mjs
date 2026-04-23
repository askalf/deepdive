import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {
  parseRobotsTxt,
  isPathAllowed,
  canFetch,
  createRobotsCache,
  DEFAULT_USER_AGENT,
} from "../dist/robots.js";

// ──────── parseRobotsTxt + isPathAllowed ───────────────────────────────────

test("parse: empty string → no rules → allow everything", () => {
  const p = parseRobotsTxt("");
  assert.equal(isPathAllowed(p, "/anything", "any-bot"), true);
});

test("parse: disallow all for *", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow: /
  `);
  assert.equal(isPathAllowed(p, "/", "random-bot"), false);
  assert.equal(isPathAllowed(p, "/anything", "random-bot"), false);
});

test("parse: disallow specific path prefix", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow: /private/
  `);
  assert.equal(isPathAllowed(p, "/private/secret", "bot"), false);
  assert.equal(isPathAllowed(p, "/public/page", "bot"), true);
});

test("parse: allow overrides disallow when path is longer", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow: /private/
    Allow: /private/public/
  `);
  assert.equal(isPathAllowed(p, "/private/secret", "bot"), false);
  assert.equal(isPathAllowed(p, "/private/public/page", "bot"), true);
});

test("parse: user-agent specific rule wins over *", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow: /

    User-agent: friend-bot
    Disallow:
  `);
  assert.equal(isPathAllowed(p, "/anything", "friend-bot"), true);
  assert.equal(isPathAllowed(p, "/anything", "other-bot"), false);
});

test("parse: user-agent matching is case-insensitive, substring-based", () => {
  const p = parseRobotsTxt(`
    User-agent: deepdive-bot
    Disallow: /nope
  `);
  assert.equal(isPathAllowed(p, "/nope", "DeepDive-Bot/1.0"), false);
  assert.equal(isPathAllowed(p, "/ok", "DeepDive-Bot/1.0"), true);
});

test("parse: comment lines ignored", () => {
  const p = parseRobotsTxt(`
    # this is a comment
    User-agent: * # inline comment
    Disallow: /private/ # another
  `);
  assert.equal(isPathAllowed(p, "/private/x", "b"), false);
});

test("parse: empty Disallow line grants access", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow:
  `);
  assert.equal(isPathAllowed(p, "/anything", "b"), true);
});

test("parse: wildcard * in Disallow path", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow: /*.pdf$
  `);
  assert.equal(isPathAllowed(p, "/docs/report.pdf", "b"), false);
  assert.equal(isPathAllowed(p, "/docs/report.html", "b"), true);
});

test("parse: crawl-delay captured", () => {
  const p = parseRobotsTxt(`
    User-agent: *
    Disallow:
    Crawl-delay: 10
  `);
  assert.equal(p.crawlDelaySec, 10);
});

test("parse: malformed lines silently skipped", () => {
  const p = parseRobotsTxt(`
    This is not a robots.txt line.
    Another bad line without a colon.
    User-agent: *
    Disallow: /nope
    !@#$%^
  `);
  assert.equal(isPathAllowed(p, "/nope", "b"), false);
  assert.equal(isPathAllowed(p, "/yes", "b"), true);
});

// ──────── canFetch: integration ────────────────────────────────────────────

function makeRobotsServer(responder) {
  return http.createServer(responder);
}

function start(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("canFetch: 200 with Disallow → deny", async () => {
  const server = makeRobotsServer((req, res) => {
    if (req.url === "/robots.txt") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /private/");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const origin = await start(server);
  try {
    const allow = await canFetch(`${origin}/public/page`, {
      userAgent: DEFAULT_USER_AGENT,
    });
    assert.equal(allow, "allow");
    const deny = await canFetch(`${origin}/private/page`, {
      userAgent: DEFAULT_USER_AGENT,
    });
    assert.equal(deny, "deny");
  } finally {
    await stop(server);
  }
});

test("canFetch: 404 robots.txt → allow (RFC: no robots = no restrictions)", async () => {
  const server = makeRobotsServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });
  const origin = await start(server);
  try {
    const allow = await canFetch(`${origin}/anything`, {
      userAgent: DEFAULT_USER_AGENT,
    });
    assert.equal(allow, "allow");
  } finally {
    await stop(server);
  }
});

test("canFetch: network error → unknown (caller decides policy)", async () => {
  // Point at a port nobody's listening on.
  const allow = await canFetch("http://127.0.0.1:1/page", {
    userAgent: DEFAULT_USER_AGENT,
    timeoutMs: 300,
  });
  assert.equal(allow, "unknown");
});

test("canFetch: cache prevents duplicate robots.txt fetches", async () => {
  let hits = 0;
  const server = makeRobotsServer((req, res) => {
    if (req.url === "/robots.txt") {
      hits++;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /nope");
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const origin = await start(server);
  const cache = createRobotsCache();
  try {
    await canFetch(`${origin}/a`, { userAgent: DEFAULT_USER_AGENT, cache });
    await canFetch(`${origin}/b`, { userAgent: DEFAULT_USER_AGENT, cache });
    await canFetch(`${origin}/nope`, { userAgent: DEFAULT_USER_AGENT, cache });
    assert.equal(hits, 1, "robots.txt should be fetched exactly once per origin");
  } finally {
    await stop(server);
  }
});

test("canFetch: non-http URL is allowed (we only care about http(s))", async () => {
  const allow = await canFetch("file:///etc/hosts", {
    userAgent: DEFAULT_USER_AGENT,
  });
  assert.equal(allow, "allow");
});

test("canFetch: malformed URL is allowed (caller will fail elsewhere)", async () => {
  const allow = await canFetch("not a url at all", {
    userAgent: DEFAULT_USER_AGENT,
  });
  assert.equal(allow, "allow");
});
