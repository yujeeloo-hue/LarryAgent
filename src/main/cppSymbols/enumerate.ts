import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  isSymbolIndexablePath,
  isSkippedSymbolDir,
} from "../../renderer/src/devmode/cppSymbolIndex.js";
import { normalizeSymbolPath } from "./paths.js";

// The skip list itself lives in the shared renderer module so the file tree
// can answer "is this directory already indexed?" with the same rules.
export { isSkippedSymbolDir };

/**
 * Absolute indexable paths (C++ / TS / JS / CSS) under `root` (forward
 * slashes). Stops early when `shouldStop` flips, returning whatever was
 * collected so far. The root's own name is never checked — an `Engine`
 * directory passed as an explicit scan root is walked; only its children are
 * filtered.
 */
export async function enumerateCppFiles(
  root: string,
  shouldStop?: () => boolean,
): Promise<string[]> {
  const start = normalizeSymbolPath(root);
  const out: string[] = [];
  const queue: string[] = [start];
  while (queue.length > 0) {
    if (shouldStop?.()) break;
    const dir = queue.pop()!;
    let dirents;
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirents) {
      const abs = normalizeSymbolPath(join(dir, entry.name));
      if (entry.isDirectory()) {
        if (isSkippedSymbolDir(entry.name)) continue;
        queue.push(abs);
      } else if (entry.isFile() && isSymbolIndexablePath(abs)) {
        out.push(abs);
      }
    }
  }
  return out;
}
