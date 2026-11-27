import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { globToRegExp, isGlobPattern } from "./glob.js";

export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  "out",
  "dist",
  "release",
  "coverage",
  "demos",
  ".jellybot",
  ".larry",
  ".claude",
  ".cursor",
  ".run",
]);

export const IGNORED_PATHS: readonly string[] = ["relay/public", "site/assets"];

export function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

export function toRelativePath(root: string, path: string): string {
  const rootPosix = normalizePath(resolve(root)).replace(/\/+$/, "");
  const candidate = normalizePath(path);
  if (candidate === rootPosix) return "";
  return candidate.startsWith(`${rootPosix}/`) ? candidate.slice(rootPosix.length + 1) : candidate;
}

async function walk(root: string, rel: string, out: string[]): Promise<void> {
  const dir = rel ? join(root, rel) : root;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (entry.name.startsWith(".")) continue;
      if (IGNORED_DIRS.has(entry.name)) continue;
      if (IGNORED_PATHS.includes(childRel)) continue;
      await walk(root, childRel, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.startsWith(".")) continue;
    out.push(childRel);
  }
}

export async function collectWorkspaceFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, "", files);
  return files.sort();
}

export function createFileReader(root: string): (path: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (path: string) => {
    const key = toRelativePath(root, path);
    const cached = cache.get(key);
    if (cached) return cached;
    const pending = readFile(join(root, key), "utf8");
    cache.set(key, pending);
    return pending;
  };
}

export type TargetSelection = {
  files: string[];
  missing: string[];
};

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

export async function selectFiles(
  root: string,
  available: readonly string[],
  targets: readonly string[],
): Promise<TargetSelection> {
  const picked = new Set<string>();
  const missing: string[] = [];
  const known = new Set(available);
  for (const raw of targets) {
    const target = toRelativePath(root, raw).replace(/\/+$/, "");
    if (!target || target === ".") {
      for (const file of available) picked.add(file);
      continue;
    }
    if (isGlobPattern(target)) {
      const matcher = globToRegExp(target);
      const hits = available.filter((file) => matcher.test(file));
      if (hits.length === 0) missing.push(raw);
      for (const hit of hits) picked.add(hit);
      continue;
    }
    if (known.has(target)) {
      picked.add(target);
      continue;
    }
    const prefix = `${target}/`;
    const under = available.filter((file) => file.startsWith(prefix));
    if (under.length > 0) {
      for (const file of under) picked.add(file);
      continue;
    }
    if (await isFile(join(root, target))) {
      picked.add(target);
      continue;
    }
    missing.push(raw);
  }
  return { files: [...picked].sort(), missing };
}
