/**
 * clangd warm-up status for the editor status bar: server start, per-file
 * preamble / main-file builds, and the background index — folded from
 * `clangd:progress` events into one English line.
 *
 * Preamble builds report no percentage, so the line shows elapsed time and
 * the owner ticks it every second while `clangdProgressNeedsTick` is true.
 */

export type ClangdProgressEvent =
  | { phase: "indexing" | "idle"; percent?: number; message?: string }
  | { phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready"; message?: string }
  | { phase: "file"; path: string; state: "preamble" | "parsing" | "idle" };

type FileBuild = { state: "preamble" | "parsing"; since: number; path: string };

export type ClangdProgressState = {
  startingSince: number | null;
  /** On-disk index shards → memory after start (no percentage from clangd). */
  indexLoadingSince: number | null;
  files: Map<string, FileBuild>;
  index: { percent?: number; message?: string } | null;
};

export function createClangdProgressState(): ClangdProgressState {
  return { startingSince: null, indexLoadingSince: null, files: new Map(), index: null };
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Fold one event into `state` (mutates). */
export function applyClangdProgress(
  state: ClangdProgressState,
  event: ClangdProgressEvent,
  now: number,
): void {
  switch (event.phase) {
    case "starting":
      state.startingSince = now;
      state.indexLoadingSince = null;
      state.files.clear();
      state.index = null;
      return;
    case "ready":
      state.startingSince = null;
      return;
    case "failed":
      state.startingSince = null;
      state.indexLoadingSince = null;
      state.files.clear();
      state.index = null;
      return;
    case "index_loading":
      state.indexLoadingSince = now;
      return;
    case "index_ready":
      state.indexLoadingSince = null;
      return;
    case "indexing":
      state.index = {
        ...(event.percent !== undefined ? { percent: event.percent } : {}),
        ...(event.message ? { message: event.message } : {}),
      };
      return;
    case "idle":
      state.index = null;
      return;
    case "file": {
      const key = pathKey(event.path);
      if (event.state === "idle") {
        state.files.delete(key);
        return;
      }
      const prev = state.files.get(key);
      // Keep the clock running across repeated reports of the same state.
      if (prev?.state === event.state) return;
      state.files.set(key, { state: event.state, since: now, path: event.path });
      return;
    }
  }
}

export function clangdProgressNeedsTick(state: ClangdProgressState): boolean {
  return state.startingSince !== null || state.indexLoadingSince !== null || state.files.size > 0;
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  return `${minutes}m ${String(total % 60).padStart(2, "0")}s`;
}

function baseName(path: string): string {
  const norm = path.replace(/\\/g, "/");
  return norm.slice(norm.lastIndexOf("/") + 1);
}

/**
 * One status line, most actionable first:
 * `clangd: building preamble NFCharacter.cpp 12s · index 34% 1200/3500`.
 * The active editor file wins when several files build at once.
 */
export function formatClangdProgress(
  state: ClangdProgressState,
  now: number,
  activePath?: string | null,
): string {
  const parts: string[] = [];
  if (state.startingSince !== null) {
    parts.push(`clangd: starting… ${formatElapsed(now - state.startingSince)}`);
  } else if (state.indexLoadingSince !== null) {
    parts.push(`clangd: loading index… ${formatElapsed(now - state.indexLoadingSince)}`);
  }
  if (state.files.size > 0) {
    const activeKey = activePath ? pathKey(activePath) : null;
    const entries = [...state.files.entries()];
    const [, build] =
      entries.find(([k]) => k === activeKey) ??
      entries.reduce((a, b) => (b[1].since > a[1].since ? b : a));
    const verb = build.state === "preamble" ? "building preamble" : "parsing";
    const more = entries.length > 1 ? ` (+${entries.length - 1})` : "";
    parts.push(`clangd: ${verb} ${baseName(build.path)} ${formatElapsed(now - build.since)}${more}`);
  }
  if (state.index) {
    const pct = state.index.percent !== undefined ? ` ${state.index.percent}%` : "";
    const msg = state.index.message ? ` ${state.index.message}` : "";
    parts.push(`clangd index${pct}${msg}`);
  }
  return parts.join(" · ");
}
