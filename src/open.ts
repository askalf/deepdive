// Tiny cross-platform "open this file in the default app" helper. The command
// selection is a pure function (unit-testable without spawning anything); the
// actual spawn lives in the CLI. Used by `deepdive open <id>` to pop the
// exported HTML report in the user's browser.

export interface OpenCommand {
  cmd: string;
  args: string[];
}

// Returns the command + leading args to open `target` with the OS default
// handler. The caller appends nothing else — `target` is the final arg, so it
// passes as a single argv entry and never goes through a shell (no injection).
export function browserOpenCommand(
  platform: NodeJS.Platform,
  target: string,
): OpenCommand {
  switch (platform) {
    case "win32":
      // `cmd /c start "" <target>` — the empty "" is start's title arg, so a
      // target with spaces isn't misread as the window title.
      return { cmd: "cmd", args: ["/c", "start", "", target] };
    case "darwin":
      return { cmd: "open", args: [target] };
    default:
      // Linux / BSD — xdg-open is the freedesktop standard.
      return { cmd: "xdg-open", args: [target] };
  }
}
