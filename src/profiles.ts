// Named profiles — reusable bundles of settings selected with --profile=<name>.
// Built-ins cover the common modes; a user's config file can add or override
// profiles of the same name. Selecting a profile is equivalent to setting its
// keys as defaults (below env + CLI flags) for that run.

import type { FileConfig } from "./config-file.js";

// Built-in profiles. Values use the same friendly keys as the config file.
export const BUILTIN_PROFILES: Record<string, FileConfig> = {
  // Iterate harder: 3 critic rounds.
  deep: { deep: 3 },
  // Maximum diligence: deeper loop, wider source net, strict citations.
  thorough: { deep: 4, maxSources: 20, strictCites: true },
  // Lowest latency: high fetch concurrency, single-pass.
  fast: { concurrency: 8, deep: 0 },
  // Spend less: cheap models for the structurally-simple plan/critic stages,
  // keep the quality model for synthesis.
  cheap: {
    planModel: "claude-haiku-4-5",
    criticModel: "claude-haiku-4-5",
    synthModel: "claude-sonnet-4-6",
  },
  // Fail the run on any weakly-supported citation; raise the recall bar.
  strict: { strictCites: true, citeMinRecall: 0.5 },
};

// Resolve a profile name to its config. A user profile of the same name
// overrides the built-in (its keys win on top of the built-in's). Throws with
// the list of available profiles when the name is unknown.
export function resolveProfile(
  name: string,
  userProfiles: Record<string, FileConfig> = {},
): FileConfig {
  const builtin = BUILTIN_PROFILES[name];
  const user = userProfiles[name];
  if (!builtin && !user) {
    throw new Error(
      `unknown profile: ${name} (available: ${listProfiles(userProfiles).join(", ")})`,
    );
  }
  return { ...(builtin ?? {}), ...(user ?? {}) };
}

// All selectable profile names — built-ins plus any from the config file.
export function listProfiles(
  userProfiles: Record<string, FileConfig> = {},
): string[] {
  return Array.from(
    new Set([...Object.keys(BUILTIN_PROFILES), ...Object.keys(userProfiles)]),
  ).sort();
}
