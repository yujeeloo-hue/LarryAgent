import { getDebugSessionManager } from "./debugAdapterIpc.js";
import { liveWebContents } from "./devTaskRunner.js";
import { requestDevMode, type DevModeRequestOwner } from "./devModeRequestBridge.js";
import type { DebugSnapshot } from "../debug/debugSessionManager.js";
import type { SourceBreakpoint } from "../debug/dapSession.js";
import {
  emptyDebugSnapshot,
  type DebugControlPort,
  type DebugToolBreakpoint,
  type DebugToolBreakpointOp,
  type DebugToolSnapshot,
} from "../tools/debugControlPort.js";

const BREAKPOINT_REQUEST_TIMEOUT_MS = 15_000;
const ENSURE_DEV_MODE_TIMEOUT_MS = 8_000;
const CONSOLE_TAIL_ROWS = 20;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toToolSnapshot(snapshot: DebugSnapshot): DebugToolSnapshot {
  const out: DebugToolSnapshot = {
    workspacePath: snapshot.workspacePath ?? "",
    status: snapshot.status,
    threads: (snapshot.threads ?? []).map((thread) => ({
      id: thread.id,
      name: thread.name,
    })),
    stack: (snapshot.stack ?? []).map((frame) => ({
      id: frame.id,
      name: frame.name,
      line: frame.line,
      column: frame.column,
      ...(frame.source?.path
        ? { file: frame.source.path }
        : frame.source?.name
          ? { file: frame.source.name }
          : {}),
    })),
    locals: (snapshot.locals ?? []).map((variable) => ({
      name: variable.name,
      value: variable.value,
      ...(variable.type ? { type: variable.type } : {}),
      variablesReference: variable.variablesReference,
    })),
    targets: (snapshot.targets ?? []).map((target) => ({
      id: target.id,
      kind: target.kind,
      label: target.label,
      status: target.status,
      ...(target.stoppedReason ? { stoppedReason: target.stoppedReason } : {}),
    })),
    console: (snapshot.console ?? []).slice(-CONSOLE_TAIL_ROWS).map((row) => ({
      timestamp: row.timestamp,
      direction: row.direction,
      text: row.text,
    })),
  };
  if (snapshot.recipe) out.recipe = snapshot.recipe;
  if (snapshot.adapterPath) out.adapterPath = snapshot.adapterPath;
  if (snapshot.adapterVersion) out.adapterVersion = snapshot.adapterVersion;
  if (snapshot.program) out.program = snapshot.program;
  if (snapshot.progressText) out.progressText = snapshot.progressText;
  if (snapshot.error) out.error = snapshot.error;
  if (snapshot.stopped) {
    const { reason, description, text, threadId } = snapshot.stopped;
    out.stopped = {
      ...(reason ? { reason } : {}),
      ...(description ? { description } : {}),
      ...(text ? { text } : {}),
      ...(typeof threadId === "number" ? { threadId } : {}),
    };
  }
  if (typeof snapshot.selectedThreadId === "number") {
    out.selectedThreadId = snapshot.selectedThreadId;
  }
  if (typeof snapshot.selectedFrameId === "number") {
    out.selectedFrameId = snapshot.selectedFrameId;
  }
  if (snapshot.selectedTargetId) out.selectedTargetId = snapshot.selectedTargetId;
  return out;
}

function toSourceBreakpoints(list: DebugToolBreakpoint[]): SourceBreakpoint[] {
  const out: SourceBreakpoint[] = [];
  for (const item of list) {
    if (item.enabled === false) continue;
    const condition = item.condition?.trim() ?? "";
    out.push({ path: item.path, line: item.line, ...(condition ? { condition } : {}) });
  }
  return out;
}

function raceTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<{ timedOut: true } | { timedOut: false; value: T }> {
  const guarded = promise.then(
    (value) => ({ timedOut: false as const, value }),
    (error: unknown) => {
      throw error instanceof Error ? error : new Error(String(error));
    },
  );
  if (timeoutMs <= 0) return guarded;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
    guarded.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

async function readBreakpoints(
  owner: DevModeRequestOwner,
  workspacePath: string,
): Promise<{ ok: true; breakpoints: DebugToolBreakpoint[] } | { ok: false; message: string }> {
  try {
    const reply = await requestDevMode(
      owner,
      "breakpoints",
      { workspacePath, op: { action: "list" } satisfies DebugToolBreakpointOp },
      { timeoutMs: BREAKPOINT_REQUEST_TIMEOUT_MS },
    );
    if (!reply.ok) {
      return { ok: false, message: reply.message ?? "Breakpoint list is unavailable" };
    }
    const data = (reply.data ?? {}) as { breakpoints?: unknown };
    return {
      ok: true,
      breakpoints: Array.isArray(data.breakpoints)
        ? (data.breakpoints as DebugToolBreakpoint[])
        : [],
    };
  } catch (error) {
    return { ok: false, message: errorText(error) };
  }
}

export function createDebugToolPort(): DebugControlPort {
  return {
    ensureDevMode: async () => {
      const owner = liveWebContents();
      if (!owner) return { ok: false, message: "No application window is open" };
      try {
        const reply = await requestDevMode(owner, "ensure", {}, {
          timeoutMs: ENSURE_DEV_MODE_TIMEOUT_MS,
        });
        return reply.ok
          ? { ok: true }
          : { ok: false, message: reply.message ?? "Dev Mode is not available" };
      } catch (error) {
        return {
          ok: false,
          message: `${errorText(error)}. Bring the Larry Agent window to the front and retry.`,
        };
      }
    },

    start: async ({ workspacePath, buildId, autoBuild, waitMs }) => {
      const owner = liveWebContents();
      if (!owner) return { ok: false, message: "No application window is open" };
      const manager = getDebugSessionManager();
      if (!manager) {
        return { ok: false, message: "The debug adapter is not registered in this host" };
      }
      const listed = await readBreakpoints(owner, workspacePath);
      if (!listed.ok) {
        return {
          ok: false,
          message: `Could not read the workspace breakpoints — ${listed.message}`,
        };
      }
      const raced = await raceTimeout(
        manager.start(owner, {
          workspacePath,
          breakpoints: toSourceBreakpoints(listed.breakpoints),
          ...(buildId ? { buildId } : {}),
          ...(autoBuild === false ? { autoBuild: false } : {}),
        }),
        waitMs,
      );
      if (raced.timedOut) {
        return { ok: true, snapshot: toToolSnapshot(manager.state(owner)), pending: true };
      }
      if (raced.value.ok) {
        return {
          ok: true,
          snapshot: toToolSnapshot(raced.value.snapshot),
          pending: false,
        };
      }
      return {
        ok: false,
        message: raced.value.message,
        ...(raced.value.cancelled ? { cancelled: true } : {}),
        snapshot: toToolSnapshot(manager.state(owner)),
      };
    },

    stop: async () => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      const result = await manager.stop(owner);
      return result.ok ? { ok: true } : { ok: false, message: "Stop failed" };
    },

    command: async (command) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      return manager.command(owner, command);
    },

    state: () => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return emptyDebugSnapshot();
      return toToolSnapshot(manager.state(owner));
    },

    waitForStatus: async ({ statuses, timeoutMs, signal }) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return emptyDebugSnapshot();
      const current = (): ReturnType<typeof toToolSnapshot> => toToolSnapshot(manager.state(owner));
      const initial = current();
      if (statuses.includes(initial.status)) return initial;
      return new Promise((resolve) => {
        const timer = setTimeout(() => finish(current()), Math.max(0, timeoutMs));
        const unsubscribe = manager.onState((ownerId, next) => {
          if (ownerId !== owner.id) return;
          const snapshot = toToolSnapshot(next);
          if (statuses.includes(snapshot.status)) finish(snapshot);
        });
        const onAbort = (): void => finish(current());
        function finish(snapshot: ReturnType<typeof toToolSnapshot>): void {
          clearTimeout(timer);
          unsubscribe();
          signal?.removeEventListener("abort", onAbort);
          resolve(snapshot);
        }
        if (signal) {
          if (signal.aborted) finish(current());
          else signal.addEventListener("abort", onAbort);
        }
      });
    },

    selectFrame: async (frameId) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      const result = await manager.selectFrame(owner, frameId);
      return result.ok
        ? { ok: true }
        : { ok: false, ...(result.message ? { message: result.message } : {}) };
    },

    selectThread: async (threadId) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      return manager.selectThread(owner, threadId);
    },

    selectTarget: async (targetId) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      return manager.selectTarget(owner, targetId);
    },

    evaluate: async (expression, frameId) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      return manager.evaluate(owner, expression, frameId);
    },

    variables: async (variablesReference) => {
      const manager = getDebugSessionManager();
      const owner = liveWebContents();
      if (!manager || !owner) return { ok: false, message: "No application window is open" };
      return manager.variables(owner, variablesReference);
    },

    breakpoints: async ({ workspacePath, op }) => {
      const owner = liveWebContents();
      if (!owner) return { ok: false, message: "No application window is open" };
      let reply;
      try {
        reply = await requestDevMode(owner, "breakpoints", { workspacePath, op }, {
          timeoutMs: BREAKPOINT_REQUEST_TIMEOUT_MS,
        });
      } catch (error) {
        return { ok: false, message: errorText(error) };
      }
      if (!reply.ok) {
        return { ok: false, message: reply.message ?? "Breakpoint update failed" };
      }
      const data = (reply.data ?? {}) as {
        breakpoints?: unknown;
        paths?: unknown;
        livePushed?: unknown;
      };
      const breakpoints = Array.isArray(data.breakpoints)
        ? (data.breakpoints as DebugToolBreakpoint[])
        : [];
      if (data.livePushed !== true) {
        const manager = getDebugSessionManager();
        if (manager) {
          const paths = new Set<string>(
            Array.isArray(data.paths) ? (data.paths as string[]) : [],
          );
          for (const item of breakpoints) paths.add(item.path);
          for (const path of paths) {
            const lines = toSourceBreakpoints(
              breakpoints.filter((item) => item.path === path),
            ).map((item) => ({
              line: item.line,
              ...(item.condition ? { condition: item.condition } : {}),
            }));
            try {
              await manager.replaceBreakpoints(owner, path, lines);
            } catch {
            }
          }
        }
      }
      return { ok: true, breakpoints };
    },
  };
}
