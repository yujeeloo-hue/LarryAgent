import type { DebugSessionManager, DebugSnapshot } from "../debug/debugSessionManager.js";
import { debugDisplayPath, sameDebugWorkspace } from "../debug/debugWorkspace.js";

/** Hard stop for a runaway loop: one binding may resume a session this many times. */
export const MAX_CALLBACK_HITS_PER_BINDING = 50;

export type BreakpointCallbackHit = {
  workspacePath: string;
  path: string;
  line: number;
  functionName?: string;
  reason?: string;
  detail?: string;
  threadId?: number;
};

export type BreakpointCallbackBinding = {
  ownerId: number;
  workspacePath: string;
  sessionId: string;
  path: string;
  line: number;
};

export type BreakpointCallbackNotify = (input: {
  sessionId: string;
  hit: BreakpointCallbackHit;
  disarmed: boolean;
}) => void;

export type BreakpointCallbackDeps = {
  notify: BreakpointCallbackNotify;
  /** A debug tool call for this session is already waiting and will report the stop. */
  isSessionAwaitingDebugTool?: (sessionId: string) => boolean;
};

type Entry = { binding: BreakpointCallbackBinding; hits: number };

const bindings = new Map<string, Entry>();
const lastStatus = new Map<number, string>();

export function callbackPathKey(file: string): string {
  return file.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function bindingKey(input: {
  ownerId: number;
  path: string;
  line: number;
  sessionId: string;
}): string {
  return `${input.ownerId}|${callbackPathKey(input.path)}|${input.line}|${input.sessionId}`;
}

export function bindBreakpointCallback(binding: BreakpointCallbackBinding): void {
  bindings.set(bindingKey(binding), { binding: { ...binding }, hits: 0 });
}

/**
 * Drop bindings for one session. Without `path` every line of that session is
 * released (action=clear); with a `path`/`line` only that one.
 */
export function unbindBreakpointCallback(input: {
  ownerId: number;
  sessionId: string;
  path?: string;
  line?: number;
}): number {
  const pathKey = input.path === undefined ? undefined : callbackPathKey(input.path);
  let removed = 0;
  for (const [key, entry] of bindings) {
    if (entry.binding.ownerId !== input.ownerId) continue;
    if (entry.binding.sessionId !== input.sessionId) continue;
    if (pathKey !== undefined && callbackPathKey(entry.binding.path) !== pathKey) continue;
    if (input.line !== undefined && entry.binding.line !== input.line) continue;
    bindings.delete(key);
    removed += 1;
  }
  return removed;
}

export function unbindBreakpointCallbacksForOwner(ownerId: number): void {
  for (const [key, entry] of bindings) {
    if (entry.binding.ownerId === ownerId) bindings.delete(key);
  }
  lastStatus.delete(ownerId);
}

export function listBreakpointCallbacks(input: {
  ownerId: number;
  sessionId?: string;
}): BreakpointCallbackBinding[] {
  const out: BreakpointCallbackBinding[] = [];
  for (const entry of bindings.values()) {
    if (entry.binding.ownerId !== input.ownerId) continue;
    if (input.sessionId !== undefined && entry.binding.sessionId !== input.sessionId) continue;
    out.push({ ...entry.binding });
  }
  return out;
}

export function resetBreakpointCallbacks(): void {
  bindings.clear();
  lastStatus.clear();
}

export function formatBreakpointHit(
  hit: BreakpointCallbackHit,
  options: { disarmed?: boolean } = {},
): string {
  const file = debugDisplayPath(hit.workspacePath, hit.path);
  const fn = hit.functionName ? ` in ${hit.functionName}` : "";
  const thread = typeof hit.threadId === "number" ? `, thread ${hit.threadId}` : "";
  const detail = hit.detail ? ` — ${hit.detail}` : "";
  const head =
    `Breakpoint hit — ${file}:${hit.line}${fn} ` +
    `(reason: ${hit.reason ?? "unknown"}${thread})${detail}.`;
  const tail = options.disarmed
    ? `\nCallback disarmed after ${MAX_CALLBACK_HITS_PER_BINDING} hits on this line — re-arm it with debug_breakpoints callback=true.`
    : "";
  return `${head}\nThe process is paused there. Read the stack with debug_inspect, resume with debug_step.${tail}`;
}

export function hitFromSnapshot(snapshot: DebugSnapshot): BreakpointCallbackHit | null {
  const frame = snapshot.stack?.[0];
  const file = frame?.source?.path ?? frame?.source?.name ?? "";
  const line = frame?.line ?? 0;
  if (!file || !line) return null;
  const detail = snapshot.stopped?.description ?? snapshot.stopped?.text;
  return {
    workspacePath: snapshot.workspacePath ?? "",
    path: file,
    line,
    ...(frame?.name ? { functionName: frame.name } : {}),
    ...(snapshot.stopped?.reason ? { reason: snapshot.stopped.reason } : {}),
    ...(detail ? { detail } : {}),
    ...(typeof snapshot.stopped?.threadId === "number"
      ? { threadId: snapshot.stopped.threadId }
      : {}),
  };
}

/**
 * Fire on the entering-stopped edge only: the manager re-emits the same stop
 * several times (stack, then locals, then frame/thread selection with a fresh
 * stack signature), and every one of those must stay silent.
 */
export function evaluateBreakpointCallbacks(
  ownerId: number,
  snapshot: DebugSnapshot,
  deps: BreakpointCallbackDeps,
): void {
  const previous = lastStatus.get(ownerId);
  lastStatus.set(ownerId, snapshot.status);
  if (snapshot.status !== "stopped" || previous === "stopped") return;

  const hit = hitFromSnapshot(snapshot);
  if (!hit) return;
  const hitPathKey = callbackPathKey(hit.path);
  const notified = new Set<string>();

  for (const [key, entry] of bindings) {
    if (entry.binding.ownerId !== ownerId) continue;
    if (entry.binding.line !== hit.line) continue;
    if (!sameDebugWorkspace(entry.binding.workspacePath, hit.workspacePath)) continue;
    if (callbackPathKey(entry.binding.path) !== hitPathKey) continue;
    const sessionId = entry.binding.sessionId;
    if (notified.has(sessionId)) continue;
    notified.add(sessionId);
    if (deps.isSessionAwaitingDebugTool?.(sessionId)) continue;
    entry.hits += 1;
    const disarmed = entry.hits >= MAX_CALLBACK_HITS_PER_BINDING;
    if (disarmed) bindings.delete(key);
    deps.notify({ sessionId, hit, disarmed });
  }
}

let detach: (() => void) | null = null;

export type BreakpointCallbackWatcherInput = BreakpointCallbackDeps & {
  manager: Pick<DebugSessionManager, "onState">;
};

export function armBreakpointCallbackWatcher(
  input: BreakpointCallbackWatcherInput,
): () => void {
  detach?.();
  detach = null;
  const off = input.manager.onState((ownerId, snapshot) => {
    try {
      evaluateBreakpointCallbacks(ownerId, snapshot, input);
    } catch {
    }
  });
  detach = off;
  return () => {
    off();
    if (detach === off) detach = null;
  };
}
