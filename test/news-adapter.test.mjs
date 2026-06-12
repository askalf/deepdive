import { test } from "node:test";
import assert from "node:assert/strict";
import { parseNewsRss, resolvePublisherUrl, NewsSearch } from "../dist/search/news.js";
import { resolveSearchAdapter } from "../dist/search.js";

// Shape mirrors a real Bing News RSS response: channel-level <link> noise
// outside the items, apiclick-wrapped publisher links with &amp; entities,
// RFC 1123 pubDates, HTML in descriptions.
const SAMPLE = `<?xml version="1.0" encoding="utf-8" ?><rss version="2.0"><channel>
<title>query - BingNews</title>
<link>https://www.bing.com/news/search?q=query&amp;format=rss</link>
<item>
  <title>Google open-sources speedy &quot;DiffusionGemma&quot; model</title>
  <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;aid=&amp;tid=abc&amp;url=https%3a%2f%2fexample-news.com%2f2026%2f06%2f10%2fdiffusiongemma%2f&amp;c=123&amp;mkt=en-us</link>
  <pubDate>Wed, 10 Jun 2026 17:46:00 GMT</pubDate>
  <description>Google &lt;b&gt;open-sourced&lt;/b&gt; a text diffusion model.</description>
</item>
<item>
  <title>Direct-link article</title>
  <link>https://publisher.example.org/story</link>
  <pubDate>not a date</pubDate>
  <description>No redirect wrapper on this one.</description>
</item>
<item>
  <title>Item with no usable link</title>
  <link>http://www.bing.com/news/apiclick.aspx?ref=FexRss&amp;tid=abc&amp;c=9</link>
  <pubDate>Thu, 11 Jun 2026 09:00:00 GMT</pubDate>
  <description>Dropped: apiclick without a url param.</description>
</item>
<item>
  <title>Third good item</title>
  <link>https://other.example.com/a</link>
  <pubDate>Fri, 12 Jun 2026 04:13:00 GMT</pubDate>
  <description>Plain.</description>
</item>
</channel></rss>`;

test("parseNewsRss: unwraps apiclick links to the publisher URL", () => {
  const out = parseNewsRss(SAMPLE, 10);
  assert.equal(out[0].url, "https://example-news.com/2026/06/10/diffusiongemma/");
});

test("parseNewsRss: decodes entities, strips description HTML, prefixes the date", () => {
  const out = parseNewsRss(SAMPLE, 10);
  assert.equal(out[0].title, 'Google open-sources speedy "DiffusionGemma" model');
  assert.equal(out[0].snippet, "2026-06-10 — Google open-sourced a text diffusion model.");
});

test("parseNewsRss: passes direct links through; unparseable pubDate drops the prefix", () => {
  const out = parseNewsRss(SAMPLE, 10);
  assert.equal(out[1].url, "https://publisher.example.org/story");
  assert.equal(out[1].snippet, "No redirect wrapper on this one.");
});

test("parseNewsRss: skips items without a usable link and keeps rank contiguous", () => {
  const out = parseNewsRss(SAMPLE, 10);
  assert.equal(out.length, 3); // the url-less apiclick item is dropped
  assert.deepEqual(
    out.map((r) => r.rank),
    [1, 2, 3],
  );
  assert.equal(out[2].title, "Third good item");
});

test("parseNewsRss: respects limit", () => {
  assert.equal(parseNewsRss(SAMPLE, 1).length, 1);
});

test("parseNewsRss: empty / garbage input parses to no results", () => {
  assert.deepEqual(parseNewsRss("", 5), []);
  assert.deepEqual(parseNewsRss("<html>not rss</html>", 5), []);
});

test("resolvePublisherUrl: rejects non-http(s) targets and malformed links", () => {
  assert.equal(resolvePublisherUrl("javascript:alert(1)"), null);
  assert.equal(resolvePublisherUrl("not a url"), null);
  assert.equal(
    resolvePublisherUrl(
      "http://www.bing.com/news/apiclick.aspx?url=" + encodeURIComponent("javascript:alert(1)"),
    ),
    null,
  );
});

test("resolveSearchAdapter: 'news' resolves keyless", async () => {
  const adapter = await resolveSearchAdapter("news", {});
  assert.ok(adapter instanceof NewsSearch);
  assert.equal(adapter.name, "news");
});
