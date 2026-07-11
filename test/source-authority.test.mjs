import test from "node:test";
import assert from "node:assert/strict";
import {
  scoreAuthority,
  summarizeSourceTrust,
  rankByAuthority,
  relevanceOverlap,
  registrableDomainOf,
  selectWithHostCap,
} from "../dist/source-authority.js";

const tierOf = (url) => scoreAuthority(url).tier;

test("scoreAuthority: government / education / military TLDs are primary", () => {
  assert.equal(tierOf("https://www.whitehouse.gov/briefing"), "primary");
  assert.equal(tierOf("https://web.mit.edu/page"), "primary");
  assert.equal(tierOf("https://www.army.mil/"), "primary");
  assert.equal(tierOf("https://www.ox.ac.uk/research"), "primary"); // second-level ccTLD
  assert.equal(tierOf("https://anu.edu.au/"), "primary");
});

test("scoreAuthority: curated primary/official domains (incl. subdomains) are primary", () => {
  assert.equal(tierOf("https://arxiv.org/abs/2401.00001"), "primary");
  assert.equal(tierOf("https://www.nature.com/articles/x"), "primary"); // www stripped
  assert.equal(tierOf("https://redis.io/docs/latest/"), "primary");
  assert.equal(tierOf("https://developer.mozilla.org/en-US/docs/Web"), "primary");
  assert.equal(tierOf("https://docs.aws.amazon.com/lambda/"), "primary"); // subdomain of aws.amazon.com
});

test("scoreAuthority: docs./developer. subdomains are treated as official docs", () => {
  assert.equal(tierOf("https://docs.djangoproject.com/en/5.0/"), "primary"); // not in list, prefix wins
  assert.equal(tierOf("https://developer.apple.com/documentation/"), "primary");
});

test("scoreAuthority: user-publishable docs. hosts are excluded from the prefix boost", () => {
  // docs.google.com is the Google Docs app, not Google's product docs: anyone
  // can publish a doc there, so the docs. prefix must NOT boost it to primary.
  // It falls through to neutral 'unknown' (not punished, just not trusted as a
  // primary source). Google's real docs live at developers.google.com /
  // cloud.google.com, which keep their boost.
  assert.equal(tierOf("https://docs.google.com/document/d/abc123/pub"), "unknown");
  assert.equal(tierOf("https://developers.google.com/maps/documentation"), "primary"); // real docs unaffected
  assert.equal(tierOf("https://cloud.google.com/docs"), "primary"); // curated primary, unaffected
});

test("scoreAuthority: well-known references are reputable", () => {
  assert.equal(tierOf("https://en.wikipedia.org/wiki/Foo"), "reputable"); // subdomain
  assert.equal(tierOf("https://stackoverflow.com/questions/1"), "reputable");
  assert.equal(tierOf("https://github.com/askalf/deepdive"), "reputable");
});

test("scoreAuthority: ops/infra official project docs are primary (no docs. prefix to save them)", () => {
  // v0.26.1 board: niche-ops kept 0 primary on both sides — these hosts are
  // the canonical documentation for their projects but carry no
  // docs./developer. prefix, so only the curated list can catch them (#130).
  assert.equal(tierOf("https://nginx.org/en/docs/http/ngx_http_proxy_module.html"), "primary");
  assert.equal(tierOf("https://httpd.apache.org/docs/2.4/"), "primary"); // subdomain of apache.org
  assert.equal(tierOf("https://www.kernel.org/doc/html/latest/"), "primary");
  assert.equal(tierOf("https://www.php.net/manual/en/"), "primary");
  assert.equal(tierOf("https://git-scm.com/docs/git-rebase"), "primary");
});

