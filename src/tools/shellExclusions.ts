import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/** Reported when a caller asked for fail-closed exclusions on a platform without a backend. */
export const SHELL_EXCLUSION_UNAVAILABLE = "Shell refused: CoCo Strict Shell isolation is on, and this platform cannot sandbox Shell away from other projects, so every Shell command in this task is refused regardless of its target directory. This is a setting, not a permission on any specific folder. Ask the user to turn off Settings → CoCo → Strict Shell isolation, then retry.";

/** macOS is the only platform with a per-process file exclusion backend (sandbox-exec). */
export function shellExclusionsEnforceable(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin";
}

/**
 * Automatic project exclusion only. Shell, environment and network retain the app's permissions.
 * Without a backend the command runs unchanged (best effort, like an ordinary Shell); callers that
 * need fail-closed behaviour set strictShellExclusions on the executor input instead.
 */
export function excludedProjectShell(command: string, args: string[], roots: string[], platform: NodeJS.Platform = process.platform): { command: string; args: string[] } {
  if (!roots.length) return { command, args };
  if (!shellExclusionsEnforceable(platform)) return { command, args };
  const paths = new Set<string>();
  for (const root of roots) { paths.add(resolve(root)); try { paths.add(realpathSync.native(root)); } catch {  } }
  const filters = [...paths].map(path => `(subpath ${JSON.stringify(path)})`).join(" ");
  return { command: "/usr/bin/sandbox-exec", args: ["-p", `(version 1)\n(allow default)\n(deny file-read* file-write* ${filters})`, command, ...args] };
}
