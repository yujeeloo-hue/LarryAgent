/**
 * Game-module DLLs that LLDB should search for file:line breakpoints.
 * Engine binaries stay unloaded until a stack frame actually lands in them.
 */
import { existsSync, readdirSync } from "node:fs";
import { isAbsolute, join, normalize, sep } from "node:path";

const GAME_EDITOR_DLL = /^UnrealEditor-.+-Win64-DebugGame\.dll$/i;

export type ListGameEditorShlibsOpts = {
  exists?: (p: string) => boolean;
  listDir?: (dir: string) => string[];
  /** Include a plugin's DebugGame DLL only when a breakpoint targets it. */
  sourcePaths?: string[];
};

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function collectDlls(
  dir: string,
  exists: (p: string) => boolean,
  listDir: (d: string) => string[],
  out: Set<string>,
): void {
  if (!exists(dir)) return;
  for (const name of listDir(dir)) {
    if (GAME_EDITOR_DLL.test(name)) out.add(name);
  }
}

function pluginRootForSource(projectRoot: string, sourcePath: string): string | null {
  if (!isAbsolute(sourcePath)) return null;
  const root = normalize(projectRoot);
  const source = normalize(sourcePath);
  const prefix = `${root}${sep}Plugins${sep}`;
  if (!source.toLowerCase().startsWith(prefix.toLowerCase())) return null;
  const relative = source.slice(prefix.length);
  const pluginName = relative.split(/[\\/]/, 1)[0];
  return pluginName ? join(root, "Plugins", pluginName) : null;
}

/**
 * DebugGame Editor DLLs owned by the project. Project target modules are
 * always included; plugin modules are added only for persisted breakpoints in
 * that plugin, avoiding hundreds of unrelated project-plugin PDBs.
 */
export function listGameEditorShlibs(
  projectRoot: string,
  opts?: ListGameEditorShlibsOpts,
): string[] {
  const exists = opts?.exists ?? ((p: string) => existsSync(p));
  const listDir = opts?.listDir ?? defaultListDir;
  const out = new Set<string>();
  collectDlls(join(projectRoot, "Binaries", "Win64"), exists, listDir, out);
  const pluginRoots = new Set(
    (opts?.sourcePaths ?? [])
      .map((path) => pluginRootForSource(projectRoot, path))
      .filter((path): path is string => Boolean(path)),
  );
  for (const pluginRoot of pluginRoots) {
    collectDlls(join(pluginRoot, "Binaries", "Win64"), exists, listDir, out);
  }
  return [...out].sort();
}