test("scoreAuthority: OpenSSH/OpenBSD project hosts are primary", () => {
  // Live-run receipt (#142): the official OpenSSH release notes — the source
  // 16/18 of the answer's citations grounded to — scored `unknown`, so the
  // run badged `mixed` and the release notes would lose a fetch slot to any
  // recognized domain. Same class as the #130 hosts: canonical project sites
  // with no docs./developer. prefix to save them.
  assert.equal(tierOf("https://www.openssh.org/releasenotes.html"), "primary");
  assert.equal(tierOf("https://www.openssh.com/security.html"), "primary");
  assert.equal(tierOf("https://www.openbsd.org/faq/"), "primary");
});

test("scoreAuthority: the Stack Exchange network's own domains are reputable", () => {
  // serverfault.com / superuser.com / askubuntu.com are SE-network flagships
  // on their own domains — NOT subdomains of stackexchange.com, so the
  // existing entry never covered them (#130).
  assert.equal(tierOf("https://serverfault.com/questions/587386/"), "reputable");
  assert.equal(tierOf("https://superuser.com/questions/1"), "reputable");
  assert.equal(tierOf("https://askubuntu.com/questions/1"), "reputable");
  assert.equal(tierOf("https://unix.stackexchange.com/questions/1"), "reputable"); // subdomain — already covered, pinned
});

test("scoreAuthority: seed content-farm denylist is low (and beats any boost)", () => {
  assert.equal(tierOf("https://aiflashreport.com/latest-llms"), "low");
  assert.equal(tierOf("https://gpt0x.com/models"), "low");
  assert.equal(tierOf("https://www.lmmarketcap.com/x"), "low");
});

test("scoreAuthority: unrecognized domains are neutral 'unknown', NOT punished", () => {
  // Conservative by design: a niche-but-legit blog must not be downranked just
  // for being unknown. SEO sources we don't recognize land here, not in `low`.
  assert.equal(tierOf("https://www.slingacademy.com/article"), "unknown");
  assert.equal(tierOf("https://some-personal-blog.dev/post"), "unknown");
});

test("scoreAuthority: no false positives from gov/edu look-alikes", () => {
  assert.equal(tierOf("https://education.com/courses"), "unknown");
  assert.equal(tierOf("https://mygov.com/"), "unknown");
  assert.equal(tierOf("https://governance.io/"), "unknown");
});

test("scoreAuthority: unparseable input is unknown, not a throw", () => {
  assert.equal(tierOf("not a url"), "unknown");
  assert.equal(tierOf(""), "unknown");
});

test("scoreAuthority: scores are monotonic with tier", () => {
  const s = (u) => scoreAuthority(u).score;
  const primary = s("https://arxiv.org/x");
  const reputable = s("https://en.wikipedia.org/x");
  const unknown = s("https://random-blog.net/x");
  const low = s("https://gpt0x.com/x");
  assert.ok(primary > reputable && reputable > unknown && unknown > low, `${primary} > ${reputable} > ${unknown} > ${low}`);
});

test("summarizeSourceTrust: high when no farms and >=half are primary/reputable", () => {
  const r = summarizeSourceTrust([
    "https://arxiv.org/a", // primary
    "https://redis.io/b", // primary
    "https://en.wikipedia.org/c", // reputable
    "https://some-blog.dev/d", // unknown
  ]);
  assert.equal(r.label, "high");
  assert.deepEqual(r.counts, { primary: 2, reputable: 1, unknown: 1, low: 0, total: 4 });
});

test("summarizeSourceTrust: low when >=half are known content farms", () => {
  const r = summarizeSourceTrust([
    "https://aiflashreport.com/a", // low
    "https://gpt0x.com/b", // low
    "https://lmmarketcap.com/c", // low
    "https://redis.io/d", // primary
  ]);
  assert.equal(r.label, "low");
  assert.equal(r.counts.low, 3);
});

test("summarizeSourceTrust: mixed when all sources are unrecognized (no farms, no anchors)", () => {
  const r = summarizeSourceTrust([
    "https://blog-one.dev/a",
    "https://blog-two.net/b",
    "https://blog-three.io/c",
  ]);
  assert.equal(r.label, "mixed");
  assert.deepEqual(r.counts, { primary: 0, reputable: 0, unknown: 3, low: 0, total: 3 });
});

