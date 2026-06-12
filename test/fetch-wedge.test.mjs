import { test } from "node:test";
import assert from "node:assert/strict";
import { withHardDeadline, FetchWedgeError } from "../dist/browser.js";

// deepdive#87 — the hard deadline that turns a wedged fetch (a promise that
// never settles, e.g. page.evaluate on a blocked renderer) into one skipped
// source instead of an indefinitely hung run.

// The production deadline timer is unref'd ON PURPOSE (it must never hold
// the process open). In a bare test, that means nothing keeps the event
// loop alive while we wait for the deadline to fire — node drains the loop
// and node:test cancels the still-pending test ("Promise resolution is
// still pending but the event loop has already resolved"). A ref'd
// keep-alive timer held for the duration of the assertion fixes the test
// without weakening the production unref.
async function withKeepAlive(ms, fn) {
  const keepAlive = setTimeout(() => {}, ms);
  try {
    return await fn();
  } finally {
    clearTimeout(keepAlive);
  }
}

test("withHardDeadline: fast work resolves through", async () => {
  const v = await withHardDeadline(Promise.resolve(42), 1000, "https://x.test/");
  assert.equal(v, 42);
});

test("withHardDeadline: work rejection propagates as-is", async () => {
  await assert.rejects(
    withHardDeadline(Promise.reject(new Error("net::boom")), 1000, "https://x.test/"),
    /net::boom/,
  );
});

test("withHardDeadline: never-settling work hits FetchWedgeError", async () => {
  await withKeepAlive(2000, async () => {
    const wedge = new Promise(() => {}); // settles never — the #87 shape
    await assert.rejects(
      withHardDeadline(wedge, 30, "https://wedged.test/page"),
      (err) => {
        assert.ok(err instanceof FetchWedgeError);
        assert.equal(err.name, "FetchWedgeError");
        assert.match(err.message, /https:\/\/wedged\.test\/page/);
        assert.match(err.message, /30ms/);
        assert.match(err.message, /deepdive#87/);
        return true;
      },
    );
  });
});

test("withHardDeadline: slow-but-settling work beats a longer deadline", async () => {
  await withKeepAlive(2000, async () => {
    const slow = new Promise((r) => setTimeout(() => r("ok"), 20));
    const v = await withHardDeadline(slow, 5000, "https://x.test/");
    assert.equal(v, "ok");
  });
});

test("withHardDeadline: late rejection after deadline does not crash", async () => {
  await withKeepAlive(2000, async () => {
    let rejectLater;
    const work = new Promise((_, rej) => { rejectLater = rej; });
    await assert.rejects(
      withHardDeadline(work, 20, "https://x.test/"),
      FetchWedgeError,
    );
    // Work rejects AFTER the race settled — must not surface as an unhandled
    // rejection (the race's own subscription marks it handled).
    rejectLater(new Error("late renderer death"));
    await new Promise((r) => setTimeout(r, 30));
  });
});
