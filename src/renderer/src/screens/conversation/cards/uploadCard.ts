/**
 * Renderer-side upload card logic: narrowing of tool_live "upload" payloads,
 * finished-result parsing and display formatting. Pure functions — DOM lives
 * in uploadCardView.ts. The upload entry point is the dedicated upload_files
 * tool (structured args); output parsing is shared with the main process
 * via tools/uploadDetect.ts.
 */

import {
  parseRsyncFileLine,
  parseRsyncProgressLine,
} from "../../../../../tools/uploadDetect.js";

/** File rows kept on the card (live + finished); the list scrolls past ~5. */
export const UPLOAD_FILE_LIST_CAP = 40;

/** Card-level info distilled from upload_files arguments. */
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

/**
 * Detect an upload_files invocation from (toolName, args). Returns the
 * card info (src/dest/excludes/envAtRisk) or null for every other tool.
 */
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

/** Initial connecting-phase state seeded from the tool arguments. */
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

/** Narrow an opaque tool_live payload into UploadLiveState (null when junk). */
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

export type UploadFinishedStats = {
  /** Total transferred files (xfr#) or, failing that, counted file lines. */
  files: number | null;
  /** Final transferred byte count from the last progress2 line. */
  bytes: number | null;
  /** Wall-clock seconds from the handler's `elapsed X.Xs` line. */
  elapsedSec: number | null;
  /** The final progress2 snapshot line (raw tail display). */
  finalLine: string | null;
  /** `--out-format=%n|%b` lines (most recent first is up to the caller). */
  fileLines: UploadLiveFile[];
  /** Last non-empty stderr lines (error display; max 2). */
  stderrTail: string[];
};

/** Parse the run_shell upload result body (model-facing text) into stats. */
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

/** Decimal byte formatting consistent with rsync's own rate display. */
export function formatUploadBytes(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${(bytes / 1e6).toFixed(1)} MB`;
  if (bytes >= 1e3) return `${(bytes / 1e3).toFixed(1)} KB`;
  return `${Math.round(bytes)} B`;
}

/** Compact ETA ("9s" / "1m02s") for the live readout line. */
export function formatUploadEta(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds)) return "–";
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m${String(s).padStart(2, "0")}s`;
}
