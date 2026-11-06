/**
 * Find a Node web app (server + page) the same way Electron finds package.json.
 * Unreal / Electron workspaces are not web — callers skip those first.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recipeFromPackage, type ElectronPackageJson } from "../electron/manifest.js";

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

const WEB_DEPS = new Set([
  "express",
  "koa",
  "fastify",
  "hono",
  "connect",
  "restify",
  "@nestjs/core",
  "next",
  "nuxt",
  "vite",
  "webpack",
  "webpack-dev-server",
  "@remix-run/node",
  "astro",
  "@sveltejs/kit",
  "react-scripts",
  "@angular/core",
  "vue",
]);

/** Prefer named server scripts, then `dev` (Vite/Next), then `start`. */
const SCRIPT_PRIORITY = [
  "debug:server",
  "debug:backend",
  "dev:server",
  "start:server",
  "server",
  "backend",
  "dev",
  "start",
] as const;

const SERVER_FILE = /^(server|app|index|main)\.(js|mjs|cjs|ts)$/i;
const WEB_DIR = new Set([
  "server",
  "backend",
  "api",
  "client",
  "frontend",
  "web",
  "public",
]);

export type WebManifestHit = {
  manifestPath: string;
  projectRoot: string;
  packageName: string;
  script: string | null;
};

export type WebPackageJson = ElectronPackageJson;

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

function depNames(pkg: WebPackageJson): Set<string> {
  const names = new Set<string>();
  for (const field of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies]) {
    if (!field || typeof field !== "object" || Array.isArray(field)) continue;
    for (const key of Object.keys(field)) names.add(key);
  }
  return names;
}

function scriptMap(pkg: WebPackageJson): Record<string, string> {
  if (!pkg.scripts || typeof pkg.scripts !== "object" || Array.isArray(pkg.scripts)) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(pkg.scripts)) {
    if (typeof value === "string" && value.trim()) out[name] = value.trim();
  }
  return out;
}

export function pickServerScript(scripts: Record<string, string>): string | null {
  for (const name of SCRIPT_PRIORITY) {
    if (scripts[name]) return name;
  }
  return null;
}

export function isWebPackage(
  pkg: WebPackageJson,
  files: string[],
  dirs: string[] = [],
): boolean {
  if (recipeFromPackage(pkg, files)) return false;
  const deps = depNames(pkg);
  if ([...deps].some((name) => WEB_DEPS.has(name))) return true;
  const scripts = scriptMap(pkg);
  const scriptText = Object.values(scripts).join("\n");
  if (/\b(express|vite|next|nuxt|nodemon|tsx|ts-node|fastify|koa)\b/.test(scriptText)) {
    return true;
  }
  if (files.some((name) => name.toLowerCase() === "index.html")) return true;
  if (files.some((name) => SERVER_FILE.test(name))) return true;
  if (dirs.some((name) => WEB_DIR.has(name.toLowerCase()))) {
    return pickServerScript(scripts) !== null || Object.keys(scripts).length > 0;
  }
  return false;
}

export function parseWebPackage(
  dir: string,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
  listing?: { files: string[]; dirs: string[] },
): WebManifestHit | null {
  const listed = listing ?? listDir(dir);
  if (!listed?.files.some((name) => name.toLowerCase() === "package.json")) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFile(join(dir, "package.json")).replace(/^\uFEFF/, ""));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const pkg = parsed as WebPackageJson;
  if (!isWebPackage(pkg, listed.files, listed.dirs)) return null;
  const scripts = scriptMap(pkg);
  const packageName =
    typeof pkg.name === "string" && pkg.name.trim() ? pkg.name.trim() : "web-app";
  return {
    manifestPath: join(dir, "package.json"),
    projectRoot: dir,
    packageName,
    script: pickServerScript(scripts),
  };
}

export function findWebManifest(
  workspaceRoot: string,
  readFile?: (path: string) => string,
): WebManifestHit | null {
  const atRoot = parseWebPackage(workspaceRoot, readFile);
  if (atRoot) return atRoot;

  const listing = listDir(workspaceRoot);
  if (!listing) return null;
  for (const child of listing.dirs) {
    if (SKIP.has(child.toLowerCase()) || child.startsWith(".")) continue;
    const childDir = join(workspaceRoot, child);
    const hit = parseWebPackage(childDir, readFile);
    if (hit) return hit;
    const nested = listDir(childDir);
    if (!nested) continue;
    for (const grand of nested.dirs) {
      if (SKIP.has(grand.toLowerCase()) || grand.startsWith(".")) continue;
      const deep = parseWebPackage(join(childDir, grand), readFile);
      if (deep) return deep;
    }
  }
  return null;
}
