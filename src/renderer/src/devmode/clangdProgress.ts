
export type ClangdProgressEvent =
  | { phase: "indexing_speed"; speed: "normal" | "full" }
  | { phase: "indexing" | "idle"; percent?: number; message?: string }
  | { phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready" | "generating"; message?: string }
  | { phase: "file"; path: string; state: "preamble" | "parsing" | "idle" };

type FileBuild = { state: "preamble" | "parsing"; since: number; path: string };

export type ClangdProgressState = {
  indexingSpeed: "normal" | "full";
  startingSince: number | null;
  generatingSince: number | null;
  generatingMessage: string | null;
  indexLoadingSince: number | null;
  files: Map<string, FileBuild>;
  index: { percent?: number; message?: string } | null;
};

export function createClangdProgressState(): ClangdProgressState {
  return { indexingSpeed: "normal", startingSince: null, generatingSince: null, generatingMessage: null, indexLoadingSince: null, files: new Map(), index: null };
}

function pathKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function applyClangdProgress(
  state: ClangdProgressState,
  event: ClangdProgressEvent,
  now: number,
): void {
  switch (event.phase) {
    case "indexing_speed":
      state.indexingSpeed = event.speed;
      return;
    case "generating":
      if (state.generatingSince === null) state.generatingSince = now;
      state.generatingMessage = event.message ?? state.generatingMessage;
      return;
    case "starting":
      state.generatingSince = null;
      state.generatingMessage = null;
      state.startingSince = now;
      state.indexLoadingSince = null;
      state.files.clear();
      state.index = null;
      return;
    case "ready":
      state.generatingSince = null;
      state.generatingMessage = null;
      state.startingSince = null;
      return;
    case "failed":
      state.generatingSince = null;
      state.generatingMessage = null;
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
      if (prev?.state === event.state) return;
      state.files.set(key, { state: event.state, since: now, path: event.path });
      return;
    }
  }
}

export function clangdProgressNeedsTick(state: ClangdProgressState): boolean {
  return state.startingSince !== null || state.generatingSince !== null || state.indexLoadingSince !== null || state.files.size > 0;
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

export type ClangdProgressPart = { key: string; text: string };

export function formatClangdProgressParts(
  state: ClangdProgressState,
  now: number,
  activePath?: string | null,
): ClangdProgressPart[] {
  const parts: ClangdProgressPart[] = [];
  if (state.generatingSince !== null) {
    const detail = state.generatingMessage ? ` (${state.generatingMessage})` : "";
    parts.push({
      key: "generating",
      text: `clangd: generating compile database… ${formatElapsed(now - state.generatingSince)}${detail}`,
    });
  } else if (state.startingSince !== null) {
    parts.push({
      key: "starting",
      text: `clangd: starting… ${formatElapsed(now - state.startingSince)}`,
    });
  } else if (state.indexLoadingSince !== null) {
    parts.push({
      key: "index-loading",
      text: `clangd: loading index… ${formatElapsed(now - state.indexLoadingSince)}`,
    });
  }
  if (state.files.size > 0) {
    const activeKey = activePath ? pathKey(activePath) : null;
    const entries = [...state.files.entries()];
    const [, build] =
      entries.find(([k]) => k === activeKey) ??
      entries.reduce((a, b) => (b[1].since > a[1].since ? b : a));
    const verb = build.state === "preamble" ? "building preamble" : "parsing";
    const more = entries.length > 1 ? ` (+${entries.length - 1})` : "";
    parts.push({
      key: `file:${pathKey(build.path)}`,
      text: `clangd: ${verb} ${baseName(build.path)} ${formatElapsed(now - build.since)}${more}`,
    });
  }
  if (state.index) {
    const pct = state.index.percent !== undefined ? ` ${state.index.percent}%` : "";
    const msg = state.index.message ? ` ${state.index.message}` : "";
    parts.push({ key: "index", text: `clangd index${pct}${msg}` });
  }
  return parts;
}

export function formatClangdProgress(
  state: ClangdProgressState,
  now: number,
  activePath?: string | null,
): string {
  return formatClangdProgressParts(state, now, activePath)
    .map(part => part.text)
    .join(" · ");
}
