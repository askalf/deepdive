#!/bin/bash -eu
# Build the Jazzer.js fuzz targets for ClusterFuzzLite / OSS-Fuzz.
# Each target is an ESM module exporting `fuzz(data)`; the invariants are the
# fail-safe contracts at deepdive's trust boundaries — the robots.txt parser
# and its non-backtracking wildcard matcher never throw or hang on an
# attacker-controlled robots.txt, the content extractor always returns a
# well-formed result on hostile page text, and the LLM-output boundary
# (markdown→HTML escape, planner/critic JSON parsing) never throws anything
# but a plain Error and never emits unescaped HTML.
cd "$SRC/deepdive"
# Tests and fuzz targets never launch a browser — skip the 100MB Chromium pull.
export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
npm install --no-audit --no-fund
# Targets import the compiled ./dist output (the package is TypeScript).
npm run build

for target in robots extract markdown_plan; do
  compile_javascript_fuzzer deepdive "fuzz/${target}.fuzz.js" --sync
done
