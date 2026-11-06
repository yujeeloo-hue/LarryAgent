import { readFile, stat } from "node:fs/promises";
import {
  isSymbolIndexablePath,
  scanIndexSymbols,
} from "../../renderer/src/devmode/cppSymbolIndex.js";
import type { CppSymbolHit } from "./types.js";
import { CPP_SYMBOL_SCANNER_VERSION } from "./types.js";
import {
  clearCppSymbols,
  listIndexedPaths,
  readFileStamp,
  readScannerVersion,
  removeCppFileSymbols,
  replaceCppFileSymbols,
  writeScannerVersion,
  type CppSymbolDatabase,
  type FileStamp,
} from "./db.js";
import { enumerateCppFiles } from "./enumerate.js";
import { normalizeSymbolPath } from "./paths.js";

const UNLIMITED = Number.POSITIVE_INFINITY;

export type ScanProgress = { filesDone: number; filesTotal: number };

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function hitsFromText(text: string, path: string): CppSymbolHit[] {
  return scanIndexSymbols(stripBom(text), path, { maxSymbols: UNLIMITED });
}

async function stampOf(path: string): Promise<FileStamp | null> {
  try {
    const info = await stat(path);
    if (!info.isFile()) return null;
    return { mtimeMs: Math.round(info.mtimeMs), sizeBytes: info.size };
  } catch {
    return null;
  }
}

/** Read one C++ file and replace its rows. Missing files drop out of the index. */
export async function reindexCppFile(
  db: CppSymbolDatabase,
  path: string,
): Promise<void> {
  const norm = normalizeSymbolPath(path);
  if (!isSymbolIndexablePath(norm)) return;
  const stamp = await stampOf(norm);
  if (!stamp) {
    removeCppFileSymbols(db, norm);
    return;
  }
  let text: string;
  try {
    text = await readFile(norm, "utf8");
  } catch {
    removeCppFileSymbols(db, norm);
    return;
  }
  const hits = text.includes("\0") ? [] : hitsFromText(text, norm);
  replaceCppFileSymbols(db, norm, stamp, hits);
}

export async function scanCppSymbolDatabase(input: {
  db: CppSymbolDatabase;
  root: string;
  /**
   * Additional user-added scan roots (e.g. engine source directories). Each
   * scan covers the union of `root` + `extraRoots` and prunes rows that fall
   * outside it — removing a root here drops its symbols on the next scan.
   */
  extraRoots?: readonly string[];
  onProgress?: (progress: ScanProgress) => void;
  onTick?: () => Promise<void> | void;
  shouldStop?: () => boolean;
}): Promise<ScanProgress & { stopped: boolean }> {
  const version = readScannerVersion(input.db);
  if (version !== CPP_SYMBOL_SCANNER_VERSION) {
    clearCppSymbols(input.db);
    writeScannerVersion(input.db);
  }
  input.onProgress?.({ filesDone: 0, filesTotal: 0 });
  // Union across all roots — nested/overlapping roots enumerate some paths
  // twice, the Set dedupes them before stamp checks run.
  const live = new Set<string>();
  for (const scanRoot of [input.root, ...(input.extraRoots ?? [])]) {
    for (const path of await enumerateCppFiles(scanRoot, input.shouldStop)) {
      live.add(path);
    }
    if (input.shouldStop?.()) break;
  }
  const files = [...live];
  if (input.shouldStop?.()) {
    return { filesDone: 0, filesTotal: files.length, stopped: true };
  }
  for (const existing of listIndexedPaths(input.db)) {
    if (!live.has(existing)) removeCppFileSymbols(input.db, existing);
  }
  let filesDone = 0;
  let lastReport = 0;
  const report = (force: boolean): void => {
    const now = Date.now();
    if (!force && now - lastReport < 200) return;
    lastReport = now;
    input.onProgress?.({ filesDone, filesTotal: files.length });
  };
  report(true);
  for (const path of files) {
    await input.onTick?.();
    if (input.shouldStop?.()) {
      report(true);
      return { filesDone, filesTotal: files.length, stopped: true };
    }
    const stamp = await stampOf(path);
    const previous = readFileStamp(input.db, path);
    if (
      stamp &&
      previous &&
      previous.mtimeMs === stamp.mtimeMs &&
      previous.sizeBytes === stamp.sizeBytes
    ) {
      filesDone += 1;
      report(false);
      continue;
    }
    await reindexCppFile(input.db, path);
    filesDone += 1;
    report(false);
  }
  report(true);
  return { filesDone, filesTotal: files.length, stopped: false };
}
