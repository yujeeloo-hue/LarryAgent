import { connect } from "node:net";
import type { LoopExecutionResult, LoopExecutor } from "./daemonCore.js";
import type { LoopRecord } from "./db.js";
import {
  loopsHandoffSocketPath,
  parseHandoffResponse,
  type HandoffRequest,
  type HandoffResponse,
} from "./handoffProtocol.js";

type Reach =
  | { kind: "alive" }
  | { kind: "absent"; reason: string };

export type HandoffClient = {
  probe(): Promise<Reach>;
  requestRun(loop: LoopRecord): Promise<
    | { kind: "ack"; sessionId: string; pid: number }
    | { kind: "absent"; reason: string }
    | { kind: "lost"; reason: string }
  >;
  pollStatus(
    sessionId: string,
  ): Promise<{ status: string; error?: string } | { absent: true }>;
  waitForCompletion(
    sessionId: string,
    options: { timeoutMs: number; startGraceMs: number },
  ): Promise<
    | { status: string; error?: string }
    | { absent: true }
    | { timeout: true }
  >;
  requestCancel(sessionId: string): Promise<void>;
};

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
        return { kind: "lost", reason: "no response from app" };
      }
      if (!response.ok) {
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
    waitForCompletion(sessionId, options) {
      return new Promise((resolve) => {
        const socket = connect(socketPath);
        let settled = false;
        let buffer = "";
        let sawRunning = false;
        const finish = (
          value:
            | { status: string; error?: string }
            | { absent: true }
            | { timeout: true },
        ): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          resolve(value);
        };
        const timer = setTimeout(() => finish({ timeout: true }), options.timeoutMs);
        const accept = (status: string, error?: string): void => {
          if (status === "running") {
            sawRunning = true;
            return;
          }
          if (status === "error" || status === "cancelled") {
            finish({ status, ...(error ? { error } : {}) });
            return;
          }
          if (!sawRunning && status === "idle" && Date.now() < started + options.startGraceMs) return;
          finish({ status, ...(error ? { error } : {}) });
        };
        const started = Date.now();
        socket.on("error", () => finish({ absent: true }));
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ type: "watch", sessionId })}\n`);
        });
        socket.on("data", (chunk) => {
          buffer += chunk.toString("utf8");
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const response = parseHandoffResponse(buffer.slice(0, newline));
            buffer = buffer.slice(newline + 1);
            newline = buffer.indexOf("\n");
            if (response?.ok && "status" in response) accept(response.status, response.error);
            else if (response && !response.ok) finish({ absent: true });
          }
        });
        socket.on("close", () => {
          if (!sawRunning && Date.now() < started + options.startGraceMs) finish({ status: "completed" });
          else finish({ absent: true });
        });
      });
    },
    async requestCancel(sessionId: string): Promise<void> {
      await request({ type: "cancel", sessionId }, 2_000);
    },
  };
}

export type HandoffExecutorOptions = {
  runTimeoutMs?: number;
  pollIntervalMs?: number;
  startGracePolls?: number;
  log?: (message: string) => void;
};

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
    const watched = await handoff.waitForCompletion(sessionId, {
      timeoutMs: runTimeoutMs,
      startGraceMs: startGracePolls * pollIntervalMs,
    });
    if ("timeout" in watched) {
      await handoff.requestCancel(sessionId);
      return {
        status: "timeout",
        sessionId,
        error: "run exceeded timeout (app handoff)",
      };
    }
    if ("absent" in watched) {
      log("app went away during handed-off run");
      return {
        status: "failed",
        sessionId,
        error: "app exited during run",
      };
    }
    if (watched.status === "error") {
      return {
        status: "failed",
        sessionId,
        error: watched.error ?? "turn ended with error",
      };
    }
    if (watched.status === "cancelled") {
      return { status: "failed", sessionId, error: "turn cancelled" };
    }
    return { status: "succeeded", sessionId };
  };
}

export { loopsHandoffSocketPath };
