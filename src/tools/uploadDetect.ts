

export type RsyncProgressSample = {
  bytesSent: number;
  percent: number;
  speed: string;
  etaSeconds: number | null;
  filesTransferred: number | null;
  check: { done: number; total: number } | null;
};

const PROGRESS_RE =
  /^\s*([\d,.]+)\s+(\d+)%\s+([\d.]+[kKMGTP]?B\/s)\s+(\d+:\d{2}(?::\d{2})?)(?:\s*\(?(?:xfr|xfer)#(\d+)(?:,\s*(?:ir-chk|to-chk|to-check)=(\d+)\/(\d+))?\)?)?\s*$/;

const STARTING_RE = /^Transfer starting:\s*(\d+)\s+files?$/i;

export function parseRsyncStartingLine(line: string): number | null {
  const m = STARTING_RE.exec(line.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

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
  name: string;
  bytes: number;
  transferred: number;
};

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
