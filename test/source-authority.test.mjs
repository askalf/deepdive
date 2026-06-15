import test from "node:test";
import assert from "node:assert/strict";
import { scoreAuthority } from "../dist/source-authority.js";

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

test("scoreAuthority: well-known references are reputable", () => {
  assert.equal(tierOf("https://en.wikipedia.org/wiki/Foo"), "reputable"); // subdomain
  assert.equal(tierOf("https://stackoverflow.com/questions/1"), "reputable");
  assert.equal(tierOf("https://github.com/askalf/deepdive"), "reputable");
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
