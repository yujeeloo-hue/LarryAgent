/**
 * Release channel of a device — which `downloads.json` entry its remote
 * self-update has to read.
 *
 * The manifest ships one entry per platform and those entries do NOT move in
 * lock-step (in practice: mac 1.5.2 / win 1.5.3 / agentd 1.5.1). Every value
 * derived from an entry — version, URL, sha256 — therefore belongs to exactly
 * one channel, and the console has to keep them apart. Sharing one draft
 * (the pre-fix behaviour) carried one platform's version into another
 * platform's Maintenance card: the version comparison then read "already
 * installed" / "newer available" against the wrong release, and Update could
 * push a Windows setup at a Mac or a tarball at a desktop.
 */
export type MaintenanceChannel = "mac" | "win" | "agentd";

export const MAINTENANCE_CHANNELS: readonly MaintenanceChannel[] = ["mac", "win", "agentd"];

/**
 * `"darwin arm64"` → "mac", `"win32 x64"` → "win", `"linux arm64"` → "agentd"
 * (the filename agentd ships under), anything else → null. The device platform
 * string is `<process.platform> <arch>`, so only the head token matters.
 */
export function maintenanceChannel(platform: string | null | undefined): MaintenanceChannel | null {
  const head = String(platform ?? "").trim().toLowerCase().split(/[\s/]+/)[0] ?? "";
  if (head === "darwin" || head === "mac" || head === "macos") return "mac";
  if (head === "win32" || head === "win" || head === "windows") return "win";
  if (head === "linux") return "agentd";
  return null;
}

/** Filename of a path or URL, without query/fragment and directory part. */
function baseName(value: string): string {
  const path = value.split(/[?#]/)[0] ?? value;
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Version encoded in a release filename:
 *   `Larry-Agent-1.5.3-win-x64-setup.exe`
 *   `Larry-Agent-1.5.2-mac-arm64.zip` / `.dmg`
 *   `jellybot-agentd-1.5.1-linux-arm64.tar.gz`
 * Undefined when the name carries no dotted version (`release.zip`).
 */
export function releaseVersionFromFile(value: string): string | undefined {
  // Only dotted versions count: `x64`/`arm64` must never be read as a version.
  return /(?:^|[-_v])(\d+(?:\.\d+)+)(?=[-_.]|$)/.exec(baseName(value))?.[1];
}

/**
 * Which channel a release filename belongs to — null when the name says
 * nothing (custom builds, local paths). Order matters: desktop markers are
 * checked before the agentd one so `Larry-Agent-…-mac-….zip` never reads as
 * agentd, and `.exe` wins over everything else.
 */
export function releaseChannelOfFile(value: string): MaintenanceChannel | null {
  const name = baseName(value).toLowerCase();
  if (/\.(exe|msi)$/.test(name) || /(^|[-_.])(win|windows)([-_.]|$)/.test(name)) return "win";
  if (/\.(zip|dmg|pkg)$/.test(name) || /(^|[-_.])(mac|macos|darwin|osx)([-_.]|$)/.test(name)) return "mac";
  if (/agentd/.test(name) || /\.(tar\.gz|tar\.xz|tgz)$/.test(name)) return "agentd";
  return null;
}

/**
 * Does this release file belong to the device's channel? Unrecognised names
 * pass — a hand-typed custom source is the operator's call; only a package
 * that clearly belongs to *another* platform is refused.
 */
export function releaseMatchesChannel(value: string, channel: MaintenanceChannel): boolean {
  const found = releaseChannelOfFile(value);
  return found === null || found === channel;
}