test("summarizeSourceTrust: a single farm among trusted sources drops it to mixed, not high", () => {
  const r = summarizeSourceTrust([
    "https://arxiv.org/a", // primary
    "https://redis.io/b", // primary
    "https://aiflashreport.com/c", // low
  ]);
  assert.equal(r.label, "mixed");
  assert.equal(r.counts.low, 1);
});

const id = (u) => u;

test("rankByAuthority prefer: primary > reputable > unknown > low, stable within a tier", () => {
  const urls = [
    "https://aiflashreport.com/a", // low
    "https://example.com/b", // unknown
    "https://redis.io/docs", // primary (1st in input)
    "https://en.wikipedia.org/wiki/c", // reputable
    "https://anu.edu.au/d", // primary (2nd in input)
  ];
  assert.deepEqual(rankByAuthority(urls, id, "prefer"), [
    "https://redis.io/docs", // both primaries first, in input order (stable)
    "https://anu.edu.au/d",
    "https://en.wikipedia.org/wiki/c",
    "https://example.com/b",
    "https://aiflashreport.com/a",
  ]);
});

test("rankByAuthority prefer: never drops a candidate (reorder only)", () => {
  const urls = ["https://aiflashreport.com/x", "https://gpt0x.com/y", "https://example.com/z"];
  assert.equal(rankByAuthority(urls, id, "prefer").length, urls.length);
});

test("rankByAuthority strict: drops low-tier when better sources exist", () => {
  const urls = [
    "https://aiflashreport.com/farm", // low — dropped
    "https://example.com/ok", // unknown — kept
    "https://redis.io/docs", // primary — kept, first
  ];
  assert.deepEqual(rankByAuthority(urls, id, "strict"), [
    "https://redis.io/docs",
    "https://example.com/ok",
  ]);
});

test("rankByAuthority strict: keeps low-tier when nothing better (min-keep floor)", () => {
  // A niche/recency round that only surfaces farms must not be zeroed out.
  const urls = ["https://aiflashreport.com/a", "https://gpt0x.com/b"];
  assert.equal(rankByAuthority(urls, id, "strict").length, 2);
});

test("rankByAuthority off: preserves search order exactly", () => {
  const urls = ["https://aiflashreport.com/a", "https://redis.io/b", "https://example.com/c"];
  assert.deepEqual(rankByAuthority(urls, id, "off"), urls);
});

// ── #148: relevance tiebreak, registrable-domain cap ─────────────────────────

test("relevanceOverlap: distinct-term count on normalized tokens", () => {
  assert.equal(
    relevanceOverlap("BitNet: 1.58-bit Ternary LLMs at scale", ["BitNet", "ternary", "FP16"]),
    2,
  );
  // repetition doesn't inflate the count
  assert.equal(relevanceOverlap("ternary ternary ternary", ["ternary", "BitNet"]), 1);
  // punctuation-trimmed, case-insensitive, single-char terms ignored
  assert.equal(relevanceOverlap("(Ternary!) systems", ["ternary", "a"]), 1);
  assert.equal(relevanceOverlap("anything", []), 0);
});

test("rankByAuthority prefer: relevance breaks ties INSIDE a uniform tier", () => {
  // The #148 receipt shape: an all-primary arxiv pool where interleave order
  // put the off-topic paper first.
  const items = [
    { url: "https://arxiv.org/abs/1012.0392", text: "On ternary something from 2010" },
    { url: "https://arxiv.org/abs/2402.17764", text: "BitNet b1.58: ternary LLMs match FP16 accuracy" },
  ];
  const ranked = rankByAuthority(items, (i) => i.url, "prefer", {
    terms: ["BitNet", "ternary", "LLMs", "FP16", "accuracy"],
    textOf: (i) => i.text,
  });
  assert.equal(ranked[0].url, "https://arxiv.org/abs/2402.17764");
});

