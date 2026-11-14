/**
 * Viewer-side relay client: single WS, first-message auth, promise-based
 * request/response, event fan-out, auto reconnect with backoff.
 *
 * E2EE v1 (relays ≥ 1.5): frames are sealed with the subscribed device's
 * stream key (design §10, docs/plans/20261012-e2ee-stream-design.md). The
 * key arrives in the `streamKey` frame on subscribe (console-session
 * viewers) or derives locally from the viewer's own API key. Everything is
 * negotiated via caps — an old relay or a missing key degrades to the
 * legacy plaintext path without breaking.
 */
import type { AuditEntry, DeviceAction, DeviceEventEnvelope, DeviceSummary, KeySummary, PromptLogEntry, ServerInfo } from "./types.js";
import { STREAM_CAP, FrameCipher, keyFromBase64 } from "./streamCipher.js";

interface ServerMsg {
  type: string;
  [key: string]: unknown;
}

export type E2EEState = "off" | "active" | "error";

export interface RelayClientHandlers {
  onDevices: (devices: DeviceSummary[]) => void;
  onEvent: (env: DeviceEventEnvelope) => void;
  onConnectionChange: (state: "connecting" | "online" | "offline") => void;
  onResubscribed: () => void;
  onAuthOk?: (info: { keyId: string; keyName: string; keyTail: string }) => void;
  onKeys?: (keys: KeySummary[]) => void;
  onE2EEState?: (state: E2EEState, detail?: string) => void;
}

export class RelayClient {
  private ws: WebSocket | null = null;
  private sessionToken = "";
  private seq = 0;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>();
  private subscribedDevice: string | null = null;
  private backoff = 1000;
  private closedByUser = false;
  private reconnectTimer: number | null = null;
  /** E2EE v1: relay advertised "e2ee-v1" in authOk. */
  private serverE2EE = false;
  /** Stream key + ciphers for the currently subscribed device. */
  private streamKey: Uint8Array | null = null;
  private v2r: FrameCipher | null = null;
  private r2v: FrameCipher | null = null;
  /** Resolvers waiting for the next streamKey (E2EE v1 request gate). */
  private streamKeyWaiters = new Set<() => void>();

  constructor(private handlers: RelayClientHandlers) {}

  get deviceId(): string | null {
    return this.subscribedDevice;
  }

  connect(sessionToken: string): void {
    this.sessionToken = sessionToken;
    this.closedByUser = false;
    this.open();
  }

  private wsUrl(): string {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    // BASE_URL is "/" at root or "/relay/" when built with RELAY_BASE_PATH.
    const base = import.meta.env.BASE_URL as string;
    return `${proto}//${location.host}${base}ws/viewer`;
  }

