// Thin Playwright wrapper. One browser per agent run, one context, one page
// re-used across fetches. Stealth-flavored Chrome args ported from the
// substrate browser container.

import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

export interface FetchedPage {
  url: string;
  finalUrl: string;
  status: number;
  title: string;
  text: string;
  html: string;
  fetchedAt: number;
}

export interface BrowserOptions {
  headless: boolean;
  timeoutMs: number;
  maxBytes: number;
  userAgent?: string;
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
    this.browser = await chromium.launch({
      headless: this.opts.headless,
      args: STEALTH_ARGS,
      ignoreDefaultArgs: ["--enable-automation"],
    });
    this.context = await this.browser.newContext({
      userAgent: this.opts.userAgent ?? DEFAULT_USER_AGENT,
      viewport: { width: 1920, height: 1080 },
      locale: "en-US",
      javaScriptEnabled: true,
    });
  }

  async fetch(url: string): Promise<FetchedPage> {
    if (!this.context) throw new Error("browser not started");
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
      };
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => undefined);
    await this.browser?.close().catch(() => undefined);
    this.context = null;
    this.browser = null;
  }
}
