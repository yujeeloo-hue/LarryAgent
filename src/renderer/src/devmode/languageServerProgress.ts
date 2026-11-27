import type { LanguageServerId, LanguageServerProgressEvent } from "../../../main/lsp/progressTypes.js";
import { formatElapsed, type ClangdProgressPart } from "./clangdProgress.js";

type ProgressEntry =
  | { phase: "starting"; since: number }
  | { phase: "loading"; since: number; message?: string }
  | { phase: "diagnosing"; percent?: number }
  | { phase: "failed" };

type Entry = { server: LanguageServerId; root: string; progress: ProgressEntry };

export type LanguageServerProgressState = Map<string, Entry>;

const SERVER_COPY: Record<LanguageServerId, { name: string; scope: string; files: string }> = {
  lua: { name: "Lua", scope: "Lua workspace", files: "Lua files" },
  typescript: { name: "TypeScript", scope: "TypeScript project", files: "TypeScript files" },
};

export function createLanguageServerProgressState(): LanguageServerProgressState {
  return new Map();
}

function rootKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function applyLanguageServerProgress(
  state: LanguageServerProgressState,
  event: LanguageServerProgressEvent,
  now: number,
): void {
  const root = rootKey(event.rootPath);
  const key = `${event.server}:${root}`;
  const prev = state.get(key)?.progress;
  const put = (progress: ProgressEntry) => state.set(key, { server: event.server, root, progress });
  switch (event.phase) {
    case "idle":
      state.delete(key);
      return;
    case "starting":
      put({ phase: "starting", since: now });
      return;
    case "loading": {
      const since = prev && (prev.phase === "starting" || prev.phase === "loading") ? prev.since : now;
      put({ phase: "loading", since, ...(event.message ? { message: event.message } : {}) });
      return;
    }
    case "diagnosing":
      put({ phase: "diagnosing", ...(event.percent !== undefined ? { percent: event.percent } : {}) });
      return;
    case "failed":
      put({ phase: "failed" });
      return;
  }
}

export function languageServerProgressNeedsTick(state: LanguageServerProgressState): boolean {
  for (const { progress } of state.values()) {
    if (progress.phase === "starting" || progress.phase === "loading") return true;
  }
  return false;
}

function readableMessage(message: string): string {
  return message.replace(/\d{4,}/g, digits => Number(digits).toLocaleString("en-US"));
}

function entryText({ server, progress }: Entry, now: number): string {
  const copy = SERVER_COPY[server];
  switch (progress.phase) {
    case "starting":
      return `Starting ${copy.name} language server… ${formatElapsed(now - progress.since)}`;
    case "loading": {
      const detail = progress.message ? ` · ${readableMessage(progress.message)}` : "";
      return `Loading ${copy.scope}… ${formatElapsed(now - progress.since)}${detail}`;
    }
    case "diagnosing":
      return progress.percent !== undefined
        ? `Checking ${copy.files} ${progress.percent}%`
        : `Checking ${copy.files}…`;
    case "failed":
      return `${copy.name} language server failed to start`;
  }
}

export function formatLanguageServerProgressParts(
  state: LanguageServerProgressState,
  workspaceRoot: string | null,
  now: number,
): ClangdProgressPart[] {
  if (!workspaceRoot) return [];
  const root = rootKey(workspaceRoot);
  const parts: ClangdProgressPart[] = [];
  for (const [key, entry] of state) {
    if (entry.root !== root && !entry.root.startsWith(`${root}/`)) continue;
    parts.push({ key, text: entryText(entry, now) });
  }
  return parts;
}
