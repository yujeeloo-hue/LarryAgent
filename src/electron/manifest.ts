/**
 * Find an Electron app manifest the same way Unreal finds `.uproject`:
 * workspace root, then one and two directories down.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const SKIP = new Set([
  "engine",
  "unrealengine",
  "intermediate",
  "binaries",
  "saved",
  "content",
  "deriveddatacache",
  "node_modules",
  "dist",
  "out",
  "release",
  "build",
  "coverage",
  ".git",
  ".svn",
  ".larry",
]);

const VITE_CONFIG = /electron\.vite\.config\.(ts|mts|js|mjs|cjs)$/i;

export type ElectronRecipe = "electron-vite" | "electron";

export type ElectronManifestHit = {
  manifestPath: string;
  projectRoot: string;
  packageName: string;
  recipe: ElectronRecipe;
  main: string | null;
};

export type ElectronPackageJson = {
  name?: unknown;
  main?: unknown;
  scripts?: unknown;
  dependencies?: unknown;
  devDependencies?: unknown;
  peerDependencies?: unknown;
};

function listDir(dir: string): { files: string[]; dirs: string[] } | null {
  try {
    const files: string[] = [];
    const dirs: string[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isFile()) files.push(e.name);
      else if (e.isDirectory()) dirs.push(e.name);
    }
    return { files, dirs };
  } catch {
    return null;
  }
}

function depNames(pkg: ElectronPackageJson): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    for (const key of Object.keys(field)) names.add(key);
  }
  return names;
}

function scriptText(pkg: ElectronPackageJson): string {
  if (!pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)) {
    return "";
  }
  return Object.values(pkg.scripts)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
}

export function recipeFromPackage(
  pkg: ElectronPackageJson,
  files: string[],
): ElectronRecipe | null {
  const deps = depNames(pkg);
  const scripts = scriptText(pkg);
  const viteConfig = files.some((name) => VITE_CONFIG.test(name));
  const vite =
    deps.has("electron-vite") ||
    viteConfig ||
    /\belectron-vite\b/.test(scripts);
  if (vite) return "electron-vite";
  if (deps.has("electron")) return "electron";
  return null;
}

export function parseElectronPackage(
  dir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  files?: string[],
): ElectronManifestHit | null {
  const listing = files ? { files, dirs: [] as string[] } : listDir(dir);
  if (!listing?.files.some((name) => name.toLowerCase() === "package.json")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(join(dir, "package.json")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pkg = parsed as ElectronPackageJson;
  const recipe = recipeFromPackage(pkg, listing.files);
  if (!recipe) return null;
  const main = typeof pkg.main === "string" && pkg.main.trim() ? pkg.main.trim() : null;
  const packageName =
    typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "electron-app";
  return {
    manifestPath: join(dir, "package.json"),
    projectRoot: dir,
    packageName,
    recipe,
    main,
  };
}

export function findElectronManifest(
  workspaceRoot: string,
  readFile?: (path: string) => string,
): ElectronManifestHit | null {
  const atRoot = parseElectronPackage(workspaceRoot, readFile);
  if (atRoot) return atRoot;

  const listing = listDir(workspaceRoot);
  if (!listing) return null;
  for (const child of listing.dirs) {
    if (SKIP.has(child.toLowerCase()) || child.startsWith(".")) continue;
    const childDir = join(workspaceRoot, child);
    const hit = parseElectronPackage(childDir, readFile);
    if (hit) return hit;
    const nested = listDir(childDir);
    if (!nested) continue;
    for (const grand of nested.dirs) {
      if (SKIP.has(grand.toLowerCase()) || grand.startsWith(".")) continue;
      const deep = parseElectronPackage(join(childDir, grand), readFile);
      if (deep) return deep;
    }
  }
  return null;
}
