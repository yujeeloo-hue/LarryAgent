import type { LuaLsProgressEvent } from "../../../main/luaLs/types.js";
import { formatElapsed, type ClangdProgressPart } from "./clangdProgress.js";

type LuaProgressEntry =
  | { phase: "starting"; since: number }
  | { phase: "loading"; since: number; message?: string }
  | { phase: "diagnosing"; percent?: number }
  | { phase: "failed" };

export type LuaProgressState = Map<string, LuaProgressEntry>;

export function createLuaProgressState(): LuaProgressState {
  return new Map();
}

function rootKey(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function applyLuaProgress(state: LuaProgressState, event: LuaLsProgressEvent, now: number): void {
  const key = rootKey(event.rootPath);
  const prev = state.get(key);
  switch (event.phase) {
    case "idle":
      state.delete(key);
      return;
    case "starting":
      state.set(key, { phase: "starting", since: now });
      return;
    case "loading": {
      const since = prev && (prev.phase === "starting" || prev.phase === "loading") ? prev.since : now;
      state.set(key, { phase: "loading", since, ...(event.message ? { message: event.message } : {}) });
      return;
    }
    case "diagnosing":
      state.set(key, { phase: "diagnosing", ...(event.percent !== undefined ? { percent: event.percent } : {}) });
      return;
    case "failed":
      state.set(key, { phase: "failed" });
      return;
  }
}

export function luaProgressNeedsTick(state: LuaProgressState): boolean {
  for (const entry of state.values()) {
    if (entry.phase === "starting" || entry.phase === "loading") return true;
  }
  return false;
}

function readableMessage(message: string): string {
  return message.replace(/\d{4,}/g, digits => Number(digits).toLocaleString("en-US"));
}

function entryText(entry: LuaProgressEntry, now: number): string {
  switch (entry.phase) {
    case "starting":
      return `Starting Lua language server… ${formatElapsed(now - entry.since)}`;
    case "loading": {
      const detail = entry.message ? ` · ${readableMessage(entry.message)}` : "";
      return `Loading Lua workspace… ${formatElapsed(now - entry.since)}${detail}`;
    }
    case "diagnosing":
      return entry.percent !== undefined ? `Checking Lua files ${entry.percent}%` : "Checking Lua files…";
    case "failed":
      return "Lua language server failed to start";
  }
}

export function formatLuaProgressParts(
  state: LuaProgressState,
  workspaceRoot: string | null,
  now: number,
): ClangdProgressPart[] {
  if (!workspaceRoot) return [];
  const root = rootKey(workspaceRoot);
  const parts: ClangdProgressPart[] = [];
  for (const [key, entry] of state) {
    if (key !== root && !key.startsWith(`${root}/`)) continue;
    parts.push({ key: `lua:${key}`, text: entryText(entry, now) });
  }
  return parts;
}
