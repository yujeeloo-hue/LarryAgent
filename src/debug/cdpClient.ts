/**
 * Chrome DevTools Protocol client over a JSON WebSocket.
 */
import WebSocket from "ws";

export type CdpEventHandler = (method: string, params: unknown) => void;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export class CdpError extends Error {
  readonly code?: number;
  constructor(message: string, code?: number) {
    super(message);
    this.name = "CdpError";
    if (code !== undefined) this.code = code;
  }
}

export class CdpClient {
  private id = 0;
  private readonly pending = new Map<number, Pending>();
  private readonly listeners = new Set<CdpEventHandler>();
  private readonly closeListeners = new Set<() => void>();
  private closed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly timeoutMs = 15_000,
  ) {
    ws.on("message", (data) => this.onMessage(String(data)));
    const fail = (err: Error): void => this.close(err);
    ws.on("close", () => fail(new Error("CDP socket closed")));
    ws.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
  }

  static connect(url: string, timeoutMs = 15_000): Promise<CdpClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const onOpen = (): void => {
        clearTimeout(timer);
        ws.off("error", onError);
        resolve(new CdpClient(ws, timeoutMs));
      };
      const onError = (err: Error): void => {
        clearTimeout(timer);
        ws.off("open", onOpen);
        reject(err);
      };
      const timer = setTimeout(() => {
        ws.off("open", onOpen);
        ws.off("error", onError);
        ws.close();
        reject(new Error(`Timed out connecting to ${url}`));
      }, timeoutMs);
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
  }

  onEvent(handler: CdpEventHandler): () => void {
    this.listeners.add(handler);
    return () => {
      this.listeners.delete(handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeListeners.add(handler);
    return () => {
      this.closeListeners.delete(handler);
    };
  }

  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("CDP client is closed"));
    const id = ++this.id;
    const payload: Record<string, unknown> = { id, method };
    if (params !== undefined) payload.params = params;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  dispose(): void {
    this.close(new Error("CDP client disposed"));
  }

  private onMessage(text: string): void {
    let msg: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { message?: string; code?: number };
    };
    try {
      msg = JSON.parse(text) as typeof msg;
    } catch {
      return;
    }
    if (typeof msg.method === "string") {
      for (const handler of this.listeners) handler(msg.method, msg.params);
      return;
    }
    if (typeof msg.id !== "number") return;
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    clearTimeout(pending.timer);
    if (msg.error) {
      pending.reject(
        new CdpError(msg.error.message ?? `CDP error ${msg.error.code}`, msg.error.code),
      );
      return;
    }
    pending.resolve(msg.result);
  }

  private close(err: Error): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    const closed = [...this.closeListeners];
    this.closeListeners.clear();
    for (const handler of closed) handler();
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}
