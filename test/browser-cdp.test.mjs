// Verifies the `cdpEndpoint` option routes BrowserSession.start() through
// connectOverCDP (attach to a remote browser) instead of chromium.launch().
//
// CI-safe: connecting to a port with nothing listening fails fast with a
// connection error — which proves the connect path was taken, without
// needing a real browser. A launch would never try to reach 127.0.0.1:1.
// The full connect→fetch→close happy path is exercised manually against
// the askalf-browser bridge (see the PR notes).

import test from "node:test";
import assert from "node:assert/strict";
import { BrowserSession } from "../dist/browser.js";

test("BrowserSession: cdpEndpoint takes the connect path, not launch (fails fast on unreachable endpoint)", async () => {
  const session = new BrowserSession({
    headless: true,
    timeoutMs: 4000,
    maxBytes: 1000,
    cdpEndpoint: "http://127.0.0.1:1", // nothing listening → connection refused
  });

  await assert.rejects(
    () => session.start(),
    (err) => {
      const msg = String(err?.message ?? err);
      return /connectOverCDP|ECONNREFUSED|connect|127\.0\.0\.1:1|CDP/i.test(msg);
    },
    "start() with cdpEndpoint should attempt a CDP connection and reject when unreachable",
  );

  await session.close().catch(() => {});
});
