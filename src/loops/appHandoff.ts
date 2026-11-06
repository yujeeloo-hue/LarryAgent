/**
 * Daemon-side App handoff client + executor wrapper.
 *
 * When JellyBot is running, due-loop turns are handed off over the unix
 * socket (handoffProtocol) so the session lives in the App process — the
 * user sees it streaming in the sidebar. When the App is absent or not
 * ready, execution falls back to the daemon-local headless path.
 *
 * Anti-double-run: once a `run` request is *acknowledged* (sessionId
 * received), any later failure is terminal — we never fall back to local
 * execution for that run. Only connection failures before an ack (refused,
 * not-ready, malformed) fall back.
 */
import { connect } from "node:net";
import type { LoopExecutionResult, LoopExecutor } from "./daemonCore.js";
import type { LoopRecord } from "./db.js";
import {
  loopsHandoffSocketPath,
  parseHandoffResponse,
  type HandoffRequest,
  type HandoffResponse,
} from "./handoffProtocol.js";

/** Outcome classification for socket reachability. */
type Reach =
  | { kind: "alive" }
  | { kind: "absent"; reason: string };

export type HandoffClient = {
  /** Cheap reachability probe (ping). */
  probe(): Promise<Reach>;
  /** Ask the App to start the turn. Ack carries the sessionId. */
  requestRun(loop: LoopRecord): Promise<
    | { kind: "ack"; sessionId: string; pid: number }
    | { kind: "absent"; reason: string }
    | { kind: "lost"; reason: string }
  >;
  /** Poll the App-side live status for a handed-off session. */
  pollStatus(
    sessionId: string,
  ): Promise<{ status: string; error?: string } | { absent: true }>;
  /** Best-effort stop for a handed-off session (timeout path). */
  requestCancel(sessionId: string): Promise<void>;
};

/** Socket-level client. All failures resolve — never throw. */
export function createSocketHandoffClient(socketPath: string): HandoffClient {
  const request = (
    payload: HandoffRequest,
    timeoutMs: number,
  ): Promise<HandoffResponse | null> =>
    new Promise((resolve) => {
      const socket = connect(socketPath);
      let settled = false;
      let buffer = "";
      const finish = (value: HandoffResponse | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(value);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      socket.on("error", () => finish(null));
      socket.on("connect", () => {
        socket.write(`${JSON.stringify(payload)}\n`);
      });
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline >= 0) {
          finish(parseHandoffResponse(buffer.slice(0, newline)));
        }
      });
      socket.on("close", () => finish(null));
    });

  return {
    async probe(): Promise<Reach> {
      const response = await request({ type: "ping" }, 1_000);
      if (response?.ok && "ready" in response && response.ready) {
        return { kind: "alive" };
      }
      return { kind: "absent", reason: "app socket not ready" };
    },
    async requestRun(loop: LoopRecord) {
      const response = await request(
        {
          type: "run",
          loopId: loop.id,
          prompt: loop.prompt,
          workspaceId: loop.workspaceId,
          providerId: loop.providerId,
          runMode: loop.runMode,
          fullPermissions: loop.fullPermissions,
          reasoningEffort: loop.reasoningEffort,
        },
        10_000,
      );
      if (response === null) {
        // No response: unknown whether the App started the turn. Treat as
        // lost (terminal) — never retry locally (double-run risk).
        return { kind: "lost", reason: "no response from app" };
      }
      if (!response.ok) {
        // Explicit rejection — the App did not start anything.
        return { kind: "absent", reason: response.error };
      }
      if ("sessionId" in response) {
        return { kind: "ack", sessionId: response.sessionId, pid: response.pid };
      }
      return { kind: "lost", reason: "unexpected run response shape" };
    },
    async pollStatus(sessionId: string) {
      const response = await request({ type: "status", sessionId }, 5_000);
      if (response?.ok && "status" in response) {
        return {
          status: response.status,
          ...(response.error ? { error: response.error } : {}),
        };
      }
      return { absent: true } as const;
    },
    async requestCancel(sessionId: string): Promise<void> {
      await request({ type: "cancel", sessionId }, 2_000);
    },
  };
}

export type HandoffExecutorOptions = {
  /** Total run budget (ms); mirrors the local executor's 30 min. */
  runTimeoutMs?: number;
  /** Status poll cadence (ms). */
  pollIntervalMs?: number;
  /** Polls an idle (not-yet-running) session may take before terminal. */
  startGracePolls?: number;
  log?: (message: string) => void;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Wrap the daemon-local executor with App handoff. The loop_runs bookkeeping
 * in runSchedulerPass is unchanged — this only changes *where* the turn runs.
 */
export function createHandoffExecutor(
  local: LoopExecutor,
  handoff: HandoffClient,
  options: HandoffExecutorOptions = {},
): LoopExecutor {
  const runTimeoutMs = options.runTimeoutMs ?? 30 * 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const startGracePolls = options.startGracePolls ?? 5;
  const log = options.log ?? (() => {});

  return async (loop: LoopRecord): Promise<LoopExecutionResult> => {
    const reach = await handoff.probe();
    if (reach.kind !== "alive") {
      return local(loop);
    }
    const started = await handoff.requestRun(loop);
    if (started.kind === "absent") {
      log(`handoff rejected (${started.reason}); running locally`);
      return local(loop);
    }
    if (started.kind === "lost") {
      log(`handoff lost after ack ambiguity: ${started.reason}`);
      return {
        status: "failed",
        error: `app handoff response lost: ${started.reason}`,
      };
    }
    const sessionId = started.sessionId;
    log(`handed off to app pid=${started.pid} session=${sessionId}`);

    let sawRunning = false;
    let idlePolls = 0;
    const deadline = Date.now() + runTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollIntervalMs);
      const poll = await handoff.pollStatus(sessionId);
      if ("absent" in poll) {
        // App exited / socket died mid-run: terminal, no local retry.
        log("app went away during handed-off run");
        return {
          status: "failed",
          sessionId,
          error: "app exited during run",
        };
      }
      if (poll.status === "running") {
        sawRunning = true;
        idlePolls = 0;
        continue;
      }
      if (!sawRunning && idlePolls < startGracePolls) {
        idlePolls += 1;
        continue;
      }
      if (poll.status === "error") {
        return {
          status: "failed",
          sessionId,
          error: poll.error ?? "turn ended with error",
        };
      }
      if (poll.status === "cancelled") {
        return { status: "failed", sessionId, error: "turn cancelled" };
      }
      return { status: "succeeded", sessionId };
    }

    await handoff.requestCancel(sessionId);
    return {
      status: "timeout",
      sessionId,
      error: "run exceeded timeout (app handoff)",
    };
  };
}

/** Convenience: default socket path helper re-export for daemonMain. */
export { loopsHandoffSocketPath };
