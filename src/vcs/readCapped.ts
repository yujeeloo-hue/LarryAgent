/**
 * Bounded file reading for working-tree line stats.
 *
 * Both VCS layers count lines in unversioned / untracked files to build the
 * `+N / −M` badge. The obvious implementation — `readFile` then slice to a cap
 * — allocates the whole file first, so a working copy holding large untracked
 * assets pulls gigabytes through the main process on every refresh. Reading
 * through a handle keeps the allocation at the cap regardless of file size.
 */
import { open } from "node:fs/promises";

/** Bytes per file that actually get inspected. */
export const TEXT_READ_CAP = 512 * 1024;

export type CappedText = {
  text: string;
  truncated: boolean;
  binary: boolean;
} | null;

/**
 * First {@link TEXT_READ_CAP} bytes of a file as text. Returns null when the
 * path is unreadable, `binary: true` when the inspected slice holds a NUL.
 */
export async function readCappedText(absPath: string): Promise<CappedText> {
  let handle;
  try {
    handle = await open(absPath, "r");
    const info = await handle.stat();
    if (info.size === 0) return { text: "", truncated: false, binary: false };
    const want = Math.min(info.size, TEXT_READ_CAP);
    const buf = Buffer.allocUnsafe(want);
    const { bytesRead } = await handle.read(buf, 0, want, 0);
    if (bytesRead === 0) return { text: "", truncated: false, binary: false };
    const slice = bytesRead === want ? buf : buf.subarray(0, bytesRead);
    if (slice.includes(0)) return { text: "", truncated: false, binary: true };
    return {
      text: slice.toString("utf8"),
      truncated: info.size > TEXT_READ_CAP,
      binary: false,
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** Newline-separated line count (a trailing newline is not double-counted). */
export function countLinesIn(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  if (!text.endsWith("\n")) lines += 1;
  return lines;
}

/**
 * Lines in the inspected slice of a file. Null when unreadable or binary —
 * callers treat that as a single changed line.
 */
export async function countTextLines(absPath: string): Promise<number | null> {
  const result = await readCappedText(absPath);
  if (!result || result.binary) return null;
  return Math.max(countLinesIn(result.text), 1);
}

/** Files inspected precisely in one working-tree scan. */
export const SCAN_FILE_BUDGET = 512;
/** Bytes inspected precisely in one working-tree scan. */
export const SCAN_BYTE_BUDGET = 16 * 1024 * 1024;

/**
 * Ceiling on precise counting for a single working-tree scan.
 *
 * An unversioned directory in a game or engine working copy routinely holds
 * thousands of files and tens of gigabytes. Opening all of them to refine a
 * badge costs minutes of disk I/O per refresh, so past the budget a file is
 * counted as one line without being read.
 */
export type ScanBudget = {
  filesLeft: number;
  bytesLeft: number;
};

export function createScanBudget(): ScanBudget {
  return { filesLeft: SCAN_FILE_BUDGET, bytesLeft: SCAN_BYTE_BUDGET };
}

/**
 * Reserve one file against the budget. Returns false when the scan should stop
 * reading and fall back to approximate counting.
 */
export function claimScanBudget(budget: ScanBudget, size: number): boolean {
  if (budget.filesLeft <= 0 || budget.bytesLeft <= 0) return false;
  budget.filesLeft -= 1;
  budget.bytesLeft -= Math.min(Math.max(size, 0), TEXT_READ_CAP);
  return true;
}
