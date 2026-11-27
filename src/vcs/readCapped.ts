import { open } from "node:fs/promises";

export const TEXT_READ_CAP = 512 * 1024;

export type CappedText = {
  text: string;
  truncated: boolean;
  binary: boolean;
} | null;

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

export function countLinesIn(text: string): number {
  if (!text) return 0;
  let lines = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  if (!text.endsWith("\n")) lines += 1;
  return lines;
}

export async function countTextLines(absPath: string): Promise<number | null> {
  const result = await readCappedText(absPath);
  if (!result || result.binary) return null;
  return Math.max(countLinesIn(result.text), 1);
}

export const SCAN_FILE_BUDGET = 512;
export const SCAN_BYTE_BUDGET = 16 * 1024 * 1024;

export type ScanBudget = {
  filesLeft: number;
  bytesLeft: number;
};

export function createScanBudget(): ScanBudget {
  return { filesLeft: SCAN_FILE_BUDGET, bytesLeft: SCAN_BYTE_BUDGET };
}

export function claimScanBudget(budget: ScanBudget, size: number): boolean {
  if (budget.filesLeft <= 0 || budget.bytesLeft <= 0) return false;
  budget.filesLeft -= 1;
  budget.bytesLeft -= Math.min(Math.max(size, 0), TEXT_READ_CAP);
  return true;
}
