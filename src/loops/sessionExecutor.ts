import type { LoopExecutionResult, LoopExecutor } from "./daemonCore.js";
import type { LoopRecord } from "./db.js";
import type { ReasoningEffort } from "../llm/reasoningEffort.js";

export type SessionExecutorStore = {
  startTurn: (req: {
    userText: string;
    workspaceId: string;
    providerId?: string;
    runMode: "agent" | "plan" | "ask";
    fullPermissions: boolean;
    headless: boolean;
    source: "loop";
    reasoningEffort?: ReasoningEffort;
  }) => Promise<{ sessionId: string }>;
  getSession: (
    sessionId: string,
  ) => { status: string } | null;
  isTurnActive: (sessionId: string) => boolean;
  onTurnActivity: (listener: (sessionId: string) => void) => () => void;
  cancelTurn: (sessionId: string) => boolean;
};

export type SessionExecutorOptions = {
  runTimeoutMs?: number;
};

function waitForTurnEnd(
  store: SessionExecutorStore,
  sessionId: string,
  timeoutMs: number,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ended: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(ended);
    };
    const unsubscribe = store.onTurnActivity((id) => {
      if (id === sessionId && !store.isTurnActive(sessionId)) finish(true);
    });
    const timer = setTimeout(() => finish(false), timeoutMs);
    if (!store.isTurnActive(sessionId)) finish(true);
  });
}

export function createSessionExecutor(
  store: SessionExecutorStore,
  options: SessionExecutorOptions = {},
): LoopExecutor {
  const runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;

  return async (loop: LoopRecord): Promise<LoopExecutionResult> => {
    const started = await store.startTurn({
      userText: loop.prompt,
      workspaceId: loop.workspaceId,
      ...(loop.providerId ? { providerId: loop.providerId } : {}),
      runMode: loop.runMode,
      fullPermissions: loop.fullPermissions,
      headless: true,
      source: "loop",
      reasoningEffort: loop.reasoningEffort,
    });
    const sessionId = started.sessionId;

    if (!(await waitForTurnEnd(store, sessionId, runTimeoutMs))) {
      store.cancelTurn(sessionId);
      return { status: "timeout", sessionId, error: "run exceeded timeout" };
    }
    const session = store.getSession(sessionId);
    if (!session) {
      return { status: "failed", sessionId, error: "session vanished during run" };
    }
    if (session.status === "error") {
      return { status: "failed", sessionId, error: "turn ended with error" };
    }
    if (session.status === "cancelled") {
      return { status: "failed", sessionId, error: "turn cancelled" };
    }
    return { status: "succeeded", sessionId };
  };
}
