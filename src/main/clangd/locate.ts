/**
 * Locate the pieces the clangd service needs: the clangd binary, the
 * Unreal project (`.uproject`) and a UBT-generated `compile_commands.json`
 * (`Build.bat -Mode=GenerateClangDatabase …`, emitted at the engine root).
 */

import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveAssociatedEngineInstall } from "../../unreal/engineRoot.js";
import { CLANGD_ZIP_VERSION } from "./download.js";

const execFileAsync = promisify(execFile);

export function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a usable clangd.exe. Search order:
 * 1. `JB_CLANGD_PATH` env override (tests / custom builds).
 * 2. Full LLVM install (`C:\Program Files\LLVM\bin`) — required anyway for
 *    UBT's GenerateClangDatabase mode.
 * 3. The standalone clangd zip downloaded under the JellyBot app-data
 *    tools dir (`tools/clangd/clangd_<ver>/bin/clangd.exe`).
 */
export function findClangdBinary(): string | null {
  const override = process.env.JB_CLANGD_PATH;
  if (override && pathExists(override)) return override;
  const candidates: string[] = [];
  if (process.platform === "win32") {
    candidates.push(join(process.env.ProgramFiles ?? "C:\\Program Files", "LLVM", "bin", "clangd.exe"));
    const downloaded = join(
      process.env.LOCALAPPDATA ?? "",
      "JellyBot",
      "tools",
      "clangd",
      `clangd_${CLANGD_ZIP_VERSION}`,
      "bin",
      "clangd.exe",
    );
    candidates.push(downloaded);
  } else {
    candidates.push("/usr/local/bin/clangd", "/opt/homebrew/bin/clangd", "/usr/bin/clangd");
  }
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const toolsRoot = join(process.env.LOCALAPPDATA, "JellyBot", "tools", "clangd");
    if (pathExists(toolsRoot)) {
      for (const entry of readdirSync(toolsRoot)) {
        candidates.push(join(toolsRoot, entry, "bin", "clangd.exe"));
      }
    }
  }
  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

export type UprojectInfo = {
  path: string;
  /** EngineAssociation value: "5.4", a source-build GUID, or empty. */
  association: string;
};

/** Read `<root>/*.uproject` and its EngineAssociation (null when absent). */
export function readUproject(root: string): UprojectInfo | null {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return null;
  }
  const name = entries.find((entry) => entry.toLowerCase().endsWith(".uproject"));
  if (!name) return null;
  const path = join(root, name);
  let association = "";
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { EngineAssociation?: unknown };
    if (typeof parsed.EngineAssociation === "string") association = parsed.EngineAssociation;
  } catch {
    // Unreadable uproject — association stays empty; compile db search
    // falls back to the workspace itself.
  }
  return { path, association };
}

/**
 * Resolve the engine install root (`…/UE_5.7`, `…/UnrealEngine`) from the
 * uproject association. GUID associations live under
 * `HKCU\Software\Epic Games\Unreal Engine\Builds`.
 */
const REG_BUILDS_KEY = "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";

/** Persisted engine root for one workspace (`<root>/.jellybot/`). */
function engineRootCachePath(root: string): string {
  return join(root, ".jellybot", "clangd-engine.json");
}

function readCachedEngineRoot(root: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(engineRootCachePath(root), "utf8")) as { engineRoot?: unknown };
    if (typeof parsed.engineRoot === "string" && pathExists(parsed.engineRoot)) {
      return parsed.engineRoot;
    }
  } catch {
    // No cache yet — first resolution.
  }
  return null;
}

