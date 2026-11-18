
export const UPLOAD_FILE_LIST_CAP = 40;

export type UploadCardInfo = {
  src: string;
  dest: string;
  excludes: string[];
  envAtRisk?: boolean;
};

export type UploadLiveFile = { name: string; bytes: number };

export type UploadLiveState = {
  phase: "connecting" | "transferring" | "done";
  src: string;
  dest: string;
  excludes: string[];
  envAtRisk?: boolean;
  percent?: number;
  bytesSent?: number;
  bytesTotal?: number;
  speed?: string;
  etaSeconds?: number | null;
  filesDone: number;
  filesTotal?: number;
  recentFiles: UploadLiveFile[];
};

export function uploadInfoFromTool(name: string, args: unknown): UploadCardInfo | null {
  if (name !== "upload_files") return null;
  const a = args as { src?: unknown; dest_host?: unknown; dest_path?: unknown; excludes?: unknown } | null;
  if (
    !a ||
    typeof a.src !== "string" ||
    typeof a.dest_host !== "string" ||
    typeof a.dest_path !== "string"
  ) {
    return null;
  }
  const excludes = Array.isArray(a.excludes)
    ? a.excludes.filter((e): e is string => typeof e === "string")
    : [];
  return { src: a.src, dest: `${a.dest_host}:${a.dest_path}`, excludes };
}

export function seedUploadLive(info: UploadCardInfo): UploadLiveState {
  return {
    phase: "connecting",
    src: info.src,
    dest: info.dest,
    excludes: info.excludes,
    ...(info.envAtRisk ? { envAtRisk: true } : {}),
    filesDone: 0,
    recentFiles: [],
  };
}

export function uploadLiveFromPayload(payload: unknown): UploadLiveState | null {
  if (payload === null || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  const phase = o.phase === "transferring" || o.phase === "done" ? o.phase : "connecting";
  const recentFiles: UploadLiveFile[] = Array.isArray(o.recentFiles)
    ? o.recentFiles
        .filter(
          (f): f is UploadLiveFile =>
            f !== null &&
            typeof f === "object" &&
            typeof (f as UploadLiveFile).name === "string" &&
            typeof (f as UploadLiveFile).bytes === "number",
        )
        .slice(-40)
    : [];
  return {
    phase,
    src: typeof o.src === "string" ? o.src : "",
    dest: typeof o.dest === "string" ? o.dest : "",
    excludes: Array.isArray(o.excludes)
      ? o.excludes.filter((e): e is string => typeof e === "string")
      : [],
    ...(o.envAtRisk === true ? { envAtRisk: true } : {}),
    ...(typeof o.percent === "number" ? { percent: o.percent } : {}),
    ...(typeof o.bytesSent === "number" ? { bytesSent: o.bytesSent } : {}),
    ...(typeof o.bytesTotal === "number" ? { bytesTotal: o.bytesTotal } : {}),
    ...(typeof o.speed === "string" ? { speed: o.speed } : {}),
    ...(typeof o.etaSeconds === "number" || o.etaSeconds === null
      ? { etaSeconds: o.etaSeconds as number | null }
      : {}),
    filesDone: typeof o.filesDone === "number" ? o.filesDone : 0,
    ...(typeof o.filesTotal === "number" ? { filesTotal: o.filesTotal } : {}),
    recentFiles,
  };
}


export type RsyncProgressSample = {
  bytesSent: number;
  percent: number;
  speed: string;
  etaSeconds: number | null;
  filesTransferred: number | null;
};

const PROGRESS_RE =
  /^\s*([\d,.]+)\s+(\d+)%\s+([\d.]+[kMGTP]?B\/s)\s+(\d+:\d{2}(?::\d{2})?)(?:\s*\(?(?:xfr|xfer)#(\d+)(?:,\s*(?:ir-chk|to-chk|to-check)=(\d+)\/(\d+))?\)?)?\s*$/;

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
  };
}

export function parseRsyncFileLine(line: string): { name: string; bytes: number } | null {
  const trimmed = line.trim();
  let m = /^(.+)\|(\d+)\|(\d+)$/.exec(trimmed);
  if (m && m[1] !== undefined) {
    const transferred = Number(m[2]);
    const bytes = Number(m[3]);
    if (!Number.isFinite(transferred) || !Number.isFinite(bytes)) return null;
    return { name: m[1], bytes };
  }
  m = /^(.+)\|(\d+)$/.exec(trimmed);
  const name = m?.[1];
  if (!m || name === undefined) return null;
  const bytes = Number(m[2]);
  if (!Number.isFinite(bytes)) return null;
  return { name, bytes };
}


export type UploadFinishedStats = {
  files: number | null;
  bytes: number | null;
  elapsedSec: number | null;
  finalLine: string | null;
  fileLines: UploadLiveFile[];
  stderrTail: string[];
};

export function parseUploadFinished(resultText: string): UploadFinishedStats {
  let files: number | null = null;
  let bytes: number | null = null;
  let elapsedSec: number | null = null;
  let finalLine: string | null = null;
  const fileLines: UploadLiveFile[] = [];
  const stderrTail: string[] = [];
  let inStderr = false;

  for (const raw of resultText.split("\n")) {
    const line = raw.trim();
    if (line === "--- stderr ---") {
      inStderr = true;
      continue;
    }
    if (line === "--- stdout ---") {
      inStderr = false;
      continue;
    }
    if (inStderr) {
      if (line) {
        stderrTail.push(line);
        if (stderrTail.length > 2) stderrTail.shift();
      }
      continue;
    }
    const elapsed = /^elapsed (\d+(?:\.\d+)?)s$/.exec(line);
    if (elapsed) {
      elapsedSec = Number(elapsed[1]);
      continue;
    }
    const progress = parseRsyncProgressLine(line);
    if (progress) {
      bytes = progress.bytesSent;
      if (progress.filesTransferred !== null) files = progress.filesTransferred;
      finalLine = line;
      continue;
    }
    const file = parseRsyncFileLine(line);
    if (file) {
      fileLines.push({ name: file.name, bytes: file.bytes });
      if (fileLines.length > UPLOAD_FILE_LIST_CAP) fileLines.shift();
    }
  }
  if (files === null && fileLines.length > 0) files = fileLines.length;
  return { files, bytes, elapsedSec, finalLine, fileLines, stderrTail };
}

export function formatUploadBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

export function formatUploadEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
