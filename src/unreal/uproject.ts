/**
 * Find a `.uproject` at the workspace root or one/two directories down
 * (NF is often opened at `Project.NF` while the file lives under SourceClient).
 */
import { readdirSync } from "node:fs";
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
  ".git",
  ".svn",
  ".larry",
]);

export type UprojectHit = {
  /** Absolute `.uproject` path. */
  uproject: string;
  /** Directory that contains it (game root). */
  projectRoot: string;
  /** Filename without extension. */
  baseName: string;
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

function hitFrom(dir: string, name: string): UprojectHit {
  const baseName = name.replace(/\.uproject$/i, "");
  return { uproject: join(dir, name), projectRoot: dir, baseName };
}

function firstUproject(dir: string): UprojectHit | null {
  const listing = listDir(dir);
  if (!listing) return null;
  const name = listing.files.find((n) => n.toLowerCase().endsWith(".uproject"));
  return name ? hitFrom(dir, name) : null;
}

export function findUproject(workspaceRoot: string): UprojectHit | null {
  const atRoot = firstUproject(workspaceRoot);
  if (atRoot) return atRoot;

  const listing = listDir(workspaceRoot);
  if (!listing) return null;
  for (const child of listing.dirs) {
    if (SKIP.has(child.toLowerCase()) || child.startsWith(".")) continue;
    const childDir = join(workspaceRoot, child);
    const hit = firstUproject(childDir);
    if (hit) return hit;
    const nested = listDir(childDir);
    if (!nested) continue;
    for (const grand of nested.dirs) {
      if (SKIP.has(grand.toLowerCase()) || grand.startsWith(".")) continue;
      const deep = firstUproject(join(childDir, grand));
      if (deep) return deep;
    }
  }
  return null;
}

/** All projects in the supported workspace layout, not just the first hit. */
export function findUprojects(workspaceRoot: string): UprojectHit[] {
  const out: UprojectHit[] = [];
  const visit = (dir: string, depth: number) => {
    const listing = listDir(dir);
    if (!listing) return;
    for (const name of listing.files) if (name.toLowerCase().endsWith(".uproject")) out.push(hitFrom(dir, name));
    if (depth === 2) return;
    for (const child of listing.dirs) if (!SKIP.has(child.toLowerCase()) && !child.startsWith(".")) visit(join(dir, child), depth + 1);
  };
  visit(workspaceRoot, 0);
  return out;
}
