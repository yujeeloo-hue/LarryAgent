
import { type ChildProcess, spawn } from "node:child_process";

export type LspHandler = {
  onDispose?: () => void;
};

const RECV_TIMEOUT_DEFAULT_MS = 120_000;

export class LspFrameReader {
  private buffer: Buffer = Buffer.alloc(0);

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
    private readonly label: string,
  ) {}

  onNotification: ((method: string, params: unknown) => void) | null = null;
  serverCapabilities: Record<string, unknown> | null = null;

  static async start(
    command: string,
    args: string[],
    init: {
      rootUri: string | null;
      initializationOptions?: unknown;
      env?: NodeJS.ProcessEnv;
      onExit?: () => void;
      label?: string;
      textDocumentCapabilities?: Record<string, unknown>;
    },
    cwd: string,
    onLog?: (message: string) => void,
  ): Promise<LspConnection> {
    const conn = new LspConnection(command, args, cwd, init.label ?? "clangd");
    const child = spawn(command, args, {
      cwd,
      ...(init.env ? { env: init.env } : {}),
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    conn.child = child;
    child.on("error", (err) => conn.failAll(err));
    child.on("exit", () => {
      conn.failAll(new Error(`${conn.label} exited`));
      init.onExit?.();
    });
    if (onLog) {
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split(/\r?\n/)) {
          if (line.trim()) onLog(line);
        }
      });
    }
    child.stdout?.on("data", (chunk: Buffer) => conn.onChunk(chunk));

    const initialized = await conn.request(
      "initialize",
      {
        processId: process.pid,
        ...(init.rootUri ? { rootUri: init.rootUri } : {}),
        capabilities: {
          window: {
            workDoneProgress: true,
          },
          textDocument: {
            synchronization: { dynamicRegistration: false, didSave: false },
            references: { dynamicRegistration: false },
            definition: { dynamicRegistration: false },
            rename: { dynamicRegistration: false, prepareSupport: true },
            hover: { dynamicRegistration: false, contentFormat: ["markdown", "plaintext"] },
            completion: {
              dynamicRegistration: false,
              contextSupport: true,
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
            ...init.textDocumentCapabilities,
          },
          workspace: {
            workspaceFolders: false,
            configuration: false,
            didChangeWatchedFiles: { dynamicRegistration: true },
          },
        },
        ...(init.initializationOptions !== undefined
          ? { initializationOptions: init.initializationOptions }
          : {}),
      },
      60_000,
    );
    const capabilities = (initialized as { capabilities?: unknown } | null)?.capabilities;
    conn.serverCapabilities =
      capabilities && typeof capabilities === "object" ? (capabilities as Record<string, unknown>) : null;
    conn.notify("initialized", {});
    return conn;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

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
              reject(new Error(`${this.label} request "${method}" timed out after ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      if (signal) {
        if (signal.aborted) {
          if (timer) clearTimeout(timer);
          onAbort();
          reject(new Error(`${this.label} request "${method}" cancelled`));
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
            entry.reject(new Error(`${this.label} request "${method}" cancelled`));
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
    this.onNotification = null;
    this.failAll(new Error(`${this.label} connection disposed`));
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.killed) return;
    let sentGraceful = false;
    try {
      if (child.stdin && !child.stdin.destroyed && child.stdin.writable) {
        const shutdown = JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method: "shutdown", params: null });
        const exit = JSON.stringify({ jsonrpc: "2.0", method: "exit", params: null });
        child.stdin.write(
          `Content-Length: ${Buffer.byteLength(shutdown)}\r\n\r\n${shutdown}` +
          `Content-Length: ${Buffer.byteLength(exit)}\r\n\r\n${exit}`,
        );
        child.stdin.end();
        sentGraceful = true;
      }
    } catch {
      sentGraceful = false;
    }
    if (!sentGraceful) {
      try { child.kill(); } catch {  }
      return;
    }
    const forceTimer = setTimeout(() => {
      if (child.exitCode === null && !child.killed) {
        try { child.kill(); } catch {  }
      }
    }, 1_500);
    forceTimer.unref();
    child.once("exit", () => clearTimeout(forceTimer));
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
        }
        return;
      }
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
            : `${this.label} error`,
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
