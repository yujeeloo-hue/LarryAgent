/**
 * Unreal engine-root resolution (game .uproject → Engine/Source).
 *
 * Used by Dev Mode search and by the launch-context / UBT path. No Electron.
 */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
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
    if (!dirents.some((d) => d.name === "Engine" && d.isDirectory())) {
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
    const candidates: string[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        if (!readdirSync(join(dir, e.name), { withFileTypes: true }).length) continue;
      } catch {
        continue;
      }
      const candidate = join(dir, e.name);
      if (candidate.toLowerCase() === projectRoot.toLowerCase()) continue;
      if (hasEngineSource(candidate)) candidates.push(join(candidate, "Engine"));
    }
    if (candidates.length) return candidates.length === 1 ? candidates[0]! : null;
  }
  return null;
}

/** `<root>/*.uproject` → EngineAssociation (source-engine GUID or version). */
async function readEngineAssociation(projectRoot: string, uproject?: string): Promise<string | null> {
  try {
    const names = readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".uproject"))
      .map((d) => d.name);
    for (const name of uproject ? [uproject] : names.slice(0, 1).map(name => join(projectRoot, name))) {
      const raw = await readFile(name, "utf8");
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

export type EngineAssociationOpts = {
  platform?: NodeJS.Platform;
  /** `…/Epic` support directory. Defaults to the platform's Epic Application Support folder. */
  epicSupportDir?: string;
  /** Parent of launcher `UE_<version>` folders. Darwin default is `/Users/Shared/Epic Games`. */
  sharedEpicDir?: string;
};

/** Epic Application Support directory, or null on Windows (the registry is the source there). */
export function defaultEpicSupportDir(platform: NodeJS.Platform = process.platform): string | null {
  if (platform === "darwin") return join(homedir(), "Library", "Application Support", "Epic");
  if (platform === "linux") return join(homedir(), ".config", "Epic");
  return null;
}

/**
 * `LauncherInstalled.dat` entry whose `AppName` is `UE_<association>`
 * (launcher builds store the version as `UE_5.8` and the `.uproject` says `5.8`).
 */
export function launcherInstallRootFromManifest(text: string, association: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const list = parsed && typeof parsed === "object"
    ? (parsed as { InstallationList?: unknown }).InstallationList
    : undefined;
  if (!Array.isArray(list)) return null;
  const want = association.trim();
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const app = (item as { AppName?: unknown }).AppName;
    const location = (item as { InstallLocation?: unknown }).InstallLocation;
    if (typeof app !== "string" || typeof location !== "string") continue;
    const install = location.trim();
    if (!install) continue;
    const version = app.startsWith("UE_") ? app.slice(3) : app;
    if (app === `UE_${want}` || version === want) return install;
  }
  return null;
}

/** `[Installations]` value from Epic's `Install.ini` (source builds registered on Mac/Linux). */
export function installIniRoot(text: string, association: string): string | null {
  const want = association.trim();
  let inSection = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith(";") || line.startsWith("#")) continue;
    const section = /^\[(.+)\]$/.exec(line);
    if (section) {
      inSection = section[1] === "Installations";
      continue;
    }
    if (!inSection) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^"|"$/g, "");
    if (key === want && value) return value;
  }
  return null;
}

async function readUtf8(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * Install root (the directory that contains `Engine/`) for an
 * `EngineAssociation`, from the Epic launcher manifest, `Install.ini`, or
 * the shared `UE_<version>` folder. Windows keeps using the registry.
 */
export async function resolveAssociatedEngineInstall(
  association: string,
  opts?: EngineAssociationOpts,
): Promise<string | null> {
  const platform = opts?.platform ?? process.platform;
  const support = opts?.epicSupportDir ?? defaultEpicSupportDir(platform);
  const candidates: string[] = [];
  if (support) {
    const dat = await readUtf8(join(support, "UnrealEngineLauncher", "LauncherInstalled.dat"));
    const fromDat = dat ? launcherInstallRootFromManifest(dat, association) : null;
    if (fromDat) candidates.push(fromDat);
    const ini = await readUtf8(join(support, "UnrealEngine", "Install.ini"));
    const fromIni = ini ? installIniRoot(ini, association) : null;
    if (fromIni) candidates.push(fromIni);
  }
  if (platform === "darwin" && /^\d+\.\d+/.test(association.trim())) {
    candidates.push(join(opts?.sharedEpicDir ?? "/Users/Shared/Epic Games", `UE_${association.trim()}`));
  }
  for (const candidate of candidates) {
    if (hasEngineSource(candidate)) return candidate;
  }
  return null;
}

/** `reg query HKCU\…\Builds /v <assoc>` → the registered engine path. */
function queryRegisteredEngine(
  assoc: string,
  installed = false,
  platform: NodeJS.Platform = process.platform,
): Promise<string | null> {
  if (platform !== "win32" || process.platform !== "win32") return Promise.resolve(null);
  const reg = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe");
  const key = installed ? `HKLM\\SOFTWARE\\EpicGames\\Unreal Engine\\${assoc}` : "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";
  return new Promise((resolvePromise) => {
    execFile(
      reg,
      ["query", key, "/v", installed ? "InstalledDirectory" : assoc],
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
 * the association (Windows registry, or the Epic launcher manifest /
 * `Install.ini` / `UE_<version>` folder on Mac and Linux), then a sibling
 * layout. Cached per project root.
 */
export async function resolveUeEngineSourceRoot(
  projectRoot: string,
  uproject?: string,
  opts?: EngineAssociationOpts,
): Promise<string | null> {
  const key = resolve(projectRoot);
  const cacheKey = [
    uproject ? `${key}|${resolve(uproject)}` : key,
    opts?.platform ?? "",
    opts?.epicSupportDir ?? "",
    opts?.sharedEpicDir ?? "",
  ].join("\0");
  const cached = engineRootCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const platform = opts?.platform ?? process.platform;
  let found: string | null = findEngineSourceRoot(key);
  if (!found) {
    const assoc = await readEngineAssociation(key, uproject);
    if (assoc) {
      const registered = await queryRegisteredEngine(assoc, false, platform)
        ?? await queryRegisteredEngine(assoc, true, platform)
        ?? await resolveAssociatedEngineInstall(assoc, opts);
      if (registered && hasEngineSource(registered)) {
        found = join(resolve(registered), "Engine");
      }
    }
  }
  // Never let an unrelated sibling override the project's registered engine.
  found ??= findSiblingEngineSource(key);
  engineRootCache.set(cacheKey, found);
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
