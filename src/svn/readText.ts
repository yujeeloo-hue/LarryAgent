import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

export {
  TEXT_READ_CAP,
  countLinesIn,
  countTextLines,
  readCappedText,
  type CappedText,
} from "../vcs/readCapped.js";

/** Cap files visited when expanding an unversioned directory. */
const UNVERSIONED_DIR_FILE_CAP = 2000;

export type ScannedFile = {
  abs: string;
  /** Size on disk, so callers can budget reads without a second stat. */
  size: number;
};

/** Recursive directory walk capped at UNVERSIONED_DIR_FILE_CAP files. */
export async function listFilesUnder(
  dirAbsPath: string,
  cap = UNVERSIONED_DIR_FILE_CAP,
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];
  const queue: string[] = [dirAbsPath];

  while (queue.length > 0 && files.length < cap) {
    const dir = queue.shift()!;
    let entries;
    try {
      // Dirents classify entries without a stat each; only files below need
      // one, and only for their size.
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === ".svn" || entry.name === ".git") continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      let size = 0;
      try {
        size = (await stat(abs)).size;
      } catch {
        continue;
      }
      files.push({ abs, size });
      if (files.length >= cap) break;
    }
  }
  return files;
}
