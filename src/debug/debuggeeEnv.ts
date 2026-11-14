/**
 * Environment for processes launched from the debugger host (Electron).
 *
 * Nested Node / Chrome / Electron inherit Larry Agent's Chromium env by
 * default. On macOS, `CHROME_CRASHPAD_PIPE_NAME` in particular lets a child
 * Chrome talk to the host crashpad handler and abort the whole app — the
 * ETHub (HTML + Node server) debug path spawned Chrome this way.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

const EXACT_DENY = new Set([
  "NODE_OPTIONS",
  "VSCODE_INSPECTOR_OPTIONS",
  "LD_PRELOAD",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);

export type CopyDebuggeeEnvOpts = {
  platform?: NodeJS.Platform;
  home?: string;
};

export function isHostDebugEnvKey(key: string): boolean {
  const upper = key.toUpperCase();
  if (EXACT_DENY.has(upper)) return true;
  if (upper.startsWith("ELECTRON_") || upper.startsWith("CHROME_")) return true;
  return false;
}

export function nvmNodeBinDirs(
  home: string,
  listDir: (path: string) => string[] = (path) => readdirSync(path),
): string[] {
  const nvm = posix.join(home, ".nvm", "versions", "node");
  try {
    return listDir(nvm)
      .filter((name) => /^v\d/.test(name))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((name) => posix.join(nvm, name, "bin"));
  } catch {
    return [];
  }
}

/** GUI apps on macOS get `/usr/bin:/bin` — nvm / Homebrew node are missing. */
export function unixPathWithNodeLookup(
  pathEnv: string | undefined,
  home: string,
  extras: string[] = [],
): string {
  const seen = new Set<string>();
  const dirs: string[] = [];
  const add = (dir: string): void => {
    if (!dir || seen.has(dir)) return;
    seen.add(dir);
    dirs.push(dir);
  };
  for (const dir of extras) add(dir);
  add("/opt/homebrew/bin");
  add("/usr/local/bin");
  add(posix.join(home, ".local", "bin"));
  add(posix.join(home, ".volta", "bin"));
  add(posix.join(home, ".fnm", "current", "bin"));
  add(posix.join(home, ".asdf", "shims"));
  for (const dir of nvmNodeBinDirs(home)) add(dir);
  for (const dir of (pathEnv ?? "").split(":")) add(dir);
  return dirs.join(":");
}

export function resolveNodeFromPath(
  pathEnv: string,
  exists: (path: string) => boolean = existsSync,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const paths = platform === "win32" ? win32 : posix;
  for (const dir of pathEnv.split(paths.delimiter)) {
    if (!dir) continue;
    const candidate = paths.join(dir, platform === "win32" ? "node.exe" : "node");
    if (exists(candidate)) return candidate;
  }
  return null;
}

export function copyDebuggeeEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
  opts?: CopyDebuggeeEnvOpts,
): Record<string, string> {
  const platform = opts?.platform ?? process.platform;
  const home = opts?.home ?? homedir();
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    if (isHostDebugEnvKey(key)) continue;
    env[key] = value;
  }
  if (platform !== "win32") {
    env.PATH = unixPathWithNodeLookup(env.PATH ?? sourceEnv.PATH, home);
  }
  return env;
}
