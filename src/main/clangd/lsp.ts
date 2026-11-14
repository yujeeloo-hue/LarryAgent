/**
 * Minimal LSP client over stdio (Content-Length framing) for hosting
 * clangd. Supports request/response, notifications and the handful of
 * server→client requests clangd emits (progress create, registerCapability,
 * applyEdit) which are answered with permissive nulls.
 */

import { type ChildProcess, spawn } from "node:child_process";

export type LspHandler = {
  onDispose?: () => void;
};

const RECV_TIMEOUT_DEFAULT_MS = 120_000;

/**
 * Content-Length framing. The length counts UTF-8 bytes, so the buffer must
 * stay binary — slicing a decoded string by it drops non-ASCII messages.
 */
export class LspFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

  /** Append raw stdout bytes; returns every complete message body. */
  push(chunk: Buffer): string[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    const bodies: string[] = [];
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) break;
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(
        this.buffer.subarray(0, headerEnd).toString("ascii"),
      );
      const length = lengthMatch ? parseInt(lengthMatch[1]!, 10) : -1;
      if (length < 0) {
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      if (this.buffer.length < headerEnd + 4 + length) break;
      bodies.push(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8"));
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
    }
    return bodies;
  }
}

export class LspConnection {
  private child: ChildProcess | null = null;
  private readonly frames = new LspFrameReader();
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: NodeJS.Timeout | null }
  >();

  private constructor(
    private readonly command: string,
    private readonly args: string[],
    private readonly cwd: string,
  ) {}

  /** Server→client notifications (`$/progress`, publishDiagnostics, …). */
  onNotification: ((method: string, params: unknown) => void) | null = null;

  static async start(
    command: string,
    args: string[],
    init: { rootUri: string | null; initializationOptions?: unknown },
    cwd: string,
    onLog?: (message: string) => void,
  ): Promise<LspConnection> {
    const conn = new LspConnection(command, args, cwd);
    const child = spawn(command, args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    conn.child = child;
    child.on("error", (err) => conn.failAll(err));
    child.on("exit", () => conn.failAll(new Error("clangd exited")));
    if (onLog) {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) onLog(line);
        }
      });
    }
    child.stdout?.on("data", (chunk: Buffer) => conn.onChunk(chunk));

    await conn.request(
      "initialize",
      {
        processId: process.pid,
        ...(init.rootUri ? { rootUri: init.rootUri } : {}),
        capabilities: {
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
            completion: {
              dynamicRegistration: false,
              contextSupport: true,
              // Without labelDetailsSupport clangd folds the whole signature
              // (`Foo(int A) const`) into `label`.
              completionItem: {
                snippetSupport: true,
                labelDetailsSupport: true,
                documentationFormat: ["markdown", "plaintext"],
              },
            },
            signatureHelp: {
              dynamicRegistration: false,
              contextSupport: true,
              signatureInformation: {
                documentationFormat: ["markdown", "plaintext"],
                parameterInformation: { labelOffsetSupport: true },
                activeParameterSupport: true,
              },
            },
          },
          workspace: {
            workspaceFolders: false,
            configuration: false,
            workDoneProgress: true,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
        ...(init.initializationOptions !== undefined
          ? { initializationOptions: init.initializationOptions }
          : {}),
      },
      60_000,
    );
    conn.notify("initialized", {});
    return conn;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  /**
   * Send a request. `timeoutMs <= 0` disables the wall-clock timer (the
   * caller owns liveness via `signal`); an aborted `signal` sends
   * `$/cancelRequest` so the server drops the work instead of finishing
   * it into the void.
   */
  request(
    method: string,
    params: unknown,
    timeoutMs = RECV_TIMEOUT_DEFAULT_MS,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const onAbort = () => {
        this.notify("$/cancelRequest", { id });
      };
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              onAbort();
              reject(new Error(`clangd request "${method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      if (signal) {
        if (signal.aborted) {
          if (timer) clearTimeout(timer);
          onAbort();
          reject(new Error(`clangd request "${method}" cancelled`));
          return;
        }
        signal.addEventListener(
          "abort",
          () => {
            const entry = this.pending.get(id);
            if (!entry) return;
            this.pending.delete(id);
            if (entry.timer) clearTimeout(entry.timer);
            onAbort();
            entry.reject(new Error(`clangd request "${method}" cancelled`));
          },
          { once: true },
        );
      }
      this.pending.set(id, { resolve, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  dispose(): void {
    this.failAll(new Error("clangd connection disposed"));
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill();
      } catch {
        // Already gone.
      }
    }
  }

  private send(message: unknown): void {
    const body = JSON.stringify(message);
    this.child?.stdin?.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  }

  private onChunk(chunk: Buffer): void {
    for (const body of this.frames.push(chunk)) {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(body) as Record<string, unknown>;
      } catch {
        continue;
      }
      this.onMessage(message);
    }
  }

  private onMessage(message: Record<string, unknown>): void {
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        try {
          this.onNotification?.(message.method, message.params ?? null);
        } catch {
          // Listener errors must never break the read loop.
        }
        return;
      }
      // Server→client request: acknowledge permissively so clangd keeps
      // working (progress, capability registration, applyEdit).
      if (message.id !== undefined) {
        this.send({ jsonrpc: "2.0", id: message.id, result: null });
      }
      return;
    }
    const id = message.id;
    if (typeof id !== "number") return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    if (entry.timer) clearTimeout(entry.timer);
    if (message.error) {
      entry.reject(
        new Error(
          typeof message.error === "object" && message.error !== null && "message" in message.error
            ? String((message.error as { message: unknown }).message)
            : "clangd error",
        ),
      );
    } else {
      entry.resolve(message.result ?? null);
    }
  }

  private failAll(err: Error): void {
    for (const [, entry] of this.pending) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
  }
}
