// Shell completion scripts. `deepdive completion <bash|zsh|fish>` prints a
// script the user evals/sources to get subcommand + flag completion. Pure: the
// scripts are generated from the lists below, no I/O.

export type Shell = "bash" | "zsh" | "fish";

const SUBCOMMANDS: [string, string][] = [
  ["doctor", "health check"],
  ["sessions", "list / rm / prune saved sessions"],
  ["show", "print a saved session's answer"],
  ["resume", "re-synthesize a saved session (cheap)"],
  ["continue", "extend a session with new pages"],
  ["export", "render a session as html or md"],
  ["diff", "compare two saved sessions"],
  ["completion", "print a shell completion script"],
];

const FLAGS: [string, string][] = [
  ["--deep", "critic loop (N rounds)"],
  ["--tldr", "lead the answer with a TL;DR"],
  ["--model", "LLM model"],
  ["--plan-model", "model for the planner stage"],
  ["--synth-model", "model for the synthesizer stage"],
  ["--critic-model", "model for the critic stage"],
  ["--search", "search adapter"],
  ["--profile", "named settings preset"],
  ["--max-cost", "budget cap in USD"],
  ["--max-sources", "total sources to fetch"],
  ["--concurrency", "parallel fetches"],
  ["--include", "local files/dirs as sources"],
  ["--allow-domain", "keep only these hosts"],
  ["--deny-domain", "drop these hosts"],
  ["--strict-cites", "fail on weakly-cited claims"],
  ["--narrate", "diff: add an LLM change summary"],
  ["--format", "export: html | md"],
  ["--older-than", "prune: age cutoff (e.g. 30d)"],
  ["--keep", "prune: retain the newest N"],
  ["--dry-run", "prune: preview, delete nothing"],
  ["--out", "write output to a file"],
  ["--json", "emit JSON"],
  ["--verbose", "stream progress to stderr"],
  ["--help", "show help"],
];

export function completionScript(shell: Shell): string {
  switch (shell) {
    case "bash":
      return bash();
    case "zsh":
      return zsh();
    case "fish":
      return fish();
  }
}

function bash(): string {
  const subs = SUBCOMMANDS.map(([s]) => s).join(" ");
  const flags = FLAGS.map(([f]) => f).join(" ");
  return `# deepdive bash completion. Add to ~/.bashrc:
#   source <(deepdive completion bash)
_deepdive_completions() {
  local cur="\${COMP_WORDS[COMP_CWORD]}"
  local subcommands="${subs}"
  local flags="${flags}"
  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "\${flags}" -- "\${cur}") )
  else
    COMPREPLY=( $(compgen -W "\${subcommands}" -- "\${cur}") )
  fi
}
complete -F _deepdive_completions deepdive
`;
}

function zsh(): string {
  const subs = SUBCOMMANDS.map(([s, d]) => `'${s}:${d}'`).join(" ");
  const flags = FLAGS.map(([f, d]) => `'${f}:${d}'`).join(" ");
  return `#compdef deepdive
# deepdive zsh completion. Add to ~/.zshrc:
#   source <(deepdive completion zsh)
_deepdive() {
  local -a subcommands flags
  subcommands=(${subs})
  flags=(${flags})
  if [[ \${words[CURRENT]} == -* ]]; then
    _describe -t flags 'flag' flags
  else
    _describe -t commands 'deepdive command' subcommands
    _describe -t flags 'flag' flags
  fi
}
compdef _deepdive deepdive
`;
}

function fish(): string {
  const lines: string[] = [
    "# deepdive fish completion. Add to ~/.config/fish/completions/deepdive.fish:",
    "#   deepdive completion fish > ~/.config/fish/completions/deepdive.fish",
    "complete -c deepdive -f",
  ];
  for (const [s, d] of SUBCOMMANDS) {
    lines.push(
      `complete -c deepdive -n '__fish_use_subcommand' -a '${s}' -d '${escapeFish(d)}'`,
    );
  }
  for (const [f, d] of FLAGS) {
    const long = f.replace(/^--/, "");
    lines.push(`complete -c deepdive -l ${long} -d '${escapeFish(d)}'`);
  }
  return lines.join("\n") + "\n";
}

function escapeFish(s: string): string {
  return s.replace(/'/g, "\\'");
}
