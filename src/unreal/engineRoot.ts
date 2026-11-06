/**
 * Unreal engine-root resolution (game .uproject → Engine/Source).
 *
 * Used by Dev Mode search and by the launch-context / UBT path. No Electron.
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * UE project marker (`<root>/*.uproject`) — one readdir, no recursion.
 * Opt-in cheap: the engine root has no .uproject, so it stays unscoped.
 */
export function isUnrealProjectRoot(root: string): boolean {
  try {
    return readdirSync(root, { withFileTypes: true }).some(
      (d) => d.isFile() && d.name.toLowerCase().endsWith(".uproject"),
    );
  } catch {
    return false;
  }
}

/** True when `dir` is an engine root: `<dir>/Engine/Source` exists. */
export function hasEngineSource(dir: string): boolean {
  try {
    return readdirSync(join(dir, "Engine", "Source"), { withFileTypes: true }).some(
      (d) => d.isDirectory(),
    );
  } catch {
    return false;
  }
}

/** `<engineRoot>/Engine` — source-engine layout (UE5.sln + Engine/Source). */
function findEngineSourceRoot(root: string): string | null {
  try {
    const dirents = readdirSync(root, { withFileTypes: true });
    if (!dirents.some((d) => d.isFile() && /^UE\d*\.sln$/i.test(d.name))) {
      return null;
    }
    const engine = join(root, "Engine");
    if (!readdirSync(engine, { withFileTypes: true }).some((d) => d.isDirectory())) {
      return null;
    }
    return engine;
  } catch {
    return null;
  }
}

/**
 * Sibling-layout source engine: NF keeps the game at `…/SourceClient/
 * SourceClient` and the engine at `…/UnrealEngine`, so climb a few levels
 * and look for `<ancestor>/<sibling>/Engine/Source`. One readdir per level,
 * bounded — no registry, no spawn.
 */
function findSiblingEngineSource(projectRoot: string): string | null {
  let dir = projectRoot;
  for (let depth = 0; depth < 4; depth++) {
    const parent = dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      break;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        if (!readdirSync(join(dir, e.name), { withFileTypes: true }).length) continue;
      } catch {
        continue;
      }
      const candidate = join(dir, e.name);
      if (candidate.toLowerCase() === projectRoot.toLowerCase()) continue;
      if (hasEngineSource(candidate)) return join(candidate, "Engine");
    }
  }
  return null;
}

/** `<root>/*.uproject` → EngineAssociation (source-engine GUID or version). */
async function readEngineAssociation(projectRoot: string): Promise<string | null> {
  try {
    const names = readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".uproject"))
      .map((d) => d.name);
    for (const name of names.slice(0, 1)) {
      const raw = await readFile(join(projectRoot, name), "utf8");
      const parsed: unknown = JSON.parse(raw);
      const assoc =
        parsed && typeof parsed === "object"
          ? (parsed as { EngineAssociation?: unknown }).EngineAssociation
          : undefined;
      if (typeof assoc === "string" && assoc.trim()) return assoc.trim();
    }
  } catch {
    /* unreadable / malformed — fall through */
  }
  return null;
}

/** `reg query HKCU\…\Builds /v <assoc>` → the registered engine path. */
function queryRegisteredEngine(assoc: string): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const key = "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";
  return new Promise((resolvePromise) => {
    execFile(
      reg,
      ["query", key, "/v", assoc],
      { windowsHide: true, timeout: 2000 },
      (err, stdout) => {
        if (err) return resolvePromise(null);
        const m = /REG_SZ\s+(.+)$/im.exec(String(stdout));
        const value = m?.[1]?.trim();
        resolvePromise(value ? value : null);
      },
    );
  });
}

/** Resolved engine roots, keyed by project root (null = none found). */
const engineRootCache = new Map<string, string | null>();

/**
 * Engine source root for a UE project, or null. Local `Engine/` first, then
 * a sibling layout, then the registry `EngineAssociation` (source engines
 * registered under HKCU Builds). Cached per project root.
 */
export async function resolveUeEngineSourceRoot(
  projectRoot: string,
): Promise<string | null> {
  const key = resolve(projectRoot);
  const cached = engineRootCache.get(key);
  if (cached !== undefined) return cached;

  let found: string | null = findEngineSourceRoot(key) ?? findSiblingEngineSource(key);
  if (!found) {
    const assoc = await readEngineAssociation(key);
    if (assoc) {
      const registered = await queryRegisteredEngine(assoc);
      if (registered && hasEngineSource(registered)) {
        found = join(resolve(registered), "Engine");
      }
    }
  }
  engineRootCache.set(key, found);
  return found;
}

/** Test helper — unique tmp dirs do not need this; shared fixtures do. */
export function clearUeEngineRootCache(): void {
  engineRootCache.clear();
}

export function pathExists(p: string): boolean {
  try {
    return existsSync(p);
  } catch {
    return false;
  }
}
