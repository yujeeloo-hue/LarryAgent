
import { execFile } from "node:child_process";
import { accessSync, constants, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { resolveAssociatedEngineInstall } from "../../unreal/engineRoot.js";

const execFileAsync = promisify(execFile);

export function pathExists(path: string): boolean {
  try {
    accessSync(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export function darwinClangdCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const fromDev = env.DEVELOPER_DIR ? join(env.DEVELOPER_DIR, "usr", "bin", "clangd") : "";
  return [
    fromDev,
    "/opt/homebrew/opt/llvm/bin/clangd",
    "/usr/local/opt/llvm/bin/clangd",
    "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clangd",
    "/opt/homebrew/bin/clangd",
    "/usr/local/bin/clangd",
    "/usr/bin/clangd",
  ].filter((path) => path.length > 0);
}

function pathEntries(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? "";
  return raw.split(delimiter).map((dir) => dir.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

function legacyAppClangds(env: NodeJS.ProcessEnv): string[] {
  if (!env.LOCALAPPDATA) return [];
  const toolsRoot = join(env.LOCALAPPDATA, "JellyBot", "tools", "clangd");
  try {
    return readdirSync(toolsRoot)
      .sort()
      .reverse()
      .map((entry) => join(toolsRoot, entry, "bin", "clangd.exe"));
  } catch {
    return [];
  }
}

export function clangdCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const candidates: string[] = [];
  if (env.JB_CLANGD_PATH) candidates.push(env.JB_CLANGD_PATH);
  if (platform === "win32") {
    candidates.push(join(env.ProgramFiles ?? "C:\\Program Files", "LLVM", "bin", "clangd.exe"));
    candidates.push(...pathEntries(env).map((dir) => join(dir, "clangd.exe")));
    candidates.push(...legacyAppClangds(env));
  } else {
    if (platform === "darwin") candidates.push(...darwinClangdCandidates(env));
    candidates.push(...pathEntries(env).map((dir) => join(dir, "clangd")));
  }
  return [...new Set(candidates)];
}

export function findClangdBinary(): string | null {
  for (const candidate of clangdCandidates()) {
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

export type UprojectInfo = {
  path: string;
  association: string;
};

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
  }
  return { path, association };
}

const REG_BUILDS_KEY = "HKCU\\Software\\Epic Games\\Unreal Engine\\Builds";

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
  }
}

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
  const exact = registered.get(association);
  if (exact && pathExists(exact)) {
    writeCachedEngineRoot(root, exact);
    return exact;
  }
  const cached = readCachedEngineRoot(root);
  if (cached) return cached;
  const candidates = [...registered.values()].filter(
    (dir) => pathExists(join(dir, "Engine", "Build")) || pathExists(join(dir, "compile_commands.json")),
  );
  const unique = candidates.length === 1 ? candidates[0]! : null;
  if (unique && pathExists(unique)) {
    writeCachedEngineRoot(root, unique);
    return unique;
  }
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

export async function findCompileDb(
  root: string,
  options: { skipProjectDb?: boolean } = {},
): Promise<CompileDbLocation | null> {
  const uproject = readUproject(root);
  const projectDb = join(root, ".jellybot");
  if (pathExists(join(root, "compile_commands.json"))) {
    return { compileCommandsDir: root, engineRoot: uproject ? await resolveEngineRoot(root) : null };
  }
  if (!options.skipProjectDb && pathExists(join(projectDb, "compile_commands.json"))) {
    return { compileCommandsDir: projectDb, engineRoot: await resolveEngineRoot(root) };
  }
  const engineRoot = await resolveEngineRoot(root);
  if (!engineRoot) return null;
  if (pathExists(join(engineRoot, "compile_commands.json"))) {
    return { compileCommandsDir: engineRoot, engineRoot };
  }
  const nested = join(engineRoot, "Engine");
  if (pathExists(join(nested, "compile_commands.json"))) {
    return { compileCommandsDir: nested, engineRoot };
  }
  return null;
}
