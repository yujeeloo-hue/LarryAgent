import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export type SourceStaleness = {
  stale: boolean;
  newestPath: string | null;
  newestMtime: number;
  scannedFiles: number;
};

export const STALENESS_TOLERANCE_MS = 2_000;

const SKIP_DIRS = new Set([
  ".git",
  ".vs",
  ".vscode",
  "Binaries",
  "DerivedDataCache",
  "Intermediate",
  "node_modules",
  "Saved",
]);

const ROOT_DESCRIPTOR = /\.(uproject|build\.cs|target\.cs)$/i;

type Walk = {
  threshold: number;
  newestPath: string | null;
  newestMtime: number;
  scannedFiles: number;
};

async function checkFile(walk: Walk, path: string): Promise<void> {
  let info;
  try {
    info = await stat(path);
  } catch {
    return;
  }
  if (!info.isFile()) return;
  walk.scannedFiles += 1;
  if (info.mtimeMs >= walk.threshold && info.mtimeMs > walk.newestMtime) {
    walk.newestMtime = info.mtimeMs;
    walk.newestPath = path;
  }
}

async function walkDir(
  walk: Walk,
  dir: string,
  filesCount: boolean,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) return;
        const isSource = entry.name.toLowerCase() === "source";
        await walkDir(walk, path, filesCount || isSource);
        return;
      }
      if (!entry.isFile()) return;
      if (!filesCount) return;
      await checkFile(walk, path);
    }),
  );
}

async function walkRootFiles(walk: Walk, root: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  await Promise.all(
    entries.map(async (entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) return;
      if (!ROOT_DESCRIPTOR.test(entry.name)) return;
      await checkFile(walk, join(root, entry.name));
    }),
  );
}

export async function findSourceNewerThan(
  workspacePath: string,
  buildStartedAtMs: number,
): Promise<SourceStaleness> {
  const walk: Walk = {
    threshold: buildStartedAtMs - STALENESS_TOLERANCE_MS,
    newestPath: null,
    newestMtime: 0,
    scannedFiles: 0,
  };
  await Promise.all([
    walkDir(walk, join(workspacePath, "Source"), true),
    walkDir(walk, join(workspacePath, "Plugins"), false),
    walkDir(walk, join(workspacePath, "Build"), true),
    walkRootFiles(walk, workspacePath),
  ]);
  return {
    stale: walk.newestPath !== null,
    newestPath: walk.newestPath,
    newestMtime: walk.newestMtime,
    scannedFiles: walk.scannedFiles,
  };
}
