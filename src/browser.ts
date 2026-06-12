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
  // Set when the response was a PDF; the agent routes through src/pdf.ts for
  // extraction. The cache base64-encodes `bytes` (see cache.ts) so a PDF
  // survives a warm-cache hit and the agent can re-extract on read — plain
  // JSON.stringify used to corrupt the Uint8Array and silently drop the source.
  // `mimeType` identifies the source type.
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

// #87 — the fetch-stage wedge. A run once hung 18+ minutes with every
// per-call timeout "passing": deepdive idle, chrome children idle, no
// progress. The per-call timeouts can't be airtight because the page work
// includes protocol calls that accept no timeout at all (page.evaluate —
// a renderer main thread blocked by a dialog, window.print(), or a
// never-settling document leaves it pending forever) and calls whose
// defaults a wedged renderer defeats. So fetch() races the ENTIRE page
// lifecycle against this hard deadline; on expiry the page is force-closed
// without awaiting it (a wedged page may never settle close() either) and
// the agent's existing failed-fetch path turns the wedge into one skipped
// source instead of a hung run.
export class FetchWedgeError extends Error {
  constructor(url: string, ms: number) {
    super(
      `fetch wedged: no result after ${ms}ms hard deadline — ${url}. ` +
        `Page force-closed; run continues without this source (deepdive#87).`,
    );
    this.name = "FetchWedgeError";
  }
}

// Exported for unit tests. Race `work` against a hard deadline. The timer is
// unref'd (never holds the process open) and cleared when work settles
// first. When the deadline wins, `work` keeps running detached — its later
// settlement is delivered to the already-settled race and cannot become an
// unhandled rejection.
export function withHardDeadline<T>(work: Promise<T>, ms: number, url: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new FetchWedgeError(url, ms)), ms);
    timer.unref?.();
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer)) as Promise<T>;
}

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
    // #87: bound every protocol call on this context (newPage, content,
    // title, …) by the fetch timeout instead of Playwright's 30s default.
    // Calls that accept no timeout (evaluate) are covered by the hard
    // deadline in fetch().
    this.context.setDefaultTimeout(this.opts.timeoutMs);
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
    // 2× the per-call timeout + grace: generous enough that the deadline
    // only fires when the per-call timeouts have ALREADY failed to fire —
    // i.e. a genuine wedge, not a slow page.
    const hardMs = this.opts.timeoutMs * 2 + 10_000;
    let result: FetchedPage | "pdf";
    let wedged = false;
    try {
      result = await withHardDeadline(this.extractViaPage(page, url), hardMs, url);
    } catch (err) {
      wedged = err instanceof FetchWedgeError;
      throw err;
    } finally {
      if (wedged) {
        // The page is unresponsive — close() may never settle. Fire and
        // forget; context.close() at run end sweeps whatever remains.
        void page.close().catch(() => undefined);
      } else {
        await page.close().catch(() => undefined);
      }
    }
    // PDF-by-content-type redirect happens after the page is closed, on the
    // request-API path with its own timeout.
    if (result === "pdf") return await this.fetchPdf(url);
    return result;
  }

  // The page-scoped portion of fetch(), raced against the #87 hard deadline.
  private async extractViaPage(page: Page, url: string): Promise<FetchedPage | "pdf"> {
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
      return "pdf";
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
