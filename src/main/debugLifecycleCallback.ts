import type { DebugSessionManager, DebugSnapshot } from "../debug/debugSessionManager.js";
import { debugBasename, sameDebugWorkspace } from "../debug/debugWorkspace.js";

/** A start attempt can only produce a few notices; this guards a flapping loop. */
export const MAX_LIFECYCLE_NOTICES_PER_BINDING = 20;

export type DebugLifecycleEvent = "build-finished" | "launched" | "failed";

export type DebugLifecycleNotice = {
  event: DebugLifecycleEvent;
  workspacePath: string;
  recipe?: string;
  program?: string;
  progressText?: string;
  error?: string;
};

export type DebugLifecycleBinding = {
  ownerId: number;
  sessionId: string;
  workspacePath: string;
};

export type DebugLifecycleNotify = (input: {
  sessionId: string;
  notice: DebugLifecycleNotice;
  disarmed: boolean;
}) => void;

export type DebugLifecycleDeps = {
  notify: DebugLifecycleNotify;
  /** A debug tool call for this session is already waiting and will report the state. */
  isSessionAwaitingDebugTool?: (sessionId: string) => boolean;
};

type Phase = "idle" | "building" | "starting" | "settled";

type Entry = { binding: DebugLifecycleBinding; notices: number };

type OwnerState = {
  phase: Phase;
  buildProgress: string | undefined;
  buildProgram: string | undefined;
  buildRecipe: string | undefined;
};

const bindings = new Map<string, Entry>();
const owners = new Map<number, OwnerState>();

function bindingKey(ownerId: number, sessionId: string): string {
  return `${ownerId}|${sessionId}`;
}

export function armStartCallback(binding: DebugLifecycleBinding): void {
  bindings.set(bindingKey(binding.ownerId, binding.sessionId), {
    binding: { ...binding },
    notices: 0,
  });
}

export function disarmStartCallback(input: {
  ownerId: number;
  sessionId: string;
}): boolean {
  return bindings.delete(bindingKey(input.ownerId, input.sessionId));
}

export function isStartCallbackArmed(input: {
  ownerId: number;
  sessionId: string;
}): boolean {
  return bindings.has(bindingKey(input.ownerId, input.sessionId));
}

export function listStartCallbacks(ownerId: number): DebugLifecycleBinding[] {
  return [...bindings.values()]
    .filter((entry) => entry.binding.ownerId === ownerId)
    .map((entry) => ({ ...entry.binding }));
}

export function unbindStartCallbacksForOwner(ownerId: number): void {
  for (const [key, entry] of bindings) {
    if (entry.binding.ownerId === ownerId) bindings.delete(key);
  }
  owners.delete(ownerId);
}

export function resetStartCallbacks(): void {
  bindings.clear();
  owners.clear();
}

function stateOf(ownerId: number): OwnerState {
  let state = owners.get(ownerId);
  if (!state) {
    state = {
      phase: "idle",
      buildProgress: undefined,
      buildProgram: undefined,
      buildRecipe: undefined,
    };
    owners.set(ownerId, state);
  }
  return state;
}

/** Only the edges out of `building` / `starting` count; later churn must stay silent. */
function phaseOf(status: DebugSnapshot["status"]): Phase {
  if (status === "building") return "building";
  if (status === "starting") return "starting";
  if (status === "idle") return "idle";
  return "settled";
}

export function formatLifecycleNotice(
  notice: DebugLifecycleNotice,
  options: { disarmed?: boolean } = {},
): string {
  const scope = [notice.recipe, notice.program ? debugBasename(notice.program) : ""]
    .filter(Boolean)
    .join(" · ");
  const suffix = scope ? ` (${scope})` : "";
  let body: string;
  if (notice.event === "build-finished") {
    const what = notice.progressText ? ` — ${notice.progressText}` : "";
    body =
      `Build finished${what}${suffix}. The debugger is starting the app now; ` +
      "the session is resumed again once it is up.";
  } else if (notice.event === "launched") {
    body =
      `Debugger attached — the app is up${suffix}. ` +
      "Read the state with debug_run action=status, then debug_inspect / debug_step.";
  } else {
    body =
      `Debug start failed${suffix}${notice.error ? ` — ${notice.error}` : ""}. ` +
      "Fix the cause, then retry with debug_run action=start.";
  }
  const tail = options.disarmed
    ? `\nCallback disarmed after ${MAX_LIFECYCLE_NOTICES_PER_BINDING} notices — re-arm it with callback=true.`
    : "";
  return `${body}${tail}`;
}

export function evaluateStartCallbacks(
  ownerId: number,
  snapshot: DebugSnapshot,
  deps: DebugLifecycleDeps,
): void {
  const state = stateOf(ownerId);
  const previous = state.phase;
  const status = snapshot.status;
  const next = phaseOf(status);

  if (next === "building") {
    state.buildProgress = snapshot.progressText;
    state.buildProgram = snapshot.program;
    state.buildRecipe = snapshot.recipe;
  } else if (next === "idle") {
    state.buildProgress = undefined;
    state.buildProgram = undefined;
    state.buildRecipe = undefined;
  }
  state.phase = next;

  let event: DebugLifecycleEvent | null = null;
  if (previous === "building" && next === "starting") event = "build-finished";
  else if (
    (previous === "building" || previous === "starting") &&
    status === "error"
  ) {
    event = "failed";
  } else if (
    (previous === "building" || previous === "starting") &&
    (status === "running" || status === "stopped")
  ) {
    event = "launched";
  }
  if (!event) return;

  const notice: DebugLifecycleNotice = {
    event,
    workspacePath: snapshot.workspacePath ?? "",
    ...(event === "build-finished" && state.buildRecipe
      ? { recipe: state.buildRecipe }
      : snapshot.recipe
        ? { recipe: snapshot.recipe }
        : {}),
    ...(event === "build-finished" && state.buildProgram
      ? { program: state.buildProgram }
      : snapshot.program
        ? { program: snapshot.program }
        : {}),
    ...(event === "build-finished" && state.buildProgress
      ? { progressText: state.buildProgress }
      : {}),
    ...(event === "failed" && snapshot.error ? { error: snapshot.error } : {}),
  };

  for (const [key, entry] of bindings) {
    if (entry.binding.ownerId !== ownerId) continue;
    if (!sameDebugWorkspace(entry.binding.workspacePath, notice.workspacePath)) continue;
    const sessionId = entry.binding.sessionId;
    if (deps.isSessionAwaitingDebugTool?.(sessionId)) continue;
    entry.notices += 1;
    const disarmed = entry.notices >= MAX_LIFECYCLE_NOTICES_PER_BINDING;
    if (disarmed) bindings.delete(key);
    deps.notify({ sessionId, notice, disarmed });
  }
}

let detach: (() => void) | null = null;

export type DebugLifecycleWatcherInput = DebugLifecycleDeps & {
  manager: Pick<DebugSessionManager, "onState">;
};

export function armStartCallbackWatcher(input: DebugLifecycleWatcherInput): () => void {
  detach?.();
  detach = null;
  const off = input.manager.onState((ownerId, snapshot) => {
    try {
      evaluateStartCallbacks(ownerId, snapshot, input);
    } catch {
    }
  });
  detach = off;
  return () => {
    off();
    if (detach === off) detach = null;
  };
}
