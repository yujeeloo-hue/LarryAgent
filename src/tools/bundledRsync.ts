/**
 * Locate the private Windows cwRsync runtime without adding it to PATH.
 * Electron is loaded dynamically so headless agentd stays Electron-free.
 */
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";

interface ElectronApp {
  isPackaged: boolean;
  getAppPath(): string;
}

const electronProcess = process as NodeJS.Process & { resourcesPath?: string };
let electronAppPromise: Promise<ElectronApp | null> | null = null;

function loadElectronApp(): Promise<ElectronApp | null> {
  electronAppPromise ??= (async () => {
    try {
      const mod = await import("electron") as { app?: ElectronApp };
      return mod.app ?? null;
    } catch {
      return null;
    }
  })();
  return electronAppPromise;
}

export function bundledRsyncPath(resourcesRoot: string): string {
  return join(resourcesRoot, "rsync", "bin", "rsync.exe");
}

/** Match cwrsync.cmd: use its own ssh first and the Windows user's .ssh config. */
export function rsyncRuntimeEnv(
  program: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  rsyncRsh?: string,
): Record<string, string> | undefined {
  if (platform !== "win32") return undefined;
  const bin = win32.dirname(program);
  if (bin === ".") return undefined;
  const home = env.USERPROFILE ?? env.HOME;
  return {
    PATH: `${bin};${env.PATH ?? ""}`,
    ...(home ? { HOME: home } : {}),
    ...(rsyncRsh ? { RSYNC_RSH: rsyncRsh } : {}),
  };
}

export type PreparedRsyncRuntime = {
  env: Record<string, string> | undefined;
  cleanup(): void;
};

/**
 * Cygwin ssh rejects some valid Windows ACLs on ~/.ssh/config. A fresh copy in
 * a per-run temp dir has an ACL Cygwin accepts; the original is never modified.
 */
export function prepareRsyncRuntime(program: string): PreparedRsyncRuntime {
  if (process.platform !== "win32" || win32.dirname(program) === ".") {
    return { env: undefined, cleanup() {} };
  }
  const bin = win32.dirname(program);
  const ssh = join(bin, "ssh.exe");
  const profile = process.env.USERPROFILE ?? process.env.HOME;
  const sourceConfig = profile ? join(profile, ".ssh", "config") : null;
  let tempDir: string | null = null;
  let rsyncRsh: string | undefined;
  if (existsSync(ssh)) {
    let configCopy: string | undefined;
    if (sourceConfig && existsSync(sourceConfig)) {
      tempDir = mkdtempSync(join(tmpdir(), "jellybot-rsync-"));
      try {
        configCopy = join(tempDir, "config");
        copyFileSync(sourceConfig, configCopy);
        chmodSync(configCopy, 0o600);
      } catch (error) {
        rmSync(tempDir, { recursive: true, force: true });
        throw error;
      }
    }
    const sshArg = ssh.replaceAll("\\", "/");
    const configArg = configCopy ? ` -F "${configCopy.replaceAll("\\", "/")}"` : "";
    rsyncRsh = `"${sshArg}"${configArg}`;
  }
  return {
    env: rsyncRuntimeEnv(program, process.platform, process.env, rsyncRsh),
    cleanup() {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    },
  };
}

/** Pure candidate list: every usable-looking bundled root, then system rsync. */
export function rsyncCandidatesForResources(
  resourcesRoots: string[],
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string[] {
  if (platform !== "win32") return ["rsync"];
  const bundled = resourcesRoots.map(bundledRsyncPath).filter(exists);
  return [...new Set([...bundled, "rsync"])];
}

/** Packaged resources first; an unpackaged Electron app uses its repo resources. */
export async function rsyncProgramCandidates(): Promise<string[]> {
  if (process.platform !== "win32") return ["rsync"];
  const roots: string[] = [];
  if (electronProcess.resourcesPath) roots.push(electronProcess.resourcesPath);
  const app = await loadElectronApp();
  if (app && !app.isPackaged) roots.push(join(app.getAppPath(), "resources"));
  return rsyncCandidatesForResources(roots);
}
