// Shell completion scripts.

import { test } from "node:test";
import assert from "node:assert/strict";
import { completionScript } from "../dist/completion.js";

test("bash: registers a complete function with subcommands + flags", () => {
  const s = completionScript("bash");
  assert.match(s, /complete -F _deepdive_completions deepdive/);
  assert.match(s, /doctor sessions show resume continue export diff completion/);
  assert.match(s, /--deep/);
  assert.match(s, /--profile/);
});

test("zsh: is a #compdef script registered with compdef", () => {
  const s = completionScript("zsh");
  assert.match(s, /^#compdef deepdive/);
  assert.match(s, /compdef _deepdive deepdive/);
  assert.match(s, /export:render a session as html or md/);
});

test("fish: per-subcommand + per-flag complete lines", () => {
  const s = completionScript("fish");
  assert.match(s, /complete -c deepdive -f/);
  assert.match(s, /-a 'diff'/);
  assert.match(s, /complete -c deepdive -l profile/);
  assert.match(s, /complete -c deepdive -l older-than/);
});
