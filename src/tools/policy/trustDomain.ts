import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { IS_WINDOWS } from "../../platformCaps.js";

/**
 * Workspace trust domain (plan: docs/plans/20260819-shell-safe-mode.md).
 *
 * Trust is the workspace root itself, decoupled from git (settled in plan
 * review): reads/writes/deletes inside the workspace root run without
 * approval in Safe Mode; deletes are additionally rewritten to the Trash
 * by the run_shell pipeline. Everything outside is "outside" (needs a
 * confirmation card or Bypass) or "sensitive" (system / credential paths,
 * Class B at minimum).
 *
 * Pure functions; no filesystem access.
 */

export type PathTrustZone = "workspace" | "sensitive" | "outside";

/**
 * Home-relative directory trees whose first path component marks the whole
 * subtree sensitive (credentials, agent configs).
 */
export const SENSITIVE_HOME_DIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".config",
  ".aws",
  ".kube",
  ".docker",
];

/** Home-relative dotfiles (exact relative path) that count as sensitive. */
export const SENSITIVE_HOME_FILES: readonly string[] = [
  ".zshrc",
  ".zshenv",
  ".zprofile",
  ".zlogin",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".netrc",
  ".npmrc",
  ".pypirc",
];

/** System absolute prefixes (matched case-insensitively, boundary-aware). */
export const SENSITIVE_ABSOLUTE_PREFIXES: readonly string[] = [
  "/etc",
  "/system",
  "/library",
  "/usr",
  "/private/etc",
  "/private/var",
  "/var",
  "/bin",
  "/sbin",
  "/applications",
];

/** Windows system absolute prefixes (drive-relative, case-insensitive). */
export const SENSITIVE_ABSOLUTE_PREFIXES_WINDOWS: readonly string[] = [
  "\\Windows",
  "\\Program Files",
  "\\Program Files (x86)",
  "\\ProgramData",
  "\\Users",
  "\\System Volume Information",
  "\\Recovery",
];

/** True when `child` equals `parent` or lives somewhere below it. */
export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const base = p.endsWith(sep) ? p : `${p}${sep}`;
  return c.startsWith(base);
}

/**
 * Sensitive = home root itself, credential/config subtrees under home
 * (incl. ~/Library), shell rc files, or system absolute prefixes.
 */
export function isSensitivePath(
  absolutePath: string,
  homeDir: string = homedir(),
): boolean {
  const p = resolve(absolutePath);
  const home = resolve(homeDir);
  if (p === home) return true;
  if (isWithin(home, p)) {
    const rel = relative(home, p);
    const first = rel.split(sep)[0] ?? "";
    if (SENSITIVE_HOME_DIRS.includes(first)) return true;
    if (SENSITIVE_HOME_FILES.includes(rel)) return true;
    if (first === "Library") return true;
    return false;
  }
  const lower = p.toLowerCase();
  const prefixes = IS_WINDOWS
    ? SENSITIVE_ABSOLUTE_PREFIXES_WINDOWS
    : SENSITIVE_ABSOLUTE_PREFIXES;
  // Windows: both sides drive-stripped ("\windows") — resolve() anchors a
  // drive-relative prefix to the cwd's drive, but the path under test may
  // live on any drive ("c:\windows\..." vs an E:-relative base).
  return prefixes.some((prefix) => {
    const base = resolve(prefix).toLowerCase();
    const stripDrive = (s: string) => (s.startsWith("\\\\") ? s : s.slice(2));
    const target = IS_WINDOWS ? stripDrive(lower) : lower;
    const root = IS_WINDOWS ? stripDrive(base) : base;
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  });
}

/**
 * Classify an absolute path against the trust domain.
 * Order: workspace wins (a .ssh folder inside the workspace is still
 * workspace — deletes there go through the Trash rewrite), then sensitive,
 * then outside.
 */
export function classifyPathTarget(input: {
  absolutePath: string;
  workspaceRoot: string;
  homeDir?: string;
}): PathTrustZone {
  const p = resolve(input.absolutePath);
  if (isWithin(resolve(input.workspaceRoot), p)) return "workspace";
  if (isSensitivePath(p, input.homeDir ?? homedir())) return "sensitive";
  return "outside";
}
