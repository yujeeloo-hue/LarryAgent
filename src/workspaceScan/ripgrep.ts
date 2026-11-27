import { existsSync } from "node:fs";
import { join } from "node:path";

interface ElectronApp {
  isPackaged: boolean;
  getAppPath(): string;
}

const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
let electronAppPromise: Promise<ElectronApp | null> | null = null;
let resolvedPromise: Promise<string> | null = null;

function loadElectronApp(): Promise<ElectronApp | null> {
  electronAppPromise ??= (async () => {
    try {
      const mod = (await import("electron")) as { app?: ElectronApp };
      return mod.app ?? null;
    } catch {
      return null;
    }
  })();
  return electronAppPromise;
}

export function ripgrepBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "rg.exe" : "rg";
}

export function ripgrepCandidates(input: {
  resourcesPath?: string | undefined;
  devRoots?: readonly string[];
  platform?: NodeJS.Platform;
  arch?: string;
  exists?: (path: string) => boolean;
}): string[] {
  const platform = input.platform ?? process.platform;
  const arch = input.arch ?? process.arch;
  const exists = input.exists ?? existsSync;
  const exe = ripgrepBinaryName(platform);
  const bundled: string[] = [];
  if (input.resourcesPath) bundled.push(join(input.resourcesPath, "ripgrep", exe));
  for (const root of input.devRoots ?? []) {
    bundled.push(join(root, "resources", "ripgrep", `${platform}-${arch}`, exe));
  }
  return [...new Set([...bundled.filter((path) => exists(path)), "rg"])];
}

export function resolveRipgrep(): Promise<string> {
  resolvedPromise ??= (async () => {
    const app = await loadElectronApp();
    const devRoots = [process.cwd()];
    if (app && !app.isPackaged) devRoots.unshift(app.getAppPath());
    return ripgrepCandidates({ resourcesPath: electronProcess.resourcesPath, devRoots })[0]!;
  })();
  return resolvedPromise;
}
