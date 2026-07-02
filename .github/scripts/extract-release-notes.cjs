#!/usr/bin/env node
// Extract one version's section from CHANGELOG.md for the GitHub release body.
//
// Index-slicing on purpose, NOT a single lazy regex: the previous inline
// one-liner used `([\s\S]*?)(?=\n## \[|$)` with the `m` flag, and under `m`
// the `$` alternative matches at the end of EVERY line — so the lazy capture
// was allowed to stop at the first line boundary it reached (the blank line
// right under the heading) and captured the empty string. The regex still
// "matched", so the no-section fallback never fired either: every release
// body since the extractor shipped was silently empty (#135).

const fs = require("fs");

function extract(md, version) {
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const heading = new RegExp("^## \\[" + esc + "\\][^\\n]*\\n", "m");
  const m = heading.exec(md);
  if (!m) return "(no changelog section found for this version)";
  const rest = md.slice(m.index + m[0].length);
  const next = rest.search(/^## \[/m);
  return (next < 0 ? rest : rest.slice(0, next)).trim();
}

module.exports = { extract };

if (require.main === module) {
  const version = process.argv[2];
  if (!version) {
    console.error("usage: extract-release-notes.cjs <version> [changelog-path]");
    process.exit(2);
  }
  const md = fs.readFileSync(process.argv[3] ?? "CHANGELOG.md", "utf-8");
  process.stdout.write(extract(md, version));
}
