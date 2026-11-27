import { existsSync, unlinkSync } from "node:fs";
import { createServer, connect, type Server, type Socket } from "node:net";
import { parseHandoffRequest, type HandoffResponse } from "../../loops/handoffProtocol.js";
import type { ReasoningEffort } from "../../llm/reasoningEffort.js";

export type HandoffRunInput = {
  loopId: string;
  prompt: string;
  workspaceId: string;
  providerId: string;
  runMode: "agent" | "plan" | "ask";
  fullPermissions: boolean;
  reasoningEffort: ReasoningEffort;
};

export type HandoffServerDeps = {
  startTurn: (
    input: HandoffRunInput,
  ) => Promise<{ sessionId: string } | { error: string }>;
  getSessionStatus: (
    sessionId: string,
  ) => { status: string; error?: string } | null;
  cancelTurn: (sessionId: string) => boolean;
  subscribeSession?: (sessionId: string, onChange: () => void) => () => void;
  log?: (message: string) => void;
};

export type LoopsHandoffServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  socketPath: string;
};

const REQUEST_TIMEOUT_MS = 15_000;

function writeResponse(socket: Socket, response: HandoffResponse): void {
  try {
    socket.write(`${JSON.stringify(response)}\n`);
  } catch {
  } finally {
    socket.end();
  }
}

function isSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = connect(socketPath);
    const done = (alive: boolean) => {
      probe.destroy();
      resolve(alive);
    };
    probe.once("connect", () => done(true));
    probe.once("error", () => done(false));
  });
}

export function createLoopsHandoffServer(
  socketPath: string,
  deps: HandoffServerDeps,
): LoopsHandoffServer {
  const log = deps.log ?? (() => {});
  let server: Server | null = null;

  const handle = async (socket: Socket, line: string): Promise<void> => {
    const request = parseHandoffRequest(line);
    if (!request) {
      writeResponse(socket, { ok: false, error: "malformed request" });
      return;
    }
    switch (request.type) {
      case "ping":
        writeResponse(socket, { ok: true, ready: true });
        return;
      case "run": {
        const result = await deps.startTurn(request);
        if ("error" in result) {
          writeResponse(socket, { ok: false, error: result.error });
          return;
        }
        writeResponse(socket, {
          ok: true,
          sessionId: result.sessionId,
          pid: process.pid,
        });
        return;
      }
      case "status": {
        const session = deps.getSessionStatus(request.sessionId);
        if (!session) {
          writeResponse(socket, { ok: false, error: "unknown session" });
          return;
        }
        writeResponse(socket, {
          ok: true,
          status: session.status,
          ...(session.error ? { error: session.error } : {}),
        });
        return;
      }
      case "watch": {
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        const send = (response: HandoffResponse): void => {
          if (closed) return;
          closed = true;
          unsubscribe?.();
          writeResponse(socket, response);
        };
        const publish = (): void => {
          const session = deps.getSessionStatus(request.sessionId);
          if (!session) {
            send({ ok: false, error: "unknown session" });
            return;
          }
          if (session.status === "running") return;
          send({
            ok: true,
            status: session.status,
            ...(session.error ? { error: session.error } : {}),
          });
        };
        socket.once("close", () => { closed = true; unsubscribe?.(); });
        unsubscribe = deps.subscribeSession?.(request.sessionId, publish);
        if (closed) unsubscribe?.();
        const session = deps.getSessionStatus(request.sessionId);
        if (!session) {
          send({ ok: false, error: "unknown session" });
          return;
        }
        if (session.status !== "running" || !unsubscribe) {
          send({
            ok: true,
            status: session.status,
            ...(session.error ? { error: session.error } : {}),
          });
        }
        return;
      }
      case "cancel": {
        deps.cancelTurn(request.sessionId);
        writeResponse(socket, { ok: true, cancelled: true });
        return;
      }
    }
  };

  return {
    socketPath,
    async start(): Promise<void> {
      if (server) return;
      if (existsSync(socketPath)) {
        if (await isSocketAlive(socketPath)) {
          log("handoff socket already owned by a live instance; not listening");
          return;
        }
        try {
          unlinkSync(socketPath);
        } catch {
        }
      }
      await new Promise<void>((resolve, reject) => {
        const created = createServer((socket) => {
          let buffer = "";
          let line: string | null = null;
          const timer = setTimeout(() => {
            writeResponse(socket, { ok: false, error: "timeout" });
          }, REQUEST_TIMEOUT_MS);
          socket.on("data", (chunk) => {
            buffer += chunk.toString("utf8");
            const newline = buffer.indexOf("\n");
            if (newline >= 0 && line === null) {
              line = buffer.slice(0, newline);
              void handle(socket, line).catch(() => {
                writeResponse(socket, { ok: false, error: "internal error" });
              }).finally(() => clearTimeout(timer));
            }
          });
          socket.on("error", () => clearTimeout(timer));
        });
        created.once("error", reject);
        created.listen(socketPath, () => resolve());
        server = created;
      });
      log(`handoff server listening on ${socketPath}`);
    },
    async stop(): Promise<void> {
      const current = server;
      server = null;
      if (!current) return;
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        current.removeAllListeners("connection");
      });
      try {
        if (existsSync(socketPath)) unlinkSync(socketPath);
      } catch {
      }
    },
  };
}
