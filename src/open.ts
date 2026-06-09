// Tiny cross-platform "open this file in the default app" helper. The command
// selection is a pure function (unit-testable without spawning anything); the
// actual spawn lives in the CLI. Used by `deepdive open <id>` to pop the
// exported HTML report in the user's browser.

export interface OpenCommand {
  cmd: string;
  args: string[];
}

// Returns the command + args to open `target` with the OS default handler.
// Every platform uses a DIRECT executable (no shell): the caller passes these
// straight to spawn() with shell:false, so `target` is a single argv entry and
// can never be interpreted as a command — no shell-injection surface, even
// from a user-supplied --out path or session id.
//
// Windows deliberately avoids `cmd /c start` (which would route through a
// shell): `explorer <file>` opens a path with its registered default handler
// (a browser, for .html) as a plain exec.
export function browserOpenCommand(
  platform: NodeJS.Platform,
  target: string,
): OpenCommand {
  switch (platform) {
    case "win32":
      return { cmd: "explorer.exe", args: [target] };
    case "darwin":
      return { cmd: "open", args: [target] };
    default:
      // Linux / BSD — xdg-open is the freedesktop standard.
      return { cmd: "xdg-open", args: [target] };
  }
}
