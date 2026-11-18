import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { IncomingMessage } from "node:http";
import { randomUUID } from "node:crypto";
import { clientIpOf } from "./auth.js";
import { RelayStore } from "./store.js";
import { verifySessionToken } from "./auth.js";
import {
   AUDITED_ACTIONS,
   requestTimeoutMsFor,
  safeParseJson,
  type DeviceAction,
  type DeviceInfo,
  type DeviceMaintenanceState,
  type DeviceSummary,
  type DeviceToServerMsg,
  type KeySummary,
  type PromptLogEntry,
  type ServerInfo,
  type ServerToDeviceMsg,
  type ServerToViewerMsg,
  type ViewerToServerMsg,
} from "./protocol.js";
import type { KeyRecord } from "./store.js";
import { STREAM_CAP, deriveStreamKey, FrameCipher } from "./streamCipher.js";

export const RELAY_VERSION = "1.7.0";
const AUTH_TIMEOUT_MS = 5000;

const HEARTBEAT_MS = 20000;
const CLOSE_REPLACED = 4409;
const CLOSE_KEY_REVOKED = 4003;
const CLOSE_ADMIN = 4010;

interface DeviceConn {
  ws: WebSocket;
  deviceId: string;
  keyId: string;
  alive: boolean;
  runningSessions: number;
  maintenance: DeviceMaintenanceState | null;
  streamKey: Buffer;
  d2r: FrameCipher | null;
  r2d: FrameCipher | null;
}

interface ViewerConn {
  ws: WebSocket;
  authed: boolean;
  keyRecord: KeyRecord | null;
  username: string;
  subscribedDevice: string | null;
  alive: boolean;
  caps: Set<string>;
  v2r: FrameCipher | null;
  r2v: FrameCipher | null;
}

interface PendingReq {
  viewerWs: WebSocket | null;
  deviceId: string;
  viewerRequestId: string;
  timer: ReturnType<typeof setTimeout>;
  resolve?: (value: { ok: boolean; result: unknown }) => void;
}

interface HubOptions {
  store: RelayStore;
  onKeyRotated?: (keyId: string, oldKey: string, newKey: string) => void;
}

export class Hub {
  readonly store: RelayStore;
  private devices = new Map<string, DeviceConn>();
  private viewers = new Map<WebSocket, ViewerConn>();
  private pending = new Map<string, PendingReq>();
  private startedAt = Date.now();
  private viewerSeq = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private wss: WebSocketServer | null = null;
  private readonly onKeyRotated?: HubOptions["onKeyRotated"];

  constructor(opts: HubOptions) {
    this.store = opts.store;
    this.onKeyRotated = opts.onKeyRotated;
  }

