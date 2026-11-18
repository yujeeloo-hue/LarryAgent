import { randomUUID } from "node:crypto";
import { normalizeLlmProviderOptions } from "../llm/apiProtocol.js";
import { sessionForPresentation } from "../session/presentation.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, resolve, sep } from "node:path";
import os from "node:os";
import WebSocket from "ws";
import { STREAM_CAP, deriveStreamKey, FrameCipher } from "./streamCipher.js";
import type { SessionStore } from "../main/sessionRuntime.js";
import type { TextFilePreviewResult } from "../main/filePreview.js";
import type { CocoCommand, CocoSnapshot } from "../coco/types.js";
import {
  collectMentionedFilesFromMessages,
  collectModifiedFilesFromMessages,
  pathKey,
  type MessageLikeForModifiedFiles,
} from "../renderer/src/screens/conversation/turnModifiedFiles.js";
import type { RemoteRelaySettings } from "../settings/types.js";
import type {
  AttachmentDraft,
  EnqueuePromptRequest,
  StartTurnRequest,
  UserAskResponseRequest,
} from "../agent/ipcTypes.js";
import {
  isReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";
import type {
  SyncProviderPublic,
  SyncProviderTransfer,
} from "./providerSync.js";
import type {
  SyncMcpServerPublic,
  SyncMcpServerTransfer,
} from "./mcpSync.js";
import type {
  SyncSkillPublic,
  SyncSkillTransfer,
} from "./skillSync.js";
import type { McpTransport } from "../toolsConfig/types.js";

export type RemoteBridgeStatus =
  | "disabled"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "stopped";

export interface RemoteBridgeEvents {
  onStatusChange?: (status: RemoteBridgeStatus, detail?: string) => void;
  onActivity?: () => void;
  onProvidersChanged?: (options?: { exceptWebContentsId?: number }) => void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocketLike;

export interface WebSocketLike {
  readyState: number;
  OPEN: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  on(event: "open", cb: () => void): unknown;
  on(event: "message", cb: (raw: unknown) => void): unknown;
  on(event: "close", cb: (code: number, reason: Buffer) => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  on(event: "pong", cb: () => void): unknown;
  terminate(): void;
  ping?(): void;
}

export const REMOTE_READ_ONLY_ERROR =
  "Device is in read-only mode — enable Full control in Settings → Remote";

export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 120_000;
export const EXEC_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const EXEC_COMMAND_LIMIT_CHARS = 8_192;

export interface DeviceExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

let execInFlight = false;

function truncateExecOutput(text: string): { text: string; truncated: boolean } {
  if (text.length <= EXEC_OUTPUT_LIMIT_BYTES) return { text, truncated: false };
  return {
    text: `${text.slice(0, EXEC_OUTPUT_LIMIT_BYTES)}\n… [output truncated]`,
    truncated: true,
  };
}

function runDeviceExec(command: string, timeoutMs: number, cwd: string): Promise<DeviceExecResult> {
  const started = Date.now();
  return new Promise((resolvePromise) => {
    try {
      execFile(
        "/bin/sh",
        ["-c", command],
        {
          timeout: timeoutMs,
          maxBuffer: EXEC_OUTPUT_LIMIT_BYTES,
          killSignal: "SIGKILL",
          cwd,
          env: process.env,
        },
        (error, stdout, stderr) => {
          const durationMs = Date.now() - started;
          const out = truncateExecOutput(typeof stdout === "string" ? stdout : "");
          const errOut = truncateExecOutput(typeof stderr === "string" ? stderr : "");
          const maxed =
            error !== null &&
            typeof error === "object" &&
            ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
              String((error as Error).message).includes("maxBuffer"));
          const timedOut =
            !maxed &&
            error !== null &&
            typeof error === "object" &&
            (error as { killed?: boolean }).killed === true;
          const rawCode = error ? (error as { code?: unknown }).code : 0;
          resolvePromise({
            exitCode: typeof rawCode === "number" ? rawCode : null,
            stdout: out.text,
            stderr: errOut.text,
            truncated: out.truncated || errOut.truncated || maxed,
            timedOut,
            durationMs,
          });
        },
      );
    } catch (err) {
      resolvePromise({
        exitCode: null,
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        truncated: false,
        timedOut: false,
        durationMs: Date.now() - started,
      });
    }
  });
}

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;
export const HEARTBEAT_PING_MS = 30_000;
export const HEARTBEAT_PONG_TIMEOUT_MS = 15_000;
const RECONNECT_STABLE_MS = 10_000;
const KICK_CLOSE_CODES = new Set([4001, 4003, 4010, 4409]);
const REMOTE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
const TURN_MUTATING_ACTIONS = new Set([
  "startTurn",
  "cancelTurn",
  "pauseTurn",
  "resumeTurn",
  "promoteQueuedPrompt",
  "cocoCommand",
]);

export interface RemoteComposerSnapshot {
  providers: Array<{ id: string; name: string; modelId: string }>;
  activeProviderId: string;
  composerInfinite: boolean;
  reasoningEffort: ReasoningEffort;
  contextLimitTokens?: number;
}

export interface RemotePathDiffStats {
  path: string;
  isRepo: boolean;
  insertions: number;
  deletions: number;
  hasDiff: boolean;
}

export interface RemoteMaintenanceState {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  id?: string;
  source?: string;
  version?: string;
  error?: string;
  logTail?: string;
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  progress?: {
    receivedBytes: number;
    totalBytes?: number;
    bytesPerSec?: number;
    pct?: number;
  };
  ts: number;
}

export interface RemoteDeviceMaintenance {
  status(): unknown | Promise<unknown>;
  currentState(): RemoteMaintenanceState | null;
  restart(): { restarting: boolean; supervisor: string } | Promise<{ restarting: boolean; supervisor: string }>;
  reboot(): { rebooting: boolean } | Promise<{ rebooting: boolean }>;
  update(input: {
    source: string;
    sha256?: string;
    force?: boolean;
    version?: string;
  }): Promise<{ queued: boolean; id: string; mode: "updater" | "in-process" }>;
  checkUpdate(manifestUrl: string): Promise<{ version: string; url: string; sha256?: string } | null>;
  execSupported?: boolean;
}

export interface RemoteCocoEngine {
  snapshot(): CocoSnapshot;
  command(command: CocoCommand): void;
}

export interface RemoteBridgeDeps {
  store: SessionStore;
  getSettings: () => RemoteRelaySettings;
  getApiKey: () => Promise<string | null>;
  appVersion: () => string;
  platform: () => string;
  listHiddenToolCards?: () => string[];
  getComposerSnapshot?: () => Promise<RemoteComposerSnapshot>;
  saveRemoteUpload?: (upload: {
    name: string;
    mimeType: string;
    contentBase64: string;
  }) => Promise<AttachmentDraft | null>;
  remoteUploadDir?: () => string;
  readTextFilePreview?: (path: string) => Promise<TextFilePreviewResult>;
  filterExistingFiles?: (paths: string[]) => Promise<string[]>;
  getPathsDiffStats?: (paths: string[]) => Promise<RemotePathDiffStats[]>;
  homeDir?: () => string;
  deviceMaintenance?: RemoteDeviceMaintenance;
  deviceCaps?: string[];
  providerSync?: {
    list: () => Promise<SyncProviderPublic[]>;
    exportOne: (providerId: string) => Promise<SyncProviderTransfer & { id: string }>;
    upsert: (transfer: SyncProviderTransfer) => Promise<{ id: string; action: "added" | "overwritten" }>;
    remove: (baseUrl: string, modelId: string) => Promise<{ removed: boolean; id?: string }>;
    removeById?: (providerId: string) => Promise<{ removed: boolean; id?: string }>;
  };
  mcpSync?: {
    list: () => SyncMcpServerPublic[];
    exportOne: (serverId: string) => SyncMcpServerTransfer & { id: string };
    upsert: (transfer: SyncMcpServerTransfer) => Promise<{ id: string; action: "added" | "overwritten" }>;
    remove: (serverId: string) => Promise<{ removed: boolean; id?: string }>;
  };
  skillSync?: {
    list: () => SyncSkillPublic[];
    exportOne: (skillId: string) => SyncSkillTransfer & { id: string };
    upsert: (transfer: SyncSkillTransfer) => Promise<{
      id: string;
      action: "added" | "overwritten";
      fileCount: number;
    }>;
    remove: (skillId: string) => Promise<{ removed: boolean; id?: string }>;
  };
  getCoco?: () => RemoteCocoEngine | null;
  events?: RemoteBridgeEvents;
  webSocketFactory?: WebSocketFactory;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
}

function sessionMessagesOf(session: unknown): MessageLikeForModifiedFiles[] {
  const messages = (session as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  const out: MessageLikeForModifiedFiles[] = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const parts = (message as { parts?: unknown }).parts;
    out.push({
      role: typeof role === "string" ? role : "",
      parts: Array.isArray(parts)
        ? (parts.filter(
            (part): part is Record<string, unknown> =>
              !!part && typeof part === "object",
          ) as Array<Record<string, unknown>>)
        : [],
    });
  }
  return out;
}

function sessionScopedPaths(
  store: SessionStore,
  payload: Record<string, unknown>,
):
  | { ok: true; keys: Set<string>; paths: string[] }
  | { ok: false; error: string } {
  const sessionId =
    typeof payload.sessionId === "string" ? payload.sessionId : "";
  if (!sessionId) return { ok: false, error: "sessionId required" };
  const session = store.getSession(sessionId);
  if (!session) return { ok: false, error: "session not found" };

  const messages = sessionMessagesOf(session);
  const modified = collectModifiedFilesFromMessages(messages);
  const mentioned = collectMentionedFilesFromMessages(
    messages,
    modified.map((file) => file.path),
  );
  const keys = new Set<string>();
  for (const file of modified) keys.add(pathKey(file.path));
  for (const file of mentioned) keys.add(pathKey(file.path));
  if (session.planDoc?.path) keys.add(pathKey(session.planDoc.path));

  const paths: string[] = [];
  const raw = Array.isArray(payload.paths) ? payload.paths : [];
  for (const candidate of raw) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    const trimmed = candidate.trim();
    if (!keys.has(pathKey(trimmed))) continue;
    paths.push(trimmed);
  }
  return { ok: true, keys, paths };
}

export interface RemoteBridge {
  start(): Promise<void>;
  stop(): void;
  reconfigure(): Promise<void>;
  handleStreamEvent(payload: { sessionId: string; event: unknown }): void;
  status(): RemoteBridgeStatus;
  pushMaintenanceState(state: RemoteMaintenanceState): void;
  notifyProvidersChanged(options?: { exceptWebContentsId?: number }): void;
}

export function createRemoteBridge(deps: RemoteBridgeDeps): RemoteBridge {
  const {
    store,
    getSettings,
    getApiKey,
    appVersion,
    platform,
    events,
    webSocketFactory = defaultWebSocketFactory,
    setTimeoutFn = (fn, ms) => setTimeout(fn, ms),
    clearTimeoutFn = (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
  } = deps;

  let ws: WebSocketLike | null = null;
  let currentStatus: RemoteBridgeStatus = "stopped";
  let backoff = RECONNECT_BASE_MS;
  let reconnectTimer: unknown = null;
  let stableTimer: unknown = null;
  let heartbeatTimer: unknown = null;
  let pongTimer: unknown = null;
  let generation = 0;
  let helloSent = false;
  let lastRunningCount = -1;
  let viewerCount: number | null = null;
  let streamKey: Buffer | null = null;
  let d2r: FrameCipher | null = null;
  let r2d: FrameCipher | null = null;
  const liveSessions = new Set<string>();

  const setStatus = (s: RemoteBridgeStatus, detail?: string) => {
    currentStatus = s;
    try {
      events?.onStatusChange?.(s, detail);
    } catch {
    }
  };

  const notifyProvidersChanged = (options?: { exceptWebContentsId?: number }): void => {
    try {
      events?.onProvidersChanged?.(options);
    } catch {
    }
    pushProvidersChanged();
  };

  function pushProvidersChanged(): void {
    const settings = getSettings();
    if (!settings.enabled || settings.pushActivity === "off") return;
    if (!ws || ws.readyState !== ws.OPEN || !helloSent) return;
    const payload = { sessionId: "", event: { type: "providers_changed" } };
    if (d2r) {
      sendRaw(ws, { type: "event", enc: d2r.seal(payload) });
    } else {
      sendRaw(ws, { type: "event", ...payload });
    }
    events?.onActivity?.();
  }

  const clearReconnect = () => {
    if (reconnectTimer !== null) {
      clearTimeoutFn(reconnectTimer);
      reconnectTimer = null;
    }
    if (stableTimer !== null) {
      clearTimeoutFn(stableTimer);
      stableTimer = null;
    }
  };

  const clearPongTimer = () => {
    if (pongTimer !== null) {
      clearTimeoutFn(pongTimer);
      pongTimer = null;
    }
  };

  const stopHeartbeat = () => {
    if (heartbeatTimer !== null) {
      clearTimeoutFn(heartbeatTimer);
      heartbeatTimer = null;
    }
    clearPongTimer();
  };

  const startHeartbeat = (socket: WebSocketLike, myGeneration: number) => {
    stopHeartbeat();
    const pingFn = socket.ping;
    if (typeof pingFn !== "function") return;
    const beat = () => {
      heartbeatTimer = null;
      if (generation !== myGeneration || ws !== socket) return;
      if (socket.readyState !== socket.OPEN) return;
      try {
        pingFn.call(socket);
      } catch {
      }
      clearPongTimer();
      pongTimer = setTimeoutFn(() => {
        pongTimer = null;
        if (generation !== myGeneration || ws !== socket) return;
        try {
          socket.terminate();
        } catch {
          try {
            socket.close();
          } catch {
          }
        }
      }, HEARTBEAT_PONG_TIMEOUT_MS);
      (pongTimer as { unref?: () => void }).unref?.();
      heartbeatTimer = setTimeoutFn(beat, HEARTBEAT_PING_MS);
      (heartbeatTimer as { unref?: () => void }).unref?.();
    };
    heartbeatTimer = setTimeoutFn(beat, HEARTBEAT_PING_MS);
    (heartbeatTimer as { unref?: () => void }).unref?.();
  };

  const deviceUrl = (base: string): string => {
    const trimmed = base.trim().replace(/\/+$/, "");
    const normalized = trimmed.replace(/^http:\/\//i, "ws://").replace(/^https:\/\//i, "wss://");
    return `${normalized}/ws/device`;
  };

  async function connect(): Promise<void> {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (!settings.serverUrl.trim()) {
      setStatus("error", "No relay address configured — add it in Settings → Remote");
      return;
    }
    const apiKey = await getApiKey();
    if (!apiKey) {
      setStatus("error", "No API key stored — add it in Settings → Remote");
      return;
    }
    const myGeneration = generation;
    setStatus("connecting");
    const socket = webSocketFactory(deviceUrl(settings.serverUrl), {
      authorization: `Bearer ${apiKey}`,
    });
    ws = socket;

    socket.on("open", () => {
      if (generation !== myGeneration) return;
      helloSent = false;
      viewerCount = null;
      liveSessions.clear();
      streamKey = deriveStreamKey(apiKey);
      d2r = null;
      r2d = null;
      sendRaw(socket, {
        type: "hello",
        device: {
          deviceId: settings.deviceId,
          name: settings.deviceName || "JellyBot",
          platform: platform(),
          version: appVersion(),
        },
        caps: [STREAM_CAP, ...(deps.deviceCaps ?? [])],
      });
      helloSent = true;
      setStatus("connected");
      lastRunningCount = -1;
      pushRunningStatus();
      startHeartbeat(socket, myGeneration);
      if (stableTimer !== null) clearTimeoutFn(stableTimer);
      stableTimer = setTimeoutFn(() => {
        stableTimer = null;
        if (generation === myGeneration && ws === socket && socket.readyState === socket.OPEN) {
          backoff = RECONNECT_BASE_MS;
        }
      }, RECONNECT_STABLE_MS);
      (stableTimer as { unref?: () => void }).unref?.();
    });

    socket.on("message", (raw) => {
      if (generation !== myGeneration) return;
      const msg = safeParse(String(raw as Buffer));
      if (!msg) return;
      void handleMessage(msg).catch(() => {
      });
    });

    socket.on("close", (code, reason) => {
      if (generation !== myGeneration) return;
      stopHeartbeat();
      ws = null;
      d2r = null;
      r2d = null;
      const why = reason?.toString() ?? "";
      const replaced = code === 4409 || why.includes("replaced");
      if (KICK_CLOSE_CODES.has(code) || replaced || why.includes("blocked") || why.includes("api key") || why.includes("removed")) {
        if (replaced) {
          setStatus(
            "stopped",
            "Replaced by another connection from this device — the device ID is shared with another machine (settings backup?)",
          );
          return;
        }
        setStatus("error", `Relay rejected the connection: ${why || code}`);
        return;
      }
      if (getSettings().enabled) {
        setStatus("reconnecting");
        scheduleReconnect();
      }
    });

    socket.on("pong", () => {
      if (generation !== myGeneration || ws !== socket) return;
      clearPongTimer();
    });

    socket.on("error", () => {
    });
  }

  function scheduleReconnect(): void {
    if (reconnectTimer !== null) return;
    const delay = backoff;
    backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function handleMessage(msg: unknown): Promise<void> {
    if (!msg || typeof msg !== "object") return;
    const type = (msg as { type?: unknown }).type;
    if (type === "welcome") {
      const raw = (msg as { viewers?: unknown }).viewers;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        viewerCount = Math.max(0, Math.floor(raw));
      }
      const rawCaps = (msg as { caps?: unknown }).caps;
      const caps = Array.isArray(rawCaps) ? rawCaps.filter((c): c is string => typeof c === "string") : [];
      if (caps.includes(STREAM_CAP) && streamKey) {
        d2r = new FrameCipher(streamKey, "d2r");
        r2d = new FrameCipher(streamKey, "r2d");
      }
      const maintenance = deps.deviceMaintenance?.currentState();
      if (maintenance) pushMaintenanceState(maintenance);
      return;
    }
    if (type === "presence") {
      const raw = (msg as { viewers?: unknown }).viewers;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        const n = Math.max(0, Math.floor(raw));
        if (n !== viewerCount) liveSessions.clear();
        viewerCount = n;
      }
      return;
    }
    if (type === "kick") {
      const raw = (msg as { reason?: unknown }).reason;
      const reason = typeof raw === "string" && raw.trim() ? raw.trim() : "kicked";
      generation += 1;
      clearReconnect();
      stopHeartbeat();
      if (ws) {
        const socket = ws;
        ws = null;
        try {
          socket.close(1000, "kicked");
        } catch {
        }
      }
      if (reason.includes("replaced")) {
        setStatus(
          "stopped",
          "Replaced by another connection from this device — the device ID is shared with another machine (settings backup?)",
        );
      } else {
        setStatus("error", `Relay kicked this device: ${reason}`);
      }
      return;
    }
    if (type !== "req") return;
    const req = msg as {
      requestId: string;
      action: string;
      payload?: Record<string, unknown>;
      enc?: unknown;
    };
    let payload: Record<string, unknown>;
    if (req.enc !== undefined) {
      const opened = r2d ? r2d.open(req.enc) : null;
      if (!opened || typeof opened.value !== "object" || opened.value === null) {
        if (ws) {
          sendRaw(ws, { type: "res", requestId: req.requestId, ok: false, error: "request was unreadable (e2ee)" });
          events?.onActivity?.();
        }
        return;
      }
      payload = opened.value as Record<string, unknown>;
    } else {
      payload = req.payload ?? {};
    }
    let ok: boolean;
    let result: unknown;
    try {
      const outcome = await dispatchAction(req.action, payload);
      if (outcome.ok) {
        ok = true;
        result = outcome.result;
      } else {
        ok = false;
        result = outcome.error;
      }
    } catch (err) {
      ok = false;
      result = err instanceof Error ? err.message : String(err);
    }
    if (ws) {
      sendRaw(
        ws,
        d2r
          ? {
              type: "res",
              requestId: req.requestId,
              ok,
              ...(ok ? { enc: d2r.seal({ result }) } : { enc: d2r.seal({ error: result }) }),
            }
          : { type: "res", requestId: req.requestId, ok, ...(ok ? { result } : { error: result }) },
      );
    }
    events?.onActivity?.();
    if (TURN_MUTATING_ACTIONS.has(req.action)) {
      setTimeoutFn(() => pushRunningStatus(), 250);
    }
  }

  async function dispatchAction(
    action: string,
    payload: Record<string, unknown>,
  ): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
    const settings = getSettings();
    const fullControl = settings.mode === "full";

    switch (action) {
      case "listSessions":
        return { ok: true, result: store.listSessions(payload.includeCoco === true) };
      case "listWorkspaces":
        return {
          ok: true,
          result: store.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.path })),
        };
      case "browseDir": {
        const home = resolve(deps.homeDir?.() ?? os.homedir());
        const raw = typeof payload.path === "string" ? payload.path.trim() : "";
        const target = resolve(raw || home);
        if (target !== home && !target.startsWith(home + sep)) {
          return { ok: false, error: "Only folders inside the home directory can be browsed" };
        }
        let entries: import("node:fs").Dirent[];
        try {
          entries = await readdir(target, { withFileTypes: true });
        } catch (err) {
          return {
            ok: false,
            error: `Cannot open folder: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const dirs = entries
          .filter((e) => e.isDirectory() && !e.name.startsWith("."))
          .map((e) => e.name)
          .sort((a, b) => a.localeCompare(b));
        const parent = dirname(target);
        return {
          ok: true,
          result: { path: target, parent: parent.startsWith(home + sep) || parent === home ? parent : null, dirs },
        };
      }
      case "getSession": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        const session = store.getSession(sessionId);
        if (!session) return { ok: false, error: "session not found" };
        return { ok: true, result: sessionForPresentation(session) };
      }
      case "getHiddenToolCards": {
        return { ok: true, result: deps.listHiddenToolCards?.() ?? [] };
      }
      case "listComposerOptions": {
        const snapshot = await deps.getComposerSnapshot?.();
        if (!snapshot) {
          return { ok: false, error: "composer options unavailable" };
        }
        return {
          ok: true,
          result: {
            providers: snapshot.providers,
            activeProviderId: snapshot.activeProviderId,
            defaults: {
              composerInfinite: snapshot.composerInfinite === true,
              reasoningEffort: snapshot.reasoningEffort,
              ...(typeof snapshot.contextLimitTokens === "number" &&
              snapshot.contextLimitTokens > 0
                ? { contextLimitTokens: snapshot.contextLimitTokens }
                : {}),
            },
            remoteMode: settings.mode,
          },
        };
      }
      case "listSyncProviders": {
        if (!deps.providerSync) {
          return { ok: false, error: "provider sync unavailable on this device" };
        }
        return { ok: true, result: { providers: await deps.providerSync.list() } };
      }
      case "listSyncMcpServers": {
        if (!deps.mcpSync) {
          return { ok: false, error: "MCP sync unavailable on this device" };
        }
        return { ok: true, result: { servers: deps.mcpSync.list() } };
      }
      case "listSyncSkills": {
        if (!deps.skillSync) {
          return { ok: false, error: "skill sync unavailable on this device" };
        }
        return { ok: true, result: { skills: deps.skillSync.list() } };
      }
      case "cocoSnapshot": {
        const coco = deps.getCoco?.() ?? null;
        if (!coco) return { ok: false, error: `unknown action: ${action}` };
        return { ok: true, result: coco.snapshot() };
      }
      case "listPromptQueue": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        return { ok: true, result: store.listPromptQueue(sessionId) };
      }
      case "deviceStatus": {
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "remote maintenance is not available on this device" };
        }
        return { ok: true, result: await maintenance.status() };
      }
      case "readTextFile":
      case "filterExistingFiles":
      case "getPathsDiffStats": {
        const scoped = sessionScopedPaths(store, payload);
        if (!scoped.ok) return scoped;
        if (action === "readTextFile") {
          const preview = deps.readTextFilePreview;
          if (!preview) return { ok: false, error: "text preview unavailable" };
          const path = typeof payload.path === "string" ? payload.path.trim() : "";
          if (!path) return { ok: false, error: "path required" };
          if (!scoped.keys.has(pathKey(path))) {
            return {
              ok: false,
              error: "path is not in this conversation's file list",
            };
          }
          return { ok: true, result: await preview(path) };
        }
        if (action === "filterExistingFiles") {
          const filter = deps.filterExistingFiles;
          return { ok: true, result: filter ? await filter(scoped.paths) : [] };
        }
        const diffStats = deps.getPathsDiffStats;
        return { ok: true, result: diffStats ? await diffStats(scoped.paths) : [] };
      }
      default:
        break;
    }

    if (!fullControl) return { ok: false, error: REMOTE_READ_ONLY_ERROR };

    switch (action) {
      case "cocoCommand": {
        const coco = deps.getCoco?.() ?? null;
        if (!coco) return { ok: false, error: `unknown action: ${action}` };
        const command = payload.command as { type?: unknown } | undefined;
        if (!command || typeof command !== "object" || typeof command.type !== "string" || !command.type) {
          return { ok: false, error: "command required" };
        }
        coco.command(command as CocoCommand);
        return { ok: true, result: { accepted: true } };
      }
      case "createWorkspace": {
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const path = typeof payload.path === "string" ? payload.path.trim() : "";
        if (!name) return { ok: false, error: "name required" };
        if (!path) return { ok: false, error: "path required" };
        if (!isAbsolute(path)) {
          return { ok: false, error: "path must be absolute on this device" };
        }
        const normalized = resolve(path);
        const known = store.listWorkspaces().find((w) => resolve(w.path) === normalized);
        if (known) {
          return {
            ok: true,
            result: { id: known.id, name: known.name, path: known.path, existing: true },
          };
        }
        try {
          const st = await stat(normalized).catch(() => null);
          if (st && !st.isDirectory()) {
            return { ok: false, error: "path exists and is not a folder" };
          }
          if (!st) await mkdir(normalized, { recursive: true });
        } catch (err) {
          return {
            ok: false,
            error: `Cannot create folder: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
        const ws = await store.createWorkspace({ name, path: normalized });
        return { ok: true, result: { id: ws.id, name: ws.name, path: ws.path, existing: false } };
      }
      case "startTurn": {
        const userText = typeof payload.userText === "string" ? payload.userText : "";
        if (!userText.trim()) return { ok: false, error: "userText required" };
        const req: StartTurnRequest = {
          userText,
          fullPermissions: payload.fullPermissions === true,
        };
        if (typeof payload.sessionId === "string") req.sessionId = payload.sessionId;
        if (typeof payload.workspaceId === "string") req.workspaceId = payload.workspaceId;
        if (typeof payload.providerId === "string" && payload.providerId.trim()) {
          req.providerId = payload.providerId.trim();
        }
        if (isReasoningEffort(payload.reasoningEffort)) {
          req.reasoningEffort = payload.reasoningEffort;
        }
        if (typeof payload.composerInfinite === "boolean") {
          req.composerInfinite = payload.composerInfinite;
        }
        const attachments = sanitizeRemoteAttachments(
          payload.attachments,
          deps.remoteUploadDir?.(),
        );
        if (attachments.length > 0) req.attachments = attachments;
        else if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
          return {
            ok: false,
            error: "attachments rejected: upload files through uploadAttachment first",
          };
        }
        return { ok: true, result: await store.startTurn(req) };
      }
      case "enqueuePrompt": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const userText = typeof payload.userText === "string" ? payload.userText : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!userText.trim()) return { ok: false, error: "userText required" };
        const req: EnqueuePromptRequest = { sessionId, userText };
        if (payload.mode === "interrupt" || payload.mode === "deferred") {
          req.mode = payload.mode;
        } else if (payload.mode === "steer") {
          req.mode = "interrupt";
        }
        const attachments = sanitizeRemoteAttachments(
          payload.attachments,
          deps.remoteUploadDir?.(),
        );
        if (attachments.length > 0) req.attachments = attachments;
        else if (Array.isArray(payload.attachments) && payload.attachments.length > 0) {
          return {
            ok: false,
            error: "attachments rejected: upload files through uploadAttachment first",
          };
        }
        return { ok: true, result: store.enqueuePrompt(req) };
      }
      case "promoteQueuedPrompt":
      case "deferQueuedPrompt":
      case "removeQueuedPrompt":
      case "moveQueuedPromptToFront": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const promptId = typeof payload.promptId === "string" ? payload.promptId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!promptId) return { ok: false, error: "promptId required" };
        switch (action) {
          case "promoteQueuedPrompt":
            return { ok: true, result: store.promoteQueuedPrompt(sessionId, promptId) };
          case "deferQueuedPrompt":
            return { ok: true, result: store.deferQueuedPrompt(sessionId, promptId) };
          case "removeQueuedPrompt":
            return { ok: true, result: store.removeQueuedPrompt(sessionId, promptId) };
          default:
            return { ok: true, result: store.moveQueuedPromptToFront(sessionId, promptId) };
        }
      }
      case "updateQueuedPromptText": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const promptId = typeof payload.promptId === "string" ? payload.promptId : "";
        const text = typeof payload.text === "string" ? payload.text : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!promptId) return { ok: false, error: "promptId required" };
        return { ok: true, result: store.updateQueuedPromptText(sessionId, promptId, text) };
      }
      case "removeTurnError": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const messageId = typeof payload.messageId === "string" ? payload.messageId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!messageId) return { ok: false, error: "messageId required" };
        return { ok: true, result: store.removeTurnError(sessionId, messageId) };
      }
      case "cancelTurn": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        return { ok: true, result: store.cancelTurn(sessionId) };
      }
      case "takePromptRestore": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        return { ok: true, result: store.takePromptRestore(sessionId) };
      }
      case "pauseTurn": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        return { ok: true, result: store.pauseTurn(sessionId) };
      }
      case "resumeTurn": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        return {
          ok: true,
          result: await store.resumeTurn({ sessionId, fullPermissions: payload.fullPermissions === true }),
        };
      }
      case "uploadAttachment": {
        if (!deps.saveRemoteUpload) {
          return { ok: false, error: "uploads not supported on this device" };
        }
        const rawName = typeof payload.name === "string" ? payload.name : "";
        const contentBase64 =
          typeof payload.contentBase64 === "string" ? payload.contentBase64 : "";
        const mimeType = typeof payload.mimeType === "string" ? payload.mimeType : "";
        if (!contentBase64) return { ok: false, error: "contentBase64 required" };
        if (base64ByteLength(contentBase64) > REMOTE_UPLOAD_MAX_BYTES) {
          return { ok: false, error: "file exceeds the 8 MB remote upload limit" };
        }
        const draft = await deps.saveRemoteUpload({
          name: sanitizeUploadName(rawName),
          mimeType: mimeType.trim(),
          contentBase64,
        });
        if (!draft) return { ok: false, error: "failed to store upload" };
        return { ok: true, result: draft };
      }
      case "exportSyncProvider": {
        if (!deps.providerSync) {
          return { ok: false, error: "provider sync unavailable on this device" };
        }
        const providerId = typeof payload.providerId === "string" ? payload.providerId.trim() : "";
        if (!providerId) return { ok: false, error: "providerId required" };
        return { ok: true, result: await deps.providerSync.exportOne(providerId) };
      }
      case "upsertSyncProvider": {
        if (!deps.providerSync) {
          return { ok: false, error: "provider sync unavailable on this device" };
        }
        const name = typeof payload.name === "string" ? payload.name : "";
        const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
        const modelId = typeof payload.modelId === "string" ? payload.modelId : "";
        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
        const imageInput =
          payload.imageInput === "base64" || payload.imageInput === "file" || payload.imageInput === "url"
            ? payload.imageInput
            : "url";
        const toolRoleImages =
          payload.toolRoleImages === true
            ? true
            : payload.toolRoleImages === false
              ? false
              : undefined;
        try {
          const result = await deps.providerSync.upsert({
            ...normalizeLlmProviderOptions(payload),
            name,
            baseUrl,
            modelId,
            apiKey,
            supportsMultimodal: payload.supportsMultimodal === true,
            imageInput,
            ...(toolRoleImages !== undefined ? { toolRoleImages } : {}),
            rawEndpoint: payload.rawEndpoint === true,
          });
          notifyProvidersChanged();
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "removeSyncProvider": {
        if (!deps.providerSync) {
          return { ok: false, error: "provider sync unavailable on this device" };
        }
        if (Object.prototype.hasOwnProperty.call(payload, "providerId")) {
          const providerId = typeof payload.providerId === "string" ? payload.providerId.trim() : "";
          if (!providerId) return { ok: false, error: "providerId required" };
          if (!deps.providerSync.removeById) {
            return { ok: false, error: "provider removal by id unavailable on this device" };
          }
          try {
            const result = await deps.providerSync.removeById(providerId);
            if (result.removed && result.id) {
              await store.reassignSessionsUsingProvider(result.id);
            }
            notifyProvidersChanged();
            return { ok: true, result };
          } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
        }
        const baseUrl = typeof payload.baseUrl === "string" ? payload.baseUrl : "";
        const modelId = typeof payload.modelId === "string" ? payload.modelId : "";
        if (!baseUrl.trim() || !modelId.trim()) {
          return { ok: false, error: "baseUrl and modelId required" };
        }
        try {
          const result = await deps.providerSync.remove(baseUrl, modelId);
          if (result.removed && result.id) {
            await store.reassignSessionsUsingProvider(result.id);
          }
          notifyProvidersChanged();
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "exportSyncMcpServer": {
        if (!deps.mcpSync) {
          return { ok: false, error: "MCP sync unavailable on this device" };
        }
        const serverId = typeof payload.serverId === "string" ? payload.serverId.trim() : "";
        if (!serverId) return { ok: false, error: "serverId required" };
        try {
          return { ok: true, result: await deps.mcpSync.exportOne(serverId) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "upsertSyncMcpServer": {
        if (!deps.mcpSync) {
          return { ok: false, error: "MCP sync unavailable on this device" };
        }
        const name = typeof payload.name === "string" ? payload.name : "";
        if (!name.trim()) return { ok: false, error: "name required" };
        try {
          const result = await deps.mcpSync.upsert({
            name,
            enabled: payload.enabled !== false,
            transport: payload.transport as McpTransport,
          });
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "removeSyncMcpServer": {
        if (!deps.mcpSync) {
          return { ok: false, error: "MCP sync unavailable on this device" };
        }
        const serverId = typeof payload.serverId === "string" ? payload.serverId.trim() : "";
        if (!serverId) return { ok: false, error: "serverId required" };
        try {
          return { ok: true, result: await deps.mcpSync.remove(serverId) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "exportSyncSkill": {
        if (!deps.skillSync) {
          return { ok: false, error: "skill sync unavailable on this device" };
        }
        const skillId = typeof payload.skillId === "string" ? payload.skillId.trim() : "";
        if (!skillId) return { ok: false, error: "skillId required" };
        try {
          return { ok: true, result: deps.skillSync.exportOne(skillId) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "upsertSyncSkill": {
        if (!deps.skillSync) {
          return { ok: false, error: "skill sync unavailable on this device" };
        }
        const name = typeof payload.name === "string" ? payload.name : "";
        if (!name.trim()) return { ok: false, error: "name required" };
        if (typeof payload.zipBase64 !== "string" || !payload.zipBase64) {
          return { ok: false, error: "zipBase64 required" };
        }
        try {
          const result = await deps.skillSync.upsert({
            name,
            enabled: payload.enabled !== false,
            description: typeof payload.description === "string" ? payload.description : "",
            zipBase64: payload.zipBase64,
          });
          return { ok: true, result };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "removeSyncSkill": {
        if (!deps.skillSync) {
          return { ok: false, error: "skill sync unavailable on this device" };
        }
        const skillId = typeof payload.skillId === "string" ? payload.skillId.trim() : "";
        if (!skillId) return { ok: false, error: "skillId required" };
        try {
          return { ok: true, result: await deps.skillSync.remove(skillId) };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
      case "setSessionProvider": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        const providerId = typeof payload.providerId === "string" ? payload.providerId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!providerId.trim()) return { ok: false, error: "providerId required" };
        return { ok: true, result: sessionForPresentation(await store.setSessionProvider(sessionId, providerId)) };
      }
      case "setComposerPrefs": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        const raw = (payload.patch ?? {}) as Record<string, unknown>;
        const patch: {
          infinite?: boolean | null;
          reasoningEffort?: ReasoningEffort | null;
        } = {};
        if (typeof raw.infinite === "boolean" || raw.infinite === null) {
          patch.infinite = raw.infinite;
        }
        if (isReasoningEffort(raw.reasoningEffort) || raw.reasoningEffort === null) {
          patch.reasoningEffort = raw.reasoningEffort as ReasoningEffort | null;
        } else if (
          typeof raw.reasoningMax === "boolean" ||
          raw.reasoningMax === null
        ) {
          patch.reasoningEffort =
            raw.reasoningMax === null ? null : raw.reasoningMax ? "max" : "low";
        }
        if (patch.infinite === undefined && patch.reasoningEffort === undefined) {
          return { ok: false, error: "patch must set infinite and/or reasoningEffort" };
        }
        return { ok: true, result: sessionForPresentation(await store.setComposerPrefs(sessionId, patch)) };
      }
      case "respondUserAsk": {
        const requestId = typeof payload.requestId === "string" ? payload.requestId : "";
        if (!requestId) return { ok: false, error: "requestId required" };
        const answer: UserAskResponseRequest = {
          requestId,
          selected: typeof payload.selected === "string" ? payload.selected : null,
          selections: Array.isArray(payload.selections)
            ? (payload.selections.filter((s) => typeof s === "string") as string[])
            : null,
          custom: payload.custom === true,
          ...(typeof payload.comment === "string" ? { comment: payload.comment } : {}),
        };
        return { ok: true, result: store.respondUserAsk(answer) };
      }
      case "respondToolApproval": {
        const result = store.respondToolApproval(payload as never);
        return { ok: true, result };
      }
      case "approvePlan": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        return { ok: true, result: await store.approvePlan(sessionId) };
      }
      case "discardPlan": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        return { ok: true, result: await store.discardPlan(sessionId) };
      }
      case "restartDevice": {
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "remote restart is not available on this device" };
        }
        return { ok: true, result: await maintenance.restart() };
      }
      case "rebootDevice": {
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "system reboot is not available on this device — use restart to relaunch the app" };
        }
        return { ok: true, result: await maintenance.reboot() };
      }
      case "updateDevice": {
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "remote updates are not available on this device" };
        }
        const source = typeof payload.source === "string" ? payload.source.trim() : "";
        if (!source) return { ok: false, error: "source required (release URL or device-local tarball path)" };
        if (/^http:\/\//i.test(source)) {
          return { ok: false, error: "plain-http sources are not allowed (https only)" };
        }
        if (/^https:\/\//i.test(source)) {
          const sha = typeof payload.sha256 === "string" ? payload.sha256.trim().toLowerCase() : "";
          if (!/^[0-9a-f]{64}$/.test(sha)) {
            return { ok: false, error: "sha256 (64 hex chars) is required for URL sources — copy it from the release .sha256 file" };
          }
          const version = typeof payload.version === "string" ? payload.version.trim() : "";
          return {
            ok: true,
            result: await maintenance.update({
              source,
              sha256: sha,
              force: payload.force === true,
              ...(version ? { version } : {}),
            }),
          };
        }
        if (!source.startsWith("/")) {
          return { ok: false, error: "source must be an https URL or an absolute device path" };
        }
        return { ok: true, result: await maintenance.update({ source, force: payload.force === true }) };
      }
      case "checkUpdate": {
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "remote update checks are not available on this device" };
        }
        const manifestUrl = typeof payload.manifestUrl === "string" ? payload.manifestUrl.trim() : "";
        if (!/^https:\/\//i.test(manifestUrl)) {
          return { ok: false, error: "manifestUrl must be an https URL" };
        }
        return { ok: true, result: await maintenance.checkUpdate(manifestUrl) };
      }
      case "deviceExec": {
        if (!deps.deviceMaintenance?.execSupported) {
          return { ok: false, error: "deviceExec is only available on agentd (headless) devices" };
        }
        const command = typeof payload.command === "string" ? payload.command : "";
        if (!command.trim()) return { ok: false, error: "command required" };
        if (command.includes("\0")) {
          return { ok: false, error: "command contains a NUL byte" };
        }
        if (command.length > EXEC_COMMAND_LIMIT_CHARS) {
          return { ok: false, error: `command too long (max ${EXEC_COMMAND_LIMIT_CHARS} chars)` };
        }
        const requested =
          typeof payload.timeoutMs === "number" && Number.isFinite(payload.timeoutMs)
            ? payload.timeoutMs
            : EXEC_DEFAULT_TIMEOUT_MS;
        const timeoutMs = Math.min(Math.max(requested, 1_000), EXEC_MAX_TIMEOUT_MS);
        if (execInFlight) {
          return { ok: false, error: "another command is already running — wait for it to finish" };
        }
        const preferredCwd = deps.homeDir?.() ?? os.homedir();
        const cwd = existsSync(preferredCwd) ? preferredCwd : os.tmpdir();
        execInFlight = true;
        console.warn(
          `[remoteBridge] deviceExec start (timeout ${timeoutMs}ms, cwd ${cwd}): ${command.slice(0, 500)}${command.length > 500 ? "…" : ""}`,
        );
        try {
          const result = await runDeviceExec(command, timeoutMs, cwd);
          console.warn(
            `[remoteBridge] deviceExec done: exit=${String(result.exitCode)} timedOut=${result.timedOut} truncated=${result.truncated} ${result.durationMs}ms`,
          );
          return { ok: true, result };
        } finally {
          execInFlight = false;
        }
      }
      case "deleteSession": {
        const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
        if (!sessionId) return { ok: false, error: "sessionId required" };
        if (!store.getSession(sessionId)) {
          return { ok: false, error: "session not found" };
        }
        const deleted = store.deleteSession(sessionId);
        if (!deleted) {
          return {
            ok: false,
            error:
              "cannot delete right now — a turn is running or the session is compacting; stop it first",
          };
        }
        return { ok: true, result: { deleted: true, sessionId } };
      }
      default:
        return { ok: false, error: `unknown action: ${action}` };
    }
  }

  function sendRaw(socket: WebSocketLike, msg: unknown): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  function pushRunningStatus(): void {
    const settings = getSettings();
    if (!settings.enabled || settings.pushActivity === "off") return;
    if (!ws || ws.readyState !== ws.OPEN || !helloSent) return;
    let running: number;
    try {
      running = store.listSessions().filter((s) => s.status === "running").length;
    } catch {
      return;
    }
    if (running === lastRunningCount) return;
    lastRunningCount = running;
    sendRaw(ws, { type: "status", runningSessions: running });
    events?.onActivity?.();
  }

  function pushMaintenanceState(state: RemoteMaintenanceState): void {
    const settings = getSettings();
    if (!settings.enabled || settings.pushActivity === "off") return;
    if (!ws || ws.readyState !== ws.OPEN || !helloSent) return;
    let running: number;
    try {
      running = store.listSessions().filter((s) => s.status === "running").length;
    } catch {
      running = 0;
    }
    sendRaw(ws, { type: "status", runningSessions: running, maintenance: state });
    events?.onActivity?.();
  }

  const IN_FLIGHT_STATUSES = new Set(["running", "paused"]);

  function storeSessionInFlight(sessionId: string): boolean {
    try {
      return store.listSessions().some((s) => s.id === sessionId && IN_FLIGHT_STATUSES.has(s.status));
    } catch {
      return false;
    }
  }

  function sessionInFlight(sessionId: string, event: { type?: unknown } | null): boolean {
    if (event && typeof event === "object" && event.type === "done") {
      const wasLive = liveSessions.has(sessionId);
      liveSessions.delete(sessionId);
      return wasLive || storeSessionInFlight(sessionId);
    }
    if (liveSessions.has(sessionId)) return true;
    if (storeSessionInFlight(sessionId)) {
      liveSessions.add(sessionId);
      return true;
    }
    return false;
  }

  return {
    notifyProvidersChanged(options?: { exceptWebContentsId?: number }): void {
      notifyProvidersChanged(options);
    },
    async start() {
      if (!getSettings().enabled) {
        setStatus("disabled");
        return;
      }
      generation += 1;
      clearReconnect();
      await connect();
    },
    stop() {
      generation += 1;
      clearReconnect();
      stopHeartbeat();
      if (ws) {
        const socket = ws;
        ws = null;
        socket.close(1000, "client stopped");
      }
      setStatus("stopped");
    },
    async reconfigure() {
      generation += 1;
      clearReconnect();
      stopHeartbeat();
      if (ws) {
        const socket = ws;
        ws = null;
        socket.close(1000, "reconfigured");
      }
      backoff = RECONNECT_BASE_MS;
      await connect();
    },
    handleStreamEvent(payload: { sessionId: string; event: unknown }) {
      const settings = getSettings();
      if (!settings.enabled || settings.pushActivity === "off") return;
      if (!ws || ws.readyState !== ws.OPEN || !helloSent) return;
      const event = payload.event as { type?: unknown } | null;
      if (event && typeof event === "object" && (event.type === "status" || event.type === "done")) {
        pushRunningStatus();
      }
      if (viewerCount === 0) return;
      if (
        settings.pushActivity === "active" &&
        event?.type !== "session_deleted" &&
        !sessionInFlight(payload.sessionId, event)
      ) return;
      if (d2r) {
        sendRaw(ws, {
          type: "event",
          enc: d2r.seal({ sessionId: payload.sessionId, event: payload.event }),
        });
      } else {
        sendRaw(ws, {
          type: "event",
          sessionId: payload.sessionId,
          event: payload.event,
        });
      }
      events?.onActivity?.();
    },
    status() {
      return currentStatus;
    },
    pushMaintenanceState,
  };
}

function defaultWebSocketFactory(url: string, headers: Record<string, string>): WebSocketLike {
  return new WebSocket(url, { headers }) as unknown as WebSocketLike;
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function base64ByteLength(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

function sanitizeUploadName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith(".")) {
    return "upload.bin";
  }
  return cleaned.slice(0, 120);
}

function sanitizeRemoteAttachments(
  raw: unknown,
  uploadDir: string | undefined,
): AttachmentDraft[] {
  if (!Array.isArray(raw) || raw.length === 0 || !uploadDir) return [];
  const prefix = uploadDir.endsWith("/") ? uploadDir : `${uploadDir}/`;
  const out: AttachmentDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const candidate = item as Partial<AttachmentDraft> & { path?: unknown };
    if (
      typeof candidate.path !== "string" ||
      !candidate.path.startsWith(prefix) ||
      typeof candidate.name !== "string" ||
      !candidate.name.trim() ||
      typeof candidate.kind !== "string" ||
      !candidate.kind.trim() ||
      typeof candidate.mimeType !== "string" ||
      !candidate.mimeType.trim()
    ) {
      continue;
    }
    out.push({
      path: candidate.path,
      name: candidate.name.trim(),
      kind: candidate.kind as AttachmentDraft["kind"],
      mimeType: candidate.mimeType.trim(),
      ...(typeof candidate.sizeBytes === "number" && Number.isFinite(candidate.sizeBytes)
        ? { sizeBytes: Math.floor(candidate.sizeBytes) }
        : {}),
    });
  }
  return out;
}

export function ensureDeviceId(existing: string | undefined): string {
  if (existing && /^[a-zA-Z0-9-]{8,}$/.test(existing)) return existing;
  return randomUUID();
}
