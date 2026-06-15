// Regression for #109: npm installs the `deepdive` bin as a symlink to
// dist/cli.js. The entry-point guard must still run main() under symlink
// invocation — comparing raw paths (argv[1] vs import.meta.url) made the
// installed command a silent no-op. We assert the symlinked invocation both
// exits 0 AND prints output (the no-op exited 0 with empty stdout).

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = resolve(fileURLToPath(import.meta.url), "..", "..", "dist", "cli.js");

test(
  "cli entry point: runs main() when invoked through a symlink (#109)",
  { skip: process.platform === "win32" ? "symlinks need privileges on Windows" : false },
  () => {
    const dir = mkdtempSync(join(tmpdir(), "dd-bin-"));
    const link = join(dir, "deepdive"); // mimic the npm bin symlink
    try {
      symlinkSync(CLI, link);
      const r = spawnSync(process.execPath, [link, "--version"], { encoding: "utf8" });
      assert.equal(r.status, 0, `exit 0 expected; stderr: ${r.stderr}`);
      assert.match(
        r.stdout.trim(),
        /^\d+\.\d+\.\d+/,
        `symlinked invocation must print a version (the #109 bug left this empty), got: ${JSON.stringify(r.stdout)}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