test("rankByAuthority prefer: relevance never promotes a lower tier over a higher one", () => {
  const items = [
    { url: "https://example.com/perfect-match", text: "BitNet ternary FP16 accuracy trade-offs" },
    { url: "https://arxiv.org/abs/1012.0392", text: "unrelated paper" },
  ];
  const ranked = rankByAuthority(items, (i) => i.url, "prefer", {
    terms: ["BitNet", "ternary", "FP16"],
    textOf: (i) => i.text,
  });
  // primary (arxiv) still outranks the unknown domain despite zero overlap
  assert.equal(ranked[0].url, "https://arxiv.org/abs/1012.0392");
});

test("rankByAuthority prefer: equal overlap keeps search order (stable)", () => {
  const items = [
    { url: "https://arxiv.org/abs/1", text: "ternary systems" },
    { url: "https://arxiv.org/abs/2", text: "ternary networks" },
  ];
  const ranked = rankByAuthority(items, (i) => i.url, "prefer", {
    terms: ["ternary"],
    textOf: (i) => i.text,
  });
  assert.deepEqual(ranked.map((i) => i.url), ["https://arxiv.org/abs/1", "https://arxiv.org/abs/2"]);
});

test("rankByAuthority off: stays a strict no-op even with relevance provided", () => {
  const items = [
    { url: "https://example.com/a", text: "no match" },
    { url: "https://arxiv.org/abs/2", text: "ternary" },
  ];
  const ranked = rankByAuthority(items, (i) => i.url, "off", {
    terms: ["ternary"],
    textOf: (i) => i.text,
  });
  assert.deepEqual(ranked, items);
});

test("registrableDomainOf: collapses subdomains, keeps ccTLD second levels", () => {
  assert.equal(registrableDomainOf("https://en.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(registrableDomainOf("https://de.wikipedia.org/wiki/X"), "wikipedia.org");
  assert.equal(registrableDomainOf("https://nginx.org/docs"), "nginx.org");
  assert.equal(registrableDomainOf("https://www.service.gov.uk/x"), "service.gov.uk");
  assert.equal(registrableDomainOf("https://research.ox.ac.uk/x"), "ox.ac.uk");
  assert.equal(registrableDomainOf("not a url"), "not a url");
});

test("selectWithHostCap: caps a dominating host at 2 when slots are contested", () => {
  // The 4×wikipedia receipt: four encyclopedic results outranking the
  // specific how-to content in a 5-slot round.
  const urls = [
    "https://en.wikipedia.org/wiki/A",
    "https://en.wikipedia.org/wiki/B",
    "https://de.wikipedia.org/wiki/C", // same registrable domain as A/B
    "https://en.wikipedia.org/wiki/D",
    "https://serverfault.com/q/1",
    "https://nginx.org/docs",
    "https://stackoverflow.com/q/2",
  ];
  const picked = selectWithHostCap(urls, (u) => u, 5);
  assert.deepEqual(picked, [
    "https://en.wikipedia.org/wiki/A",
    "https://en.wikipedia.org/wiki/B",
    "https://serverfault.com/q/1",
    "https://nginx.org/docs",
    "https://stackoverflow.com/q/2",
  ]);
});

test("selectWithHostCap: headroom lets capped-out items fill unfilled slots", () => {
  const urls = [
    "https://en.wikipedia.org/wiki/A",
    "https://en.wikipedia.org/wiki/B",
    "https://en.wikipedia.org/wiki/C",
    "https://nginx.org/docs",
  ];
  // 4 slots, only 4 candidates — honoring the cap would return 3 and waste a
  // slot; the best capped-out item takes it instead (in rank order).
  assert.deepEqual(selectWithHostCap(urls, (u) => u, 4), urls);
});

test("selectWithHostCap: respects slots and preserves ranking order", () => {
  const urls = [
    "https://a.com/1",
    "https://b.com/2",
    "https://c.com/3",
  ];
  assert.deepEqual(selectWithHostCap(urls, (u) => u, 2), ["https://a.com/1", "https://b.com/2"]);
  assert.deepEqual(selectWithHostCap(urls, (u) => u, 0), []);
});
