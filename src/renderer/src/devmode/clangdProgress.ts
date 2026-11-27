
export type ClangdProgressEvent =
  | { phase: "indexing_speed"; speed: "normal" | "full" }
  | { phase: "indexing" | "idle"; percent?: number; message?: string }
  | { phase: "starting" | "ready" | "failed" | "generating" | "warning"; message?: string }
  | { phase: "file"; path: string; state: "preamble" | "parsing" | "idle" };

type FileBuild = { state: "preamble" | "parsing"; since: number; path: string };

export type ClangdProgressState = {
  indexingSpeed: "normal" | "full";
  startingSince: number | null;
  generatingSince: number | null;
  generatingMessage: string | null;
  warning: string | null;
  files: Map<string, FileBuild>;
  index: { percent?: number; message?: string } | null;
};

export function createClangdProgressState(): ClangdProgressState {
  return { indexingSpeed: "normal", startingSince: null, generatingSince: null, generatingMessage: null, warning: null, files: new Map(), index: null };
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
      state.warning = null;
      return;
    case "warning":
      state.generatingSince = null;
      state.generatingMessage = null;
      state.warning = event.message ?? "";
      return;
    case "starting":
      state.generatingSince = null;
      state.generatingMessage = null;
      state.startingSince = now;
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
      state.warning = null;
      state.files.clear();
      state.index = null;
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
  return state.startingSince !== null || state.generatingSince !== null || state.files.size > 0;
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

function indexCounts(message: string | undefined): string {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(message ?? "");
  if (!match) return "";
  const done = Number(match[1]).toLocaleString("en-US");
  const total = Number(match[2]).toLocaleString("en-US");
  return ` · ${done} / ${total}`;
}

export function formatClangdProgressParts(
  state: ClangdProgressState,
  now: number,
  activePath?: string | null,
): ClangdProgressPart[] {
  const parts: ClangdProgressPart[] = [];
  if (state.warning !== null) {
    parts.push({ key: "warning", text: "Using previous compile database" });
  }
  if (state.generatingSince !== null) {
    parts.push({
      key: "generating",
      text: `Preparing compile database… ${formatElapsed(now - state.generatingSince)}`,
    });
  } else if (state.startingSince !== null) {
    parts.push({
      key: "starting",
      text: `Starting C++ language server… ${formatElapsed(now - state.startingSince)}`,
    });
  }
  if (state.files.size > 0) {
    const activeKey = activePath ? pathKey(activePath) : null;
    const entries = [...state.files.entries()];
    const [, build] =
      entries.find(([k]) => k === activeKey) ??
      entries.reduce((a, b) => (b[1].since > a[1].since ? b : a));
    const more = entries.length > 1 ? ` (+${entries.length - 1})` : "";
    parts.push({
      key: `file:${pathKey(build.path)}`,
      text: `Analyzing ${baseName(build.path)}… ${formatElapsed(now - build.since)}${more}`,
    });
  }
  if (state.index) {
    const pct = state.index.percent !== undefined ? ` ${state.index.percent}%` : "…";
    parts.push({ key: "index", text: `Indexing${pct}${indexCounts(state.index.message)}` });
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
