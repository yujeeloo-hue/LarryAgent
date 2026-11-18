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
  cancelTurn: (sessionId: string) => boolean;
};

export type SessionExecutorOptions = {
  runTimeoutMs?: number;
  pollIntervalMs?: number;
  startGracePolls?: number;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function createSessionExecutor(
  store: SessionExecutorStore,
  options: SessionExecutorOptions = {},
): LoopExecutor {
  const runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const startGracePolls = options.startGracePolls ?? 5;

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

    let sawRunning = false;
    let idlePolls = 0;
    const deadline = Date.now() + runTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const session = store.getSession(sessionId);
      if (!session) {
        return { status: "failed", sessionId, error: "session vanished during run" };
      }
      if (session.status === "running") {
        sawRunning = true;
        idlePolls = 0;
        continue;
      }
      if (!sawRunning && idlePolls < startGracePolls) {
        idlePolls += 1;
        continue;
      }
      if (session.status === "error") {
        return { status: "failed", sessionId, error: "turn ended with error" };
      }
      if (session.status === "cancelled") {
        return { status: "failed", sessionId, error: "turn cancelled" };
      }
      return { status: "succeeded", sessionId };
    }

    store.cancelTurn(sessionId);
    return { status: "timeout", sessionId, error: "run exceeded timeout" };
  };
}
