import { existsSync } from "node:fs";
import { join } from "node:path";

export type FindChromeBinaryOpts = {
  platform?: NodeJS.Platform;
  exists?: (path: string) => boolean;
  env?: NodeJS.ProcessEnv;
  extraPaths?: string[];
};

function windowsCandidates(env: NodeJS.ProcessEnv): string[] {
  const pf = env.PROGRAMFILES ?? "C:\\Program Files";
  const pf86 = env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)";
  const local = env.LOCALAPPDATA ?? "";
  return [
    join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    ...(local ? [join(local, "Google", "Chrome", "Application", "chrome.exe")] : []),
    join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    ...(local ? [join(local, "Microsoft", "Edge", "Application", "msedge.exe")] : []),
  ];
}

function darwinCandidates(): string[] {
  return [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ];
}

function linuxCandidates(): string[] {
  return [
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
    "/usr/bin/chromium-browser",
    "/usr/bin/chromium",
    "/snap/bin/chromium",
  ];
}

/** Chrome, then Edge, then Chromium — first existing path wins. */
export function findChromeBinary(opts?: FindChromeBinaryOpts): string | null {
  const os = opts?.platform ?? process.platform;
  const exists = opts?.exists ?? ((path: string) => existsSync(path));
  const env = opts?.env ?? process.env;
  const extra = opts?.extraPaths ?? [];
  const candidates =
    os === "win32"
      ? windowsCandidates(env)
      : os === "darwin"
        ? darwinCandidates()
        : linuxCandidates();
  for (const path of [...extra, ...candidates]) {
    if (path && exists(path)) return path;
  }
  return null;
}