  private open(): void {
    this.handlers.onConnectionChange("connecting");
    this.serverE2EE = false;
    this.streamKey = null;
    this.v2r = null;
    this.r2v = null;
    this.handlers.onE2EEState?.("off");
    const ws = new WebSocket(this.wsUrl());
    this.ws = ws;

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify({ type: "auth", sessionToken: this.sessionToken, caps: [STREAM_CAP] }));
    });

    ws.addEventListener("message", (ev) => {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg;
      } catch {
        return;
      }
      void this.dispatch(msg).catch(() => {
        /* per-frame failures already surface via state callbacks */
      });
    });

    ws.addEventListener("close", () => {
      this.failAllPending("connection closed");
      this.ws = null;
      this.handlers.onConnectionChange("offline");
      if (!this.closedByUser) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      /* close event follows */
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer !== null) return;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, this.backoff);
    this.backoff = Math.min(this.backoff * 2, 15000);
  }

  private async dispatch(msg: ServerMsg): Promise<void> {
    switch (msg.type) {
      case "authOk": {
        this.backoff = 1000;
        this.serverE2EE = Array.isArray(msg.caps) && (msg.caps as unknown[]).includes(STREAM_CAP);
        this.handlers.onAuthOk?.({
          keyId: String(msg.keyId ?? ""),
          keyName: String(msg.keyName ?? ""),
          keyTail: String(msg.keyTail ?? ""),
        });
        this.handlers.onConnectionChange("online");
        if (this.subscribedDevice) {
          this.send({ type: "subscribe", deviceId: this.subscribedDevice });
          this.handlers.onResubscribed();
        }
        this.send({ type: "devices" });
        break;
      }
      case "streamKey": {
        // Console-session viewers: the relay hands over the subscribed
        // device's derived stream key (inside TLS; it holds it anyway).
        const key = keyFromBase64(String(msg.key ?? ""));
        if (key) {
          this.armStreamKey(key);
          // Wake any requests gated on the cipher arriving.
          for (const wake of this.streamKeyWaiters) wake();
        }
        break;
      }
      case "devices":
        this.handlers.onDevices(msg.devices as DeviceSummary[]);
        break;
      case "keys":
        this.handlers.onKeys?.(msg.keys as KeySummary[]);
        break;
      case "event": {
        if (msg.enc !== undefined && msg.enc !== null) {
          const inner = this.r2v ? await this.r2v.open(msg.enc) : null;
          if (!inner) {
            this.handlers.onE2EEState?.("error", "unreadable event frame");
            return;
          }
          const value = inner.value as { sessionId?: unknown; event?: unknown };
          this.handlers.onEvent({
            deviceId: String(msg.deviceId),
            sessionId: String(value.sessionId ?? ""),
            event: value.event as DeviceEventEnvelope["event"],
          });
        } else {
          this.handlers.onEvent({
            deviceId: String(msg.deviceId),
            sessionId: String(msg.sessionId ?? ""),
            event: msg.event as DeviceEventEnvelope["event"],
          });
        }
        break;
      }
      case "res": {
        const pending = this.pending.get(String(msg.requestId));
        if (!pending) return;
        window.clearTimeout(pending.timer);
        this.pending.delete(String(msg.requestId));
        if (msg.enc !== undefined && msg.enc !== null) {
          const inner = this.r2v ? await this.r2v.open(msg.enc) : null;
          if (!inner) {
            pending.reject(new Error("response was unreadable (e2ee)"));
            return;
          }
          const value = inner.value as { result?: unknown; error?: unknown };
          if (msg.ok) pending.resolve(value.result);
          else pending.reject(new Error(String(value.error ?? "request failed")));
        } else if (msg.ok) {
          pending.resolve(msg.result);
        } else {
          pending.reject(new Error(String(msg.error ?? "request failed")));
        }
        break;
      }
      default:
        break;
    }
  }

  /** Adopt a stream key for the subscribed device (delivered or derived). */
  private armStreamKey(key: Uint8Array): void {
    this.streamKey = key;
    this.v2r = new FrameCipher(key, "v2r");
    this.r2v = new FrameCipher(key, "r2v");
    this.handlers.onE2EEState?.(this.serverE2EE ? "active" : "off");
  }

  private send(msg: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private failAllPending(reason: string): void {
    for (const [, p] of this.pending) {
      window.clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  async request<T>(deviceId: string, action: DeviceAction, payload?: unknown, timeoutMs = 25000): Promise<T> {
    this.seq += 1;
    const requestId = `c${this.seq}`;
    // E2EE v1: seal the payload when the relay advertised caps and we hold
    // the ciphers for THIS device (subscribe → streamKey). Anything else —
    // old relay, unsubscribed cross-device request, key not yet arrived —
    // takes the legacy plaintext frame. But if this viewer supports E2EE
    // and the device is the subscribed one, a missing cipher means the
    // streamKey hasn't arrived yet — wait for it instead of sending a
    // plaintext request whose sealed response we then can't decrypt.
    if (this.serverE2EE && this.subscribedDevice === deviceId && !this.v2r) {
      await this.waitForStreamKey(timeoutMs);
    }
    let frame: Record<string, unknown>;
    if (this.serverE2EE && this.subscribedDevice === deviceId && this.v2r) {
      const enc = await this.v2r.seal(payload ?? {});
      const sid = (payload as { sessionId?: unknown } | undefined)?.sessionId;
      frame = { type: "req", requestId, deviceId, action, enc };
      if (typeof sid === "string" && sid) frame.sessionId = sid;
    } else {
      frame = { type: "req", requestId, deviceId, action, payload };
    }
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error("relay timeout"));
      }, timeoutMs);
      this.pending.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      this.send(frame);
    });
  }

  /** Wait for the subscribed device's streamKey (E2EE v1). No-op when the
   * relay doesn't support E2EE or the device never advertises it. */
  private waitForStreamKey(timeoutMs: number): Promise<void> {
    if (this.v2r) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = window.setTimeout(() => {
        this.streamKeyWaiters.delete(resolve);
        resolve(); // fall through to plaintext on timeout
      }, timeoutMs);
      this.streamKeyWaiters.add(() => {
        window.clearTimeout(timer);
        this.streamKeyWaiters.delete(resolve);
        resolve();
      });
    });
  }

  subscribe(deviceId: string): void {
    this.subscribedDevice = deviceId;
    // E2EE v1: ciphers bind to the subscribed device's key — drop the old
    // pair until the fresh streamKey frame arrives (or stay off for an
    // old relay, which sends none).
    this.streamKey = null;
    this.v2r = null;
    this.r2v = null;
    this.handlers.onE2EEState?.("off");
    this.send({ type: "subscribe", deviceId });
  }

  requestAudit(limit = 200): Promise<AuditEntry[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("relay timeout"));
      }, 10000);
      this.send({ type: "audit", limit });
      // Response arrives as {type:"audit", logs}; route through a one-shot.
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "audit") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(msg.logs as AuditEntry[]);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
    });
  }

  /** Clear the server-side audit ring; resolves with the fresh (single-entry) log. */
  clearAudit(): Promise<AuditEntry[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("relay timeout"));
      }, 10000);
      this.send({ type: "auditClear" });
      // Hub answers with the same {type:"audit"} frame holding the wiped log.
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "audit") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(msg.logs as AuditEntry[]);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
    });
  }

  requestPrompts(limit = 200): Promise<PromptLogEntry[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("relay timeout"));
      }, 10000);
      this.send({ type: "prompts", limit });
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "prompts") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(msg.logs as PromptLogEntry[]);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
    });
  }

  serverInfo(): Promise<ServerInfo> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("relay timeout"));
      }, 10000);
      this.send({ type: "serverInfo" });
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "serverInfo") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(msg.info as ServerInfo);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
    });
  }

  rotateKey(keyId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        reject(new Error("relay timeout"));
      }, 10000);
      this.send({ type: "rotateKey", keyId });
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keyRotated") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(String(msg.key));
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            reject(new Error(String(msg.message ?? "rotate failed")));
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "rotateKey", keyId });
    });
  }

  listKeys(): Promise<KeySummary[]> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("relay timeout")), 10000);
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keys") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(msg.keys as KeySummary[]);
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "listKeys" });
    });
  }

  createKey(name: string): Promise<{ key: string; summary: KeySummary }> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("relay timeout")), 10000);
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keyCreated") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve({ key: String(msg.key), summary: msg.summary as KeySummary });
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            reject(new Error(String(msg.message ?? "create failed")));
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "createKey", name });
    });
  }

  /** Fetch a key's plaintext (admin console only) and hand it to the caller. */
  revealKey(keyId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("relay timeout")), 10000);
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keyRevealed" && String(msg.keyId) === keyId) {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve(String(msg.key));
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            reject(new Error(String(msg.message ?? "reveal failed")));
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "revealKey", keyId });
    });
  }

  renameKey(keyId: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("relay timeout")), 10000);
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keys") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve();
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            reject(new Error(String(msg.message ?? "rename failed")));
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "renameKey", keyId, name });
    });
  }

  deleteKey(keyId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("relay timeout")), 10000);
      const onMessage = (ev: MessageEvent) => {
        try {
          const msg = JSON.parse(String(ev.data)) as ServerMsg;
          if (msg.type === "keys") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            resolve();
          } else if (msg.type === "error") {
            window.clearTimeout(timer);
            this.ws?.removeEventListener("message", onMessage);
            reject(new Error(String(msg.message ?? "delete failed")));
          }
        } catch {
          /* ignore */
        }
      };
      this.ws?.addEventListener("message", onMessage);
      this.send({ type: "deleteKey", keyId });
    });
  }

  blockDevice(deviceId: string, blocked: boolean): void {
    this.send({ type: "blockDevice", deviceId, blocked });
  }

  removeDevice(deviceId: string): void {
    this.send({ type: "removeDevice", deviceId });
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.failAllPending("disconnected");
    this.ws?.close();
    this.ws = null;
  }
}
