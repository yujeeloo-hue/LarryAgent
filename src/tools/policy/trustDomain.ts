import { homedir } from "node:os";
import { relative, resolve, sep } from "node:path";
import { IS_WINDOWS } from "../../platformCaps.js";


export type PathTrustZone = "workspace" | "sensitive" | "outside";

export const SENSITIVE_HOME_DIRS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".config",
  ".aws",
  ".kube",
  ".docker",
];

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

export const SENSITIVE_ABSOLUTE_PREFIXES_WINDOWS: readonly string[] = [
  "\\Windows",
  "\\Program Files",
  "\\Program Files (x86)",
  "\\ProgramData",
  "\\Users",
  "\\System Volume Information",
  "\\Recovery",
];

export function isWithin(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  if (p === c) return true;
  const base = p.endsWith(sep) ? p : `${p}${sep}`;
  return c.startsWith(base);
}

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
  return prefixes.some((prefix) => {
    const base = resolve(prefix).toLowerCase();
    const stripDrive = (s: string) => (s.startsWith("\\\\") ? s : s.slice(2));
    const target = IS_WINDOWS ? stripDrive(lower) : lower;
    const root = IS_WINDOWS ? stripDrive(base) : base;
    return target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
  });
}

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
