/**
 * rsync live-output parsing (pure functions, shared by the upload_files
 * tool handler in the main process and by the renderer's upload card).
 *
 * Parses the lines emitted by the enhanced rsync invocation
 * (--info=progress2 / --progress + --out-format=%n|%b|%l) into typed
 * samples for the live upload card, and collapses the -rewritten
 * progress runs for the finished result text.
 */


export type RsyncProgressSample = {
  /** Bytes transferred so far (from the progress2 counter). */
  bytesSent: number;
  /** Integer percent (0–100). */
  percent: number;
  /** Human transfer rate as printed, e.g. "4.90MB/s". */
  speed: string;
  /** ETA in seconds, parsed from h:mm:ss / mm:ss. */
  etaSeconds: number | null;
  /** Files transferred so far (xfr#N). */
  filesTransferred: number | null;
  /** Incremental-recursion check counters (ir-chk / to-chk). */
  check: { done: number; total: number } | null;
};

// Speed unit class: GNU rsync prints "kB/s" (lowercase k); openrsync —
// stock macOS rsync — prints "KB/s" (uppercase K). Both must parse.
const PROGRESS_RE =
  /^\s*([\d,.]+)\s+(\d+)%\s+([\d.]+[kKMGTP]?B\/s)\s+(\d+:\d{2}(?::\d{2})?)(?:\s*\(?(?:xfr|xfer)#(\d+)(?:,\s*(?:ir-chk|to-chk|to-check)=(\d+)\/(\d+))?\)?)?\s*$/;

/**
 * openrsync (stock macOS rsync) prints this once after the file scan —
 * the earliest signal for the total file count.
 */
const STARTING_RE = /^Transfer starting:\s*(\d+)\s+files?$/i;

/** Parse openrsync's `Transfer starting: N files` line → N (else null). */
export function parseRsyncStartingLine(line: string): number | null {
  const m = STARTING_RE.exec(line.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse one rsync `--info=progress2` snapshot line, e.g.
 * `      1,234,567  45%  1.20MB/s    0:00:12`
 * `44,878,387 100%  4.90MB/s    0:00:09 (xfr#214, to-chk=0/2589)`
 */
export function parseRsyncProgressLine(line: string): RsyncProgressSample | null {
  const m = PROGRESS_RE.exec(line);
  if (!m) return null;
  const bytesSent = Number((m[1] ?? "").replace(/,/g, ""));
  const percent = Number(m[2]);
  if (!Number.isFinite(bytesSent) || !Number.isFinite(percent)) return null;
  const parts = (m[4] ?? "")
    .split(":")
    .map(Number)
    .filter((n) => Number.isFinite(n));
  const etaSeconds =
    parts.length === 3
      ? (parts[0] ?? 0) * 3600 + (parts[1] ?? 0) * 60 + (parts[2] ?? 0)
      : parts.length === 2
        ? (parts[0] ?? 0) * 60 + (parts[1] ?? 0)
        : null;
  return {
    bytesSent,
    percent,
    speed: m[3] ?? "",
    etaSeconds,
    filesTransferred: m[5] !== undefined ? Number(m[5]) : null,
    check:
      m[6] !== undefined && m[7] !== undefined
        ? { done: Number(m[6]), total: Number(m[7]) }
        : null,
  };
}

export type RsyncFileEvent = {
  /** File path as rsync printed it (%n). */
  name: string;
  /** File length (%l) — what the UI shows. */
  bytes: number;
  /** Bytes actually transferred (%b; protocol overhead included). */
  transferred: number;
};

/**
 * One `--out-format=%n|%b|%l` file-done line. Falls back to the 2-segment
 * `%n|%b` shape for older formats (bytes used for display then).
 */
export function parseRsyncFileLine(line: string): RsyncFileEvent | null {
  const trimmed = line.trim();
  let m = /^(.+)\|(\d+)\|(\d+)$/.exec(trimmed);
  if (m && m[1] !== undefined) {
    const transferred = Number(m[2]);
    const bytes = Number(m[3]);
    if (!Number.isFinite(transferred) || !Number.isFinite(bytes)) return null;
    return { name: m[1], bytes, transferred };
  }
  m = /^(.+)\|(\d+)$/.exec(trimmed);
  const name = m?.[1];
  if (!m || name === undefined) return null;
  const bytes = Number(m[2]);
  if (!Number.isFinite(bytes)) return null;
  return { name, bytes, transferred: bytes };
}

/**
 * Collapse `\r`-rewritten progress2 runs (the terminal progress line is
 * reprinted with \r hundreds of times) into their final snapshot, keeping
 * the model-facing stdout readable. Non-progress lines pass through.
 */
export function collapseProgressLines(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => {
      if (!line.includes("\r")) return line;
      const segments = line.split("\r");
      const progressLike = segments.filter((s) => parseRsyncProgressLine(s) !== null);
      const lastProgress = progressLike[progressLike.length - 1];
      if (lastProgress !== undefined) return lastProgress.trim();
      return segments[segments.length - 1] ?? "";
    })
    .join("\n");
}
