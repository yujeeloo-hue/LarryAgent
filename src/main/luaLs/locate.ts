import { accessSync, constants } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const LUA_LS_CONFIG_FILES = [".emmyrc.json", ".luarc.json"];

function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export type LuaServerBundle = {
  packaged: boolean;
  resourcesPath?: string | undefined;
  devRoots?: readonly string[];
  arch?: string;
};

function defaultBundle(): LuaServerBundle {
  return { packaged: false, devRoots: [process.cwd()] };
}

export function luaServerCandidates(
  bundle: LuaServerBundle = defaultBundle(),
  platform: NodeJS.Platform = process.platform,
): string[] {
  const binary = platform === "win32" ? "emmylua_ls.exe" : "emmylua_ls";
  if (bundle.packaged) {
    return bundle.resourcesPath ? [join(bundle.resourcesPath, "emmylua", binary)] : [];
  }
  const arch = bundle.arch ?? process.arch;
  const candidates = (bundle.devRoots ?? []).map((root) =>
    join(root, "resources", "emmylua", `${platform}-${arch}`, binary),
  );
  return [...new Set(candidates)];
}

export function findLuaServer(
  bundle: LuaServerBundle = defaultBundle(),
  exists: (path: string) => boolean = pathExists,
  platform: NodeJS.Platform = process.platform,
): string | null {
  return luaServerCandidates(bundle, platform).find((candidate) => exists(candidate)) ?? null;
}

export function luaPathKey(path: string, platform: NodeJS.Platform = process.platform): string {
  const normalized = resolve(path).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? normalized.toLowerCase() : normalized;
}

function isSameOrUnder(child: string, parent: string): boolean {
  const c = luaPathKey(child);
  const p = luaPathKey(parent);
  return c === p || c.startsWith(`${p}/`);
}

export function resolveLuaRoot(
  filePath: string,
  workspaceRoot: string,
  exists: (path: string) => boolean = pathExists,
): string {
  const root = resolve(workspaceRoot);
  let dir = dirname(resolve(filePath));
  if (!isSameOrUnder(dir, root)) return root;
  for (;;) {
    if (LUA_LS_CONFIG_FILES.some((name) => exists(join(dir, name)))) return dir;
    if (luaPathKey(dir) === luaPathKey(root)) return root;
    const parent = dirname(dir);
    if (parent === dir) return root;
    dir = parent;
  }
}
