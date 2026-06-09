import { test } from "node:test";
import assert from "node:assert/strict";
import { browserOpenCommand } from "../dist/open.js";

test("browserOpenCommand: macOS uses open", () => {
  assert.deepEqual(browserOpenCommand("darwin", "/tmp/r.html"), {
    cmd: "open",
    args: ["/tmp/r.html"],
  });
});

test("browserOpenCommand: Windows uses explorer directly (no shell)", () => {
  const c = browserOpenCommand("win32", "C:\\Temp\\r with space.html");
  assert.equal(c.cmd, "explorer.exe");
  // Single argv entry, no cmd.exe — the path can't be interpreted as a command.
  assert.deepEqual(c.args, ["C:\\Temp\\r with space.html"]);
});

test("browserOpenCommand: Linux/other uses xdg-open", () => {
  assert.deepEqual(browserOpenCommand("linux", "/tmp/r.html"), {
    cmd: "xdg-open",
    args: ["/tmp/r.html"],
  });
  assert.equal(browserOpenCommand("freebsd", "/x").cmd, "xdg-open");
});

test("browserOpenCommand: the target is always the final arg (single argv, no shell)", () => {
  for (const p of ["darwin", "win32", "linux"]) {
    const c = browserOpenCommand(p, "TARGET");
    assert.equal(c.args[c.args.length - 1], "TARGET");
  }
});