function writeCachedEngineRoot(root: string, engineRoot: string): void {
  try {
    mkdirSync(join(root, ".jellybot"), { recursive: true });
    writeFileSync(
      engineRootCachePath(root),
      JSON.stringify({ engineRoot, savedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
  } catch {
    // Read-only workspace — the cache is an optimization only.
  }
}

/** All registered source-build engine roots (name → path). */
async function registeredEngineRoots(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (process.platform !== "win32") return out;
  try {
    const { stdout } = await execFileAsync("reg", ["query", REG_BUILDS_KEY]);
    for (const line of stdout.split(/\r?\n/)) {
      const match = /^\s*(\S+)\s+REG_SZ\s+(\S+)/.exec(line);
      if (match?.[1] && match?.[2]) out.set(match[1], match[2]);
    }
  } catch {
    // No engine registrations on this machine.
  }
  return out;
}

export async function resolveEngineRoot(root: string): Promise<string | null> {
  const uproject = readUproject(root);
  if (!uproject) return null;
  const association = uproject.association;
  if (!association) return null;
  if (/^\d/.test(association)) {
    const launcher = join(process.env.ProgramFiles ?? "C:\\Program Files", "Epic Games", `UE_${association}`);
    if (pathExists(launcher)) {
      writeCachedEngineRoot(root, launcher);
      return launcher;
    }
    const associated = await resolveAssociatedEngineInstall(association);
    if (associated && pathExists(associated)) {
      writeCachedEngineRoot(root, associated);
      return associated;
    }
    return readCachedEngineRoot(root);
  }
  if (process.platform !== "win32") {
    const associated = await resolveAssociatedEngineInstall(association);
    if (associated && pathExists(associated)) {
      writeCachedEngineRoot(root, associated);
      return associated;
    }
  }
  const registered = await registeredEngineRoots();
  // 1. Exact association name (the normal case).
  const exact = registered.get(association);
  if (exact && pathExists(exact)) {
    writeCachedEngineRoot(root, exact);
    return exact;
  }
  // 2. Remembered root — association names get renamed (GUID → friendly
  //    name) without the engine moving; the cache rides that out.
  const cached = readCachedEngineRoot(root);
  if (cached) return cached;
  // 3. Unique plausible candidate: exactly one registered root that looks
  //    like this project's engine (has Engine/Build/ and, ideally, our
  //    compile db).
  const candidates = [...registered.values()].filter(
    (dir) => pathExists(join(dir, "Engine", "Build")) || pathExists(join(dir, "compile_commands.json")),
  );
  const unique = candidates.length === 1 ? candidates[0]! : null;
  if (unique && pathExists(unique)) {
    writeCachedEngineRoot(root, unique);
    return unique;
  }
  // 4. Friendly-name fallback: the association may itself be the registry
  //    value name (e.g. "NBEngineUE5.7.4") — covered by step 1 already;
  //    lastly try version-suffixed names.
  const versionMatch = /^(\d+\.\d+)$/.exec(association);
  if (versionMatch) {
    for (const [name, dir] of registered) {
      if (name.endsWith(versionMatch[1]!) && pathExists(dir)) {
        writeCachedEngineRoot(root, dir);
        return dir;
      }
    }
  }
  return null;
}

export type CompileDbLocation = {
  compileCommandsDir: string;
  engineRoot: string | null;
};

/**
 * Find `compile_commands.json` for a UE workspace. UBT writes it to the
 * engine root (source builds) — the workspace root is checked first for
 * manually placed databases (CMake/other generators).
 */
export async function findCompileDb(root: string): Promise<CompileDbLocation | null> {
  if (pathExists(join(root, "compile_commands.json"))) {
    return { compileCommandsDir: root, engineRoot: null };
  }
  const engineRoot = await resolveEngineRoot(root);
  if (!engineRoot) return null;
  if (pathExists(join(engineRoot, "compile_commands.json"))) {
    return { compileCommandsDir: engineRoot, engineRoot };
  }
  // Launcher installs nest the database under Engine/.
  const nested = join(engineRoot, "Engine");
  if (pathExists(join(nested, "compile_commands.json"))) {
    return { compileCommandsDir: nested, engineRoot };
  }
  return null;
}