  attach(wss: WebSocketServer): void {
    this.wss = wss;
    wss.on("connection", (ws, req) => this.onConnection(ws, req));
    this.heartbeatTimer = setInterval(() => this.heartbeat(), HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  dispose(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    for (const [, p] of this.pending) clearTimeout(p.timer);
    this.pending.clear();
    const deviceSockets = [...this.devices.values()].map((d) => d.ws);
    const viewerSockets = [...this.viewers.keys()];
    this.devices.clear();
    this.viewers.clear();
    for (const ws of viewerSockets) ws.close();
    for (const ws of deviceSockets) ws.close();
  }

  private onConnection(ws: WebSocket, req: IncomingMessage): void {
    ws.on("error", (err: NodeJS.ErrnoException & { code?: string }) => {
      console.warn(`[jellybot-relay] socket error: ${err.message} (${err.code ?? "unknown"})`);
      try {
        ws.close(1011, "socket error");
      } catch {
        ws.terminate();
      }
    });
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/ws/device") {
      this.onDeviceSocket(ws, req);
    } else if (url.pathname === "/ws/viewer") {
      this.onViewerSocket(ws, req);
    } else {
      ws.close(4004, "unknown endpoint");
    }
  }

  private send(ws: WebSocket, msg: unknown): void {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  private bearerFromReq(req: IncomingMessage): string | null {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) return header.slice(7).trim() || null;
    return null;
  }

  private kickDevice(conn: DeviceConn, code: number, reason: string): void {
    this.send(conn.ws, { type: "kick", reason } satisfies ServerToDeviceMsg);
    try {
      conn.ws.close(code, reason);
    } catch {
      conn.ws.terminate();
    }
    this.devices.delete(conn.deviceId);
    this.store.markOffline(conn.deviceId);
    this.appendAudit("relay", "deviceKick", `${conn.deviceId} · ${reason}`);
    console.log(`[jellybot-relay] kick device=${conn.deviceId} code=${code} reason="${reason}"`);
  }

  private onDeviceSocket(ws: WebSocket, req: IncomingMessage): void {
    let authed = false;
    let authKey: KeyRecord | null = null;
    let registered: DeviceConn | null = null;
    const clientIp = clientIpOf(req);
    const userAgent = req.headers["user-agent"];

    const fail = (reason: string) => ws.close(4001, reason);
    const bearer = this.bearerFromReq(req);
    if (bearer !== null) {
      const rec = this.store.checkKey(bearer);
      if (rec) {
        authed = true;
        authKey = rec;
      } else {
        fail("bad api key");
        return;
      }
    }

    const authTimer = setTimeout(() => {
      if (!authed) fail("auth timeout");
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      const parsed = safeParseJson(String(raw)) as DeviceToServerMsg | undefined;
      if (!parsed || typeof parsed.type !== "string") return;

      if (parsed.type === "auth" && !authed) {
        const rec = this.store.checkKey(parsed.apiKey);
        if (rec) {
          authed = true;
          authKey = rec;
        } else fail("bad api key");
        return;
      }
      if (!authed || !authKey) return;

      try {
        switch (parsed.type) {
        case "hello": {
          const info = parsed.device as DeviceInfo;
          if (!info?.deviceId) {
            fail("hello missing deviceId");
            return;
          }
          if (this.store.isBlocked(info.deviceId)) {
            this.appendAudit("device", "blockedLogin", info.deviceId);
            fail("device blocked");
            return;
          }
          const prev = this.devices.get(info.deviceId);
          if (prev && prev.ws !== ws) {
            this.kickDevice(prev, CLOSE_REPLACED, "replaced by new connection");
          }
          const deviceCaps = new Set<string>(
            Array.isArray(parsed.caps) ? parsed.caps.filter((c): c is string => typeof c === "string") : [],
          );
          const rec = this.store.upsertDevice({
            deviceId: info.deviceId,
            name: info.name || info.deviceId,
            platform: info.platform ?? "",
            version: info.version ?? "",
            keyId: authKey.id,
            ip: clientIp,
            ua: userAgent,
            ...(deviceCaps.size > 0
              ? { caps: [...deviceCaps].filter((cap) => cap !== STREAM_CAP) }
              : {}),
          });
          const streamKey = deriveStreamKey(authKey.key);
          const e2ee = deviceCaps.has(STREAM_CAP);
          registered = {
            ws,
            deviceId: rec.deviceId,
            keyId: authKey.id,
            alive: true,
            runningSessions: 0,
            maintenance: null,
            streamKey,
            d2r: e2ee ? new FrameCipher(streamKey, "d2r") : null,
            r2d: e2ee ? new FrameCipher(streamKey, "r2d") : null,
          };
          this.devices.set(rec.deviceId, registered);
          clearTimeout(authTimer);
          this.appendAudit("device", "hello", `${rec.name} · ${rec.version} · key:${authKey.name} · ip=${clientIp}`);
          this.send(ws, { type: "welcome", viewers: this.subscriberCount(rec.deviceId), caps: [STREAM_CAP] } satisfies ServerToDeviceMsg);
          this.deliverStreamKeys(rec.deviceId);
          this.broadcastDevices();
          break;
        }
        case "event": {
          if (!registered) return;
          this.store.markSeen(registered.deviceId);
          let sessionId: unknown = parsed.sessionId;
          let event: unknown = parsed.event;
          if (parsed.enc !== undefined) {
            if (!registered.d2r) return;
            const opened = registered.d2r.open(parsed.enc);
            if (!opened) {
              console.warn(`[jellybot-relay] e2ee event unseal failed device=${registered.deviceId}`);
              return;
            }
            const inner = opened.value as { sessionId?: unknown; event?: unknown };
            sessionId = inner.sessionId;
            event = inner.event;
          }
          for (const [vws, v] of this.viewers) {
            if (!v.authed || v.subscribedDevice !== registered.deviceId) continue;
            if (v.caps.has(STREAM_CAP) && v.r2v) {
              this.send(vws, {
                type: "event",
                deviceId: registered.deviceId,
                enc: v.r2v.seal({ sessionId, event }),
              } satisfies ServerToViewerMsg);
            } else {
              this.send(vws, {
                type: "event",
                deviceId: registered.deviceId,
                sessionId: sessionId as string,
                event,
              } satisfies ServerToViewerMsg);
            }
          }
          break;
        }
        case "status": {
          if (!registered) return;
          this.store.markSeen(registered.deviceId);
          let changed = false;
          if (typeof parsed.runningSessions === "number" && Number.isFinite(parsed.runningSessions)) {
            const n = Math.max(0, Math.floor(parsed.runningSessions));
            if (registered.runningSessions !== n) {
              registered.runningSessions = n;
              changed = true;
            }
          }
          if (parsed.maintenance && typeof parsed.maintenance === "object") {
            const prev = JSON.stringify(registered.maintenance);
            const next = JSON.stringify(parsed.maintenance);
            if (prev !== next) {
              registered.maintenance = parsed.maintenance;
              changed = true;
            }
          }
          if (changed) this.broadcastDevices();
          break;
        }
        case "res": {
          const pending = this.pending.get(parsed.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.pending.delete(parsed.requestId);
          let result: unknown = parsed.ok ? parsed.result : parsed.error ?? "device error";
          if (parsed.enc !== undefined) {
            const dev = this.devices.get(pending.deviceId);
            const opened = dev?.d2r ? dev.d2r.open(parsed.enc) : null;
            if (!opened) {
              console.warn(`[jellybot-relay] e2ee res unseal failed device=${pending.deviceId}`);
              if (pending.resolve) {
                pending.resolve({ ok: false, result: "device response was unreadable (e2ee)" });
                return;
              }
              if (pending.viewerWs) {
                this.send(pending.viewerWs, { type: "res", requestId: pending.viewerRequestId, ok: false, error: "device response was unreadable (e2ee)" } satisfies ServerToViewerMsg);
              }
              return;
            }
            const inner = opened.value as { result?: unknown; error?: unknown };
            result = parsed.ok ? inner.result : inner.error ?? "device error";
          }
          if (pending.resolve) {
            pending.resolve({ ok: parsed.ok, result });
            return;
          }
          if (!pending.viewerWs) return;
          const viewer = this.viewers.get(pending.viewerWs);
          if (parsed.ok && viewer?.caps.has(STREAM_CAP) && viewer.r2v) {
            this.send(pending.viewerWs, {
              type: "res",
              requestId: pending.viewerRequestId,
              ok: true,
              enc: viewer.r2v.seal({ result }),
            } satisfies ServerToViewerMsg);
          } else if (!parsed.ok && viewer?.caps.has(STREAM_CAP) && viewer.r2v) {
            this.send(pending.viewerWs, {
              type: "res",
              requestId: pending.viewerRequestId,
              ok: false,
              enc: viewer.r2v.seal({ error: String(result) }),
            } satisfies ServerToViewerMsg);
          } else {
            this.send(pending.viewerWs, {
              type: "res",
              requestId: pending.viewerRequestId,
              ok: parsed.ok,
              ...(parsed.ok ? { result } : { error: String(result) }),
            } satisfies ServerToViewerMsg);
          }
          break;
        }
        default:
          break;
        }
      } catch (err) {
        console.warn(
          `[jellybot-relay] device message handler error (${parsed.type}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    ws.on("pong", () => {
      if (registered) registered.alive = true;
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      if (registered && this.devices.get(registered.deviceId)?.ws === ws) {
        this.devices.delete(registered.deviceId);
        this.store.markOffline(registered.deviceId);
        this.failPendingForDevice(registered.deviceId, "device disconnected");
        this.broadcastDevices();
      }
    });
  }

  private failPendingForDevice(deviceId: string, reason: string): void {
    for (const [requestId, p] of this.pending) {
      if (p.deviceId !== deviceId) continue;
      clearTimeout(p.timer);
      this.pending.delete(requestId);
      if (p.resolve) {
        p.resolve({ ok: false, result: reason });
        continue;
      }
      if (p.viewerWs) {
        this.send(p.viewerWs, { type: "res", requestId: p.viewerRequestId, ok: false, error: reason } satisfies ServerToViewerMsg);
      }
    }
  }

  private onViewerSocket(ws: WebSocket, req: IncomingMessage): void {
    const conn: ViewerConn = {
      ws,
      authed: false,
      keyRecord: null,
      username: "",
      subscribedDevice: null,
      alive: true,
      caps: new Set<string>(),
      v2r: null,
      r2v: null,
    };
    this.viewers.set(ws, conn);
    const clientIp = clientIpOf(req);

    const authTimer = setTimeout(() => {
      if (!conn.authed) ws.close(4001, "auth timeout");
    }, AUTH_TIMEOUT_MS);

    ws.on("message", (raw) => {
      const parsed = safeParseJson(String(raw)) as ViewerToServerMsg | undefined;
      if (!parsed || typeof parsed.type !== "string") return;

      if (parsed.type === "auth" && !conn.authed) {
        let rec: import("./store.js").KeyRecord | null = null;
        let viewerName = "";
        if (typeof parsed.sessionToken === "string" && parsed.sessionToken.length > 0) {
          const session = verifySessionToken(parsed.sessionToken);
          if (session) viewerName = session.username;
        } else if (typeof parsed.apiKey === "string") {
          rec = this.store.checkKey(parsed.apiKey);
          if (rec) viewerName = rec.name;
        }
        if (rec || viewerName) {
          conn.authed = true;
          conn.keyRecord = rec;
          conn.username = viewerName || rec?.name || "";
          if (Array.isArray(parsed.caps)) {
            for (const cap of parsed.caps) {
              if (typeof cap === "string" && cap.length <= 32) conn.caps.add(cap);
            }
          }
          clearTimeout(authTimer);
          this.send(ws, {
            type: "authOk",
            keyTail: rec ? rec.key.slice(-4) : "",
            keyName: viewerName,
            keyId: rec ? rec.id : "",
            ...(conn.caps.has(STREAM_CAP) ? { caps: [STREAM_CAP] } : {}),
          } satisfies ServerToViewerMsg);
        } else {
          this.appendAudit("viewer", "authFailed", `ip=${clientIp}`);
          this.send(ws, { type: "authFailed" } satisfies ServerToViewerMsg);
          ws.close(4001, "bad api key");
        }
        return;
      }
      if (!conn.authed) return;

      try {
        switch (parsed.type) {
        case "devices":
          this.send(ws, { type: "devices", devices: this.deviceSummaries() } satisfies ServerToViewerMsg);
          break;
        case "subscribe": {
          if (typeof parsed.deviceId !== "string") break;
          const prev = conn.subscribedDevice;
          if (prev === parsed.deviceId) break;
          conn.subscribedDevice = parsed.deviceId;
          conn.v2r = null;
          conn.r2v = null;
          if (prev) this.pushPresence(prev);
          this.pushPresence(parsed.deviceId);
          this.deliverStreamKeys(parsed.deviceId);
          break;
        }
        case "audit":
          this.send(ws, { type: "audit", logs: this.store.recentAudit(parsed.limit ?? 200) } satisfies ServerToViewerMsg);
          break;
        case "auditClear": {
          this.store.clearAudit();
          this.appendAudit("viewer", "auditClear", conn.username || "viewer");
          this.send(ws, { type: "audit", logs: this.store.recentAudit() } satisfies ServerToViewerMsg);
          break;
        }
        case "prompts":
          this.send(ws, { type: "prompts", logs: this.store.recentPrompts(parsed.limit ?? 200) } satisfies ServerToViewerMsg);
          break;
        case "serverInfo":
          this.send(ws, { type: "serverInfo", info: this.serverInfo() } satisfies ServerToViewerMsg);
          break;
        case "listKeys":
          this.send(ws, { type: "keys", keys: this.store.keySummaries() } satisfies ServerToViewerMsg);
          break;
        case "createKey": {
          const rec = this.store.createKey(String(parsed.name ?? ""));
          this.appendAudit("viewer", "createKey", rec.name);
          this.send(ws, {
            type: "keyCreated",
            key: rec.key,
            summary: this.summaryFor(rec),
          } satisfies ServerToViewerMsg);
          this.broadcastKeys();
          break;
        }
        case "renameKey": {
          const ok = this.store.renameKey(parsed.keyId, String(parsed.name ?? ""));
          if (ok) {
            this.appendAudit("viewer", "renameKey", `${parsed.keyId} → ${parsed.name}`);
            this.broadcastKeys();
            this.broadcastDevices();
          } else {
            this.send(ws, { type: "error", message: "no such key" } satisfies ServerToViewerMsg);
          }
          break;
        }
        case "deleteKey": {
          const result = this.store.deleteKey(parsed.keyId);
          if (!result.ok) {
            this.send(ws, { type: "error", message: result.reason ?? "cannot delete key" } satisfies ServerToViewerMsg);
            break;
          }
          this.appendAudit("viewer", "deleteKey", parsed.keyId);
          for (const [, d] of this.devices) {
            if (d.keyId === parsed.keyId) {
              this.kickDevice(d, CLOSE_KEY_REVOKED, "api key deleted");
            }
          }
          for (const [vws, v] of this.viewers) {
            if (v.keyRecord?.id === parsed.keyId && vws !== ws) vws.close(4003, "api key deleted");
          }
          this.broadcastKeys();
          this.broadcastDevices();
          break;
        }
        case "rotateKey": {
          const before = this.store.keyById(parsed.keyId);
          if (!before) {
            this.send(ws, { type: "error", message: "no such key" } satisfies ServerToViewerMsg);
            break;
          }
          const fresh = this.store.rotateKeyById(parsed.keyId);
          if (!fresh) {
            this.send(ws, { type: "error", message: "rotate failed" } satisfies ServerToViewerMsg);
            break;
          }
          if (conn.keyRecord?.id === fresh.id) conn.keyRecord = fresh;
          this.appendAudit("viewer", "rotateKey", `${before.name} → ••••${fresh.key.slice(-4)}`);
          try {
            this.onKeyRotated?.(fresh.id, before.key, fresh.key);
          } catch (err) {
            console.warn(`[jellybot-relay] memory rekey failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          this.send(ws, { type: "keyRotated", key: fresh.key } satisfies ServerToViewerMsg);
          for (const [, d] of this.devices) {
            if (d.keyId === parsed.keyId) {
              this.kickDevice(d, CLOSE_KEY_REVOKED, "api key rotated");
            }
          }
          for (const [vws, v] of this.viewers) {
            if (v.keyRecord?.id === fresh.id && vws !== ws) vws.close(4003, "api key rotated");
          }
          for (const [, d] of this.devices) {
            if (d.keyId === fresh.id) this.deliverStreamKeys(d.deviceId);
          }
          this.broadcastKeys();
          this.broadcastDevices();
          break;
        }
        case "revealKey": {
          if (conn.keyRecord) {
            this.send(ws, { type: "error", message: "reveal is admin-console only" } satisfies ServerToViewerMsg);
            break;
          }
          const rec = this.store.keyById(parsed.keyId);
          if (!rec) {
            this.send(ws, { type: "error", message: "no such key" } satisfies ServerToViewerMsg);
            break;
          }
          this.appendAudit("viewer", "revealKey", rec.name);
          this.send(ws, { type: "keyRevealed", keyId: rec.id, key: rec.key } satisfies ServerToViewerMsg);
          break;
        }
        case "blockDevice": {
          const ok = this.store.setBlocked(parsed.deviceId, parsed.blocked);
          if (ok && parsed.blocked) {
            const connDev = this.devices.get(parsed.deviceId);
            if (connDev) {
              this.kickDevice(connDev, CLOSE_ADMIN, "blocked by admin");
            }
          }
          this.appendAudit("viewer", "blockDevice", `${parsed.deviceId} → ${parsed.blocked}`);
          this.broadcastDevices();
          break;
        }
        case "removeDevice": {
          const connDev = this.devices.get(parsed.deviceId);
          if (connDev) {
            this.kickDevice(connDev, CLOSE_ADMIN, "removed by admin");
          }
          this.store.removeDevice(parsed.deviceId);
          for (const v of this.viewers.values()) {
            if (v.subscribedDevice === parsed.deviceId) v.subscribedDevice = null;
          }
          this.appendAudit("viewer", "removeDevice", parsed.deviceId);
          this.broadcastDevices();
          break;
        }
        case "req": {
          this.routeRequest(ws, parsed.requestId, parsed.deviceId, parsed.action, parsed.payload, parsed.enc, parsed.sessionId);
          break;
        }
        default:
          break;
        }
      } catch (err) {
        console.warn(
          `[jellybot-relay] viewer message handler error (${parsed.type}): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });

    ws.on("pong", () => {
      conn.alive = true;
    });

    ws.on("close", () => {
      clearTimeout(authTimer);
      this.viewers.delete(ws);
      if (conn.subscribedDevice) this.pushPresence(conn.subscribedDevice);
      for (const [requestId, p] of this.pending) {
        if (p.viewerWs === ws) {
          clearTimeout(p.timer);
          this.pending.delete(requestId);
        }
      }
    });
  }

  isDeviceOnline(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  callDevice(deviceId: string, action: DeviceAction, payload: unknown = {}): Promise<unknown> {
    const dev = this.devices.get(deviceId);
    if (!dev) return Promise.reject(new Error("device offline"));
    this.viewerSeq += 1;
    const relayRequestId = `r${this.viewerSeq}-${newRequestId()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(relayRequestId);
        reject(new Error("device timeout"));
      }, requestTimeoutMsFor(action));
      this.pending.set(relayRequestId, {
        viewerWs: null,
        deviceId,
        viewerRequestId: relayRequestId,
        timer,
        resolve: (value) => {
          if (value.ok) resolve(value.result);
          else reject(new Error(String(value.result)));
        },
      });
      const msg: ServerToDeviceMsg = dev.r2d
        ? { type: "req", requestId: relayRequestId, action, enc: dev.r2d.seal(payload ?? {}) }
        : { type: "req", requestId: relayRequestId, action, payload };
      try {
        dev.ws.send(JSON.stringify(msg));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(relayRequestId);
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      if (AUDITED_ACTIONS.has(action)) {
        this.appendAudit("relay", action, `${deviceId} · ${summarizePayload(payload)}`);
      }
    });
  }

  private routeRequest(
    viewerWs: WebSocket,
    viewerRequestId: string,
    deviceId: string,
    action: string,
    payload: unknown,
    enc?: unknown,
    plainSessionId?: string,
  ): void {
    const dev = this.devices.get(deviceId);
    if (!dev) {
      this.send(viewerWs, { type: "res", requestId: viewerRequestId, ok: false, error: "device offline" } satisfies ServerToViewerMsg);
      return;
    }
    if (enc !== undefined) {
      const viewer = this.viewers.get(viewerWs);
      const opened = viewer?.v2r ? viewer.v2r.open(enc) : null;
      if (!opened) {
        console.warn(`[jellybot-relay] e2ee req unseal failed device=${deviceId}`);
        this.send(viewerWs, { type: "res", requestId: viewerRequestId, ok: false, error: "request was unreadable (e2ee)" } satisfies ServerToViewerMsg);
        return;
      }
      payload = opened.value;
    }
    this.viewerSeq += 1;
    const relayRequestId = `v${this.viewerSeq}-${viewerRequestId}`;
    const timer = setTimeout(() => {
      this.pending.delete(relayRequestId);
      this.send(viewerWs, { type: "res", requestId: viewerRequestId, ok: false, error: "device timeout" } satisfies ServerToViewerMsg);
    }, requestTimeoutMsFor(action));
    this.pending.set(relayRequestId, { viewerWs, deviceId, viewerRequestId, timer });
    const msg: ServerToDeviceMsg = dev.r2d
      ? { type: "req", requestId: relayRequestId, action: action as DeviceAction, enc: dev.r2d.seal(payload ?? {}) }
      : { type: "req", requestId: relayRequestId, action: action as DeviceAction, payload };
    dev.ws.send(JSON.stringify(msg));
    if (AUDITED_ACTIONS.has(action)) {
      this.appendAudit("viewer", action, `${deviceId} · ${summarizePayload(payload)}`);
    }
    const promptText = promptTextOf(payload, action);
    if (promptText !== null) {
      const viewer = this.viewers.get(viewerWs);
      const deviceRec = this.store.deviceSummaries().find((d) => d.deviceId === deviceId);
      this.store.appendPrompt({
        ts: Date.now(),
        deviceId,
        deviceName: deviceRec?.name ?? deviceId,
        keyId: dev.keyId,
        keyName: deviceRec?.keyName ?? "",
        actor: viewer?.username || viewer?.keyRecord?.name || "viewer",
        action,
        sessionId: sessionIdOf(payload) ?? (typeof plainSessionId === "string" ? plainSessionId : undefined),
        text: promptText,
      } satisfies PromptLogEntry);
    }
  }

  private summaryFor(rec: KeyRecord): KeySummary {
    const counts = new Map<string, number>();
    for (const d of this.store.deviceSummaries()) {
      if (d.keyId) counts.set(d.keyId, (counts.get(d.keyId) ?? 0) + 1);
    }
    return {
      id: rec.id,
      name: rec.name,
      keyTail: rec.key.slice(-4),
      createdAt: rec.createdAt,
      deviceCount: counts.get(rec.id) ?? 0,
    };
  }

  private broadcastKeys(): void {
    const msg: ServerToViewerMsg = { type: "keys", keys: this.store.keySummaries() };
    for (const [ws, v] of this.viewers) {
      if (v.authed) this.send(ws, msg);
    }
  }

  private subscriberCount(deviceId: string): number {
    let n = 0;
    for (const v of this.viewers.values()) {
      if (v.authed && v.subscribedDevice === deviceId) n += 1;
    }
    return n;
  }

  private pushPresence(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    if (!dev) return;
    this.send(dev.ws, { type: "presence", viewers: this.subscriberCount(deviceId) } satisfies ServerToDeviceMsg);
  }

  private deliverStreamKeys(deviceId: string): void {
    const dev = this.devices.get(deviceId);
    let streamKey: Buffer | null = dev ? dev.streamKey : null;
    let keyId: string | undefined = dev?.keyId;
    if (!streamKey) {
      const rec = this.store.deviceSummaries().find((d) => d.deviceId === deviceId);
      keyId = rec?.keyId;
      const keyRec = keyId ? this.store.keyById(keyId) : null;
      streamKey = keyRec ? deriveStreamKey(keyRec.key) : null;
    }
    if (!streamKey) return;
    for (const [vws, v] of this.viewers) {
      if (!v.authed || !v.caps.has(STREAM_CAP) || v.subscribedDevice !== deviceId) continue;
      v.v2r = new FrameCipher(streamKey, "v2r");
      v.r2v = new FrameCipher(streamKey, "r2v");
      this.send(vws, { type: "streamKey", deviceId, key: streamKey.toString("base64") } satisfies ServerToViewerMsg);
    }
  }

  private deviceSummaries(): DeviceSummary[] {
    const online = new Set(this.devices.keys());
    return this.store.deviceSummaries().map((d) => {
      const conn = this.devices.get(d.deviceId);
      return {
        ...d,
        online: online.has(d.deviceId),
        runningSessions: conn?.runningSessions ?? 0,
        ...(conn?.maintenance ? { maintenance: conn.maintenance } : {}),
      };
    });
  }

  private broadcastDevices(): void {
    const msg: ServerToViewerMsg = { type: "devices", devices: this.deviceSummaries() };
    for (const [ws, v] of this.viewers) {
      if (v.authed) this.send(ws, msg);
    }
  }

  private serverInfo(): ServerInfo {
    return {
      version: RELAY_VERSION,
      uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
      devicesOnline: this.devices.size,
      devicesRegistered: this.deviceSummaries().length,
      viewers: [...this.viewers.values()].filter((v) => v.authed).length,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    };
  }

  private heartbeat(): void {
    for (const [deviceId, d] of this.devices) {
      if (!d.alive) {
        d.ws.terminate();
        this.devices.delete(deviceId);
        this.store.markOffline(deviceId);
        this.broadcastDevices();
        continue;
      }
      d.alive = false;
      d.ws.ping();
    }
    for (const [ws, v] of this.viewers) {
      if (!v.alive) {
        ws.terminate();
        this.viewers.delete(ws);
        continue;
      }
      v.alive = false;
      ws.ping();
    }
  }

  private appendAudit(actor: string, action: string, detail?: string): void {
    this.store.appendAudit({ ts: Date.now(), actor, action, detail });
  }
}

function summarizePayload(payload: unknown): string {
  if (payload == null) return "";
  if (typeof payload === "object") {
    const p = payload as Record<string, unknown>;
    if (typeof p.modelId === "string" && typeof p.baseUrl === "string") {
      return `${p.modelId} · ${String(p.baseUrl).slice(0, 48)}`;
    }
    if (typeof p.providerId === "string") return String(p.providerId).slice(0, 8);
    if (typeof p.text === "string") return `"${p.text.slice(0, 40)}"`;
    if (typeof p.sessionId === "string") return String(p.sessionId);
    if (typeof p.name === "string" && typeof p.path === "string") {
      return `${p.name} · ${p.path.slice(0, 48)}`;
    }
  }
  return "";
}

function promptTextOf(payload: unknown, action: string): string | null {
  if (payload == null || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (action === "respondUserAsk" && typeof p.answer === "string" && p.answer.trim()) return p.answer;
  if (typeof p.text === "string" && p.text.trim()) return p.text;
  return null;
}

function sessionIdOf(payload: unknown): string | undefined {
  if (payload == null || typeof payload !== "object") return undefined;
  const sessionId = (payload as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" ? sessionId : undefined;
}

export function newRequestId(): string {
  return randomUUID().slice(0, 8);
}
