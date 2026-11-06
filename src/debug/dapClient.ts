/**
 * Minimal DAP JSON-RPC client over a pair of streams (typically lldb-dap stdio).
 */
import type { Readable, Writable } from "node:stream";
import {
  DapFramer,
  encodeDapMessage,
  type DapEvent,
  type DapMessage,
  type DapRequest,
  type DapResponse,
} from "./dapFraming.js";

export type DapReverseRequestHandler = (
  request: DapRequest,
) => Promise<unknown> | unknown;

export type DapClientOptions = {
  readable: Readable;
  writable: Writable;
  /** Per-request timeout. Default 15s. */
  timeoutMs?: number;
  /** Transport-level failures worth surfacing (framing, timeout, stream close). */
  onDiagnostic?: (text: string) => void;
  /**
   * Adapter → client requests (`startDebugging`, `runInTerminal`).
   * Unhandled commands get an empty success so the adapter is not left hanging.
   */
  onReverseRequest?: DapReverseRequestHandler;
};

export type DapEventHandler = (event: DapEvent) => void;

const DEFAULT_TIMEOUT_MS = 15_000;

export class DapError extends Error {
  readonly command: string;
  readonly response: DapResponse;

  constructor(command: string, response: DapResponse) {
    super(formatDapFailure(command, response));
    this.name = "DapError";
    this.command = command;
    this.response = response;
  }
}

/** lldb-dap puts the human text in `body.error.format`, not `message`. */
export function formatDapFailure(command: string, response: DapResponse): string {
  const body = response.body as
    | { error?: { format?: string; variables?: Record<string, string> } }
    | undefined;
  const format = body?.error?.format?.trim();
  if (format) {
    const vars = body?.error?.variables ?? {};
    return format.replace(/\{([A-Za-z0-9_]+)\}/g, (_, key: string) => vars[key] ?? `{${key}}`);
  }
  const message = response.message?.trim();
  if (message) return message;
  return `DAP ${command} failed`;
}

/** lldb-dap rejects `threads` / some pause ids while the process is running. */
export function isDapNotStopped(err: unknown): boolean {
  const text = [
    err instanceof Error ? err.message : String(err),
    err instanceof DapError ? (err.response.message ?? "") : "",
  ].join(" ");
  return /not\s*stopped/i.test(text);
}

type Pending = {
  command: string;
  resolve: (res: DapResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class DapClient {
  private seq = 1;
  private readonly framer = new DapFramer();
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Map<string, Set<DapEventHandler>>();
  private readonly anyListeners = new Set<DapEventHandler>();
  private closed = false;
  private readonly timeoutMs: number;
  private readonly writable: Writable;
  private readonly onDiagnostic: ((text: string) => void) | undefined;
  private onReverseRequest: DapReverseRequestHandler | undefined;

  constructor(opts: DapClientOptions) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.writable = opts.writable;
    this.onDiagnostic = opts.onDiagnostic;
    this.onReverseRequest = opts.onReverseRequest;
    opts.readable.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      let messages: DapMessage[];
      try {
        messages = this.framer.feed(buf);
      } catch (err) {
        this.onDiagnostic?.(
          `framing ${err instanceof Error ? err.message : String(err)}`,
        );
        this.failAll(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      for (const msg of messages) this.dispatch(msg);
    });
    const onEnd = (): void => this.close(new Error("DAP adapter stream closed"));
    opts.readable.on("end", onEnd);
    opts.readable.on("close", onEnd);
    opts.readable.on("error", (err: Error) => this.close(err));
    opts.writable.on("error", (err: Error) => this.close(err));
  }

  onEvent(event: string, handler: DapEventHandler): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(handler);
    return () => {
      set?.delete(handler);
    };
  }

  onAnyEvent(handler: DapEventHandler): () => void {
    this.anyListeners.add(handler);
    return () => {
      this.anyListeners.delete(handler);
    };
  }

  waitForEvent(
    event: string,
    opts?: { timeoutMs?: number; predicate?: (body: unknown) => boolean },
  ): Promise<DapEvent> {
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs;
    const predicate = opts?.predicate;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`Timed out waiting for DAP event "${event}"`));
      }, timeoutMs);
      const off = this.onEvent(event, (ev) => {
        if (predicate && !predicate(ev.body)) return;
        clearTimeout(timer);
        off();
        resolve(ev);
      });
    });
  }

  request<T = unknown>(
    command: string,
    args?: unknown,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.closed) return Promise.reject(new Error("DAP client is closed"));
    const seq = this.seq++;
    const msg: DapRequest = { type: "request", seq, command };
    if (args !== undefined) msg.arguments = args;
    const wait = timeoutMs ?? this.timeoutMs;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq);
        this.onDiagnostic?.(`${command} timed out after ${wait}ms`);
        reject(new Error(`DAP ${command} timed out after ${wait}ms`));
      }, wait);
      this.pending.set(seq, {
        command,
        resolve: (res) => {
          if (!res.success) {
            reject(new DapError(command, res));
            return;
          }
          resolve(res.body as T);
        },
        reject,
        timer,
      });
      const ok = this.writable.write(encodeDapMessage(msg));
      if (!ok) {
        /* backpressure — still queued on the stream */
      }
    });
  }

  setReverseRequestHandler(handler: DapReverseRequestHandler | undefined): void {
    this.onReverseRequest = handler;
  }

  dispose(): void {
    this.close(new Error("DAP client disposed"));
  }

  private dispatch(msg: DapMessage): void {
    if (msg.type === "response") {
      const pending = this.pending.get(msg.request_seq);
      if (!pending) return;
      this.pending.delete(msg.request_seq);
      clearTimeout(pending.timer);
      pending.resolve(msg);
      return;
    }
    if (msg.type === "event") {
      for (const handler of this.anyListeners) handler(msg);
      const set = this.listeners.get(msg.event);
      if (set) for (const handler of set) handler(msg);
      return;
    }
    if (msg.type === "request") {
      void this.answerReverseRequest(msg);
    }
  }

  private async answerReverseRequest(req: DapRequest): Promise<void> {
    const respond = (success: boolean, body?: unknown, message?: string): void => {
      if (this.closed) return;
      const response: DapResponse = {
        type: "response",
        seq: this.seq++,
        request_seq: req.seq,
        success,
        command: req.command,
      };
      if (message) response.message = message;
      if (body !== undefined) response.body = body;
      this.writable.write(encodeDapMessage(response));
    };
    try {
      const handler = this.onReverseRequest;
      const body = handler ? await handler(req) : undefined;
      respond(true, body);
    } catch (err) {
      respond(
        false,
        undefined,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  private failAll(err: Error): void {
    for (const [seq, pending] of this.pending) {
      this.pending.delete(seq);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
  }

  private close(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.onDiagnostic?.(err.message);
    this.failAll(err);
  }
}
