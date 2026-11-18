export type MaintenanceChannel = "mac" | "win" | "agentd";

export const MAINTENANCE_CHANNELS: readonly MaintenanceChannel[] = ["mac", "win", "agentd"];

export function maintenanceChannel(platform: string | null | undefined): MaintenanceChannel | null {
  const head = String(platform ?? "").trim().toLowerCase().split(/[\s/]+/)[0] ?? "";
  if (head === "darwin" || head === "mac" || head === "macos") return "mac";
  if (head === "win32" || head === "win" || head === "windows") return "win";
  if (head === "linux") return "agentd";
  return null;
}

function baseName(value: string): string {
  const path = value.split(/[?#]/)[0] ?? value;
  return path.split(/[\\/]/).pop() ?? path;
}

export function releaseVersionFromFile(value: string): string | undefined {
  return /(?:^|[-_v])(\d+(?:\.\d+)+)(?=[-_.]|$)/.exec(baseName(value))?.[1];
}

export function releaseChannelOfFile(value: string): MaintenanceChannel | null {
  const name = baseName(value).toLowerCase();
  if (/\.(exe|msi)$/.test(name) || /(^|[-_.])(win|windows)([-_.]|$)/.test(name)) return "win";
  if (/\.(zip|dmg|pkg)$/.test(name) || /(^|[-_.])(mac|macos|darwin|osx)([-_.]|$)/.test(name)) return "mac";
  if (/agentd/.test(name) || /\.(tar\.gz|tar\.xz|tgz)$/.test(name)) return "agentd";
  return null;
}

export function releaseMatchesChannel(value: string, channel: MaintenanceChannel): boolean {
  const found = releaseChannelOfFile(value);
  return found === null || found === channel;
}
