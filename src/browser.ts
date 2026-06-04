// Thin Playwright wrapper. One browser per agent run, one context, one page
// re-used across fetches. Stealth-flavored Chrome args ported from the
// substrate browser container.
//
// PDFs short-circuit Playwright entirely: Chromium's PDF viewer doesn't
// expose useful text content via the DOM, and `page.goto()` on a PDF can
// get stuck on `networkidle` waits. Instead we issue a plain HTTP GET via
// the request context, capture the bytes, and let src/pdf.ts handle
// extraction downstream.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { looksLikePdf } from "./pdf.js";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  html: string;
  fetchedAt: number;
  // Set when the response was a PDF; the agent then routes through
  // src/pdf.ts for extraction. `bytes` is omitted from the cache file
  // (cache stores `text`, the extracted prose) — `mimeType` is enough
  // for the agent to know the source type on cache hits.
  mimeType?: string;
  bytes?: Uint8Array;
}

export interface BrowserOptions {
  headless: boolean;
  timeoutMs: number;
  maxBytes: number;
  userAgent?: string;
  // When set, attach to an existing CDP browser at this endpoint
  // (e.g. `http://host:9222`) instead of launching a local Chromium —
  // no Playwright browser download required. `headless` and the stealth
  // launch args are ignored in this mode (the remote browser owns them).
  cdpEndpoint?: string;
}

export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const STEALTH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--disable-features=IsolateOrigins,site-per-process",
  "--enable-features=NetworkService,NetworkServiceInProcess",
  "--window-size=1920,1080",
  "--lang=en-US,en",
  "--font-render-hinting=medium",
  "--disable-dev-shm-usage",
];

export class BrowserSession {
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;

  constructor(private readonly opts: BrowserOptions) {}

  async start(): Promise<void> {
    if (this.opts.cdpEndpoint) {
      // Attach to an existing CDP browser (e.g. the askalf-browser bridge)
      // rather than launching one. Launch args don't apply — the remote
      // browser owns its own flags + stealth. Bounded by the fetch timeout
      // so an unreachable endpoint fails fast instead of hanging.
      this.browser = await chromium.connectOverCDP(this.opts.cdpEndpoint, {
        timeout: this.opts.timeoutMs,
      });
    } else {
      this.browser = await chromium.launch({
        headless: this.opts.headless,
        args: STEALTH_ARGS,
        ignoreDefaultArgs: ["--enable-automation"],
      });
    }
    // A fresh context isolates this run's pages on the (possibly shared)
    // browser. Context-level options (UA, viewport, locale) apply in both
    // launch and connect modes.
    this.context = await this.browser.newContext({
      userAgent: this.opts.userAgent ?? DEFAULT_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      javaScriptEnabled: true,
    });
  }

  async fetch(url: string): Promise<FetchedPage> {
    if (!this.context) throw new Error("browser not started");

    // PDFs: skip the page goto entirely. Use the context's request API
    // for a plain GET so we get the raw bytes (Chromium's PDF viewer
    // doesn't surface text through the DOM).
    if (looksLikePdf({ url })) {
      return await this.fetchPdf(url);
    }

    const page: Page = await this.context.newPage();
    try {
      const response = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: this.opts.timeoutMs,
      });
      // Give SPAs a moment to finish painting after domcontentloaded.
      await page
        .waitForLoadState("networkidle", { timeout: Math.min(5000, this.opts.timeoutMs) })
        .catch(() => undefined);

      // If the response advertised a PDF content-type even though the
      // URL didn't end in .pdf, redirect to the bytes path.
      const headers = response?.headers() ?? {};
      const ct = headers["content-type"] ?? "";
      if (looksLikePdf({ contentType: ct })) {
        await page.close().catch(() => undefined);
        return await this.fetchPdf(url);
      }

      const finalUrl = page.url();
      const status = response?.status() ?? 0;
      const title = await page.title().catch(() => "");
      const html = (await page.content()).slice(0, this.opts.maxBytes);
      const text = (await page.evaluate(() => document.body?.innerText ?? "")).slice(
        0,
        this.opts.maxBytes,
      );
      return {
        url,
        finalUrl,
        status,
        title,
        text,
        html,
        fetchedAt: Date.now(),
        mimeType: extractMimeType(ct),
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async fetchPdf(url: string): Promise<FetchedPage> {
    if (!this.context) throw new Error("browser not started");
    const response = await this.context.request.get(url, {
      timeout: this.opts.timeoutMs,
      maxRedirects: 5,
    });
    const status = response.status();
    const buf = await response.body();
    const bytes = new Uint8Array(
      buf.buffer,
      buf.byteOffset,
      Math.min(buf.byteLength, this.opts.maxBytes * 4),
    );
    const headers = response.headers();
    const ct = headers["content-type"] ?? "application/pdf";
    return {
      url,
      finalUrl: response.url(),
      status,
      title: "",
      text: "", // populated by the PDF extractor downstream
      html: "",
      fetchedAt: Date.now(),
      mimeType: extractMimeType(ct) ?? "application/pdf",
      bytes,
    };
  }

  async close(): Promise<void> {
    // Close the context we created. For a connectOverCDP session,
    // browser.close() disconnects the CDP connection without terminating
    // the remote browser (we didn't launch it) — so a shared bridge keeps
    // running; for a launched browser it shuts the process down.
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}

// Exported for unit tests. Pulls the bare media type out of a content-type
// header value (e.g. "text/html; charset=utf-8" → "text/html").
export function extractMimeType(headerValue: string | undefined): string | undefined {
  if (!headerValue) return undefined;
  const semi = headerValue.indexOf(";");
  return (semi === -1 ? headerValue : headerValue.slice(0, semi)).trim().toLowerCase();
}
