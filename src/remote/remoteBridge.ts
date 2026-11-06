/**
 * Remote relay bridge — main-process device client.
 *
 * Outbound-only WSS connection to the relay server (remote.jellybot.cloud).
 * The web console issues sessionRuntime-shaped requests through the relay;
 * this bridge executes them against the local store and forwards live
 * `agent:stream` events back. Mirrors relay/src/protocol.ts (kept in sync
 * manually — cross-package imports would break the build boundary).
 */
import { randomUUID } from "node:crypto";
import { normalizeLlmProviderOptions } from "../llm/apiProtocol.js";
import { sessionForPresentation } from "../session/presentation.js";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
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
  /**
   * Fired after each payload that actually leaves for the relay (agent event
   * fanout, viewer-request responses). Drives the title-bar streaming
   * indicator. NOT fired for busy-count metadata pushes — those carry no
   * conversation content.
   */
  onActivity?: () => void;
  /**
   * Fired after a Token Hub upsert/remove actually changed this device's
   * LLM provider list. Desktop uses it to refresh the composer switcher.
   * options.exceptWebContentsId names the window that originated the
   * change (settings save echo suppression); broadcast skips it.
   */
  onProvidersChanged?: (options?: { exceptWebContentsId?: number }) => void;
}

/** Injectable WebSocket so tests never touch the network. */
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
  /** WS-level liveness probe — the `ws` client has it; exotic shims may not. */
  ping?(): void;
}

export const REMOTE_READ_ONLY_ERROR =
  "Device is in read-only mode — enable Full control in Settings → Remote";

// ── deviceExec guards (agentd ≥ 1.3.5) ────────────────────────
/** One-shot sandboxed shell for remote maintenance. Exported for tests. */
export const EXEC_DEFAULT_TIMEOUT_MS = 30_000;
export const EXEC_MAX_TIMEOUT_MS = 120_000;
/** Per-stream output cap; node kills the child when maxBuffer overflows. */
export const EXEC_OUTPUT_LIMIT_BYTES = 256 * 1024;
export const EXEC_COMMAND_LIMIT_CHARS = 8_192;

export interface DeviceExecResult {
  /** Numeric exit code, or null when the child died by signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

/** Single-flight across the process: one remote shell at a time. */
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
    // execFile validates args synchronously and THROWS (e.g. NUL bytes in
    // the command) instead of calling back — without this guard the throw
    // escapes the promise executor and the viewer waits out the relay
    // timeout with no response frame.
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
          // Node 22: maxBuffer overflow arrives as code
          // ERR_CHILD_PROCESS_STDIO_MAXBUFFER / message "stdout maxBuffer
          // length exceeded" with killed=undefined; timeouts arrive as
          // killed=true + SIGKILL. Check maxBuffer first so a chatty
          // command is never misreported as timed out.
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
/**
 * Application-level keepalive. A WAN-side address change (PPPoE redial)
 * kills the TCP flow without EITHER endpoint seeing an event: the hub's
 * terminate goes to the old address and never arrives, and an idle
 * ESTABLISHED socket on Linux never times out on its own. The bridge has to
 * probe for itself — ping on a fixed cadence and tear the socket down
 * locally when the pong misses, which runs the normal close→reconnect path.
 * (Pi zombie socket, 2026-10-14: five hours of "status=connected" over a
 * dead link, invisible to every event-driven fallback.)
 */
export const HEARTBEAT_PING_MS = 30_000;
export const HEARTBEAT_PONG_TIMEOUT_MS = 15_000;
/**
 * A connection must survive this long before the reconnect backoff resets.
 * Resetting on open turned "open → kicked within a second" cycles into a 1s
 * reconnect hammer (two installs sharing a deviceId fought forever).
 */
const RECONNECT_STABLE_MS = 10_000;
/**
 * Close codes the relay uses for deliberate kicks (relay/src/protocol.ts).
 * Any of them means an immediate retry with the same identity/key can only
 * reproduce the kick — surface the reason and stop instead.
 */
const KICK_CLOSE_CODES = new Set([4001, 4003, 4010, 4409]);
/** Decoded byte cap for a single remote composer upload. */
const REMOTE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;
/** Actions that can move a session in/out of "running" — busy-count recheck. */
const TURN_MUTATING_ACTIONS = new Set([
  "startTurn",
  "cancelTurn",
  "pauseTurn",
  "resumeTurn",
  // promote on an idle session starts a turn right away.
  "promoteQueuedPrompt",
  // CoCo chat sends spawn engine jobs that run inside coco_chat sessions —
  // the busy count moves like any other turn.
  "cocoCommand",
]);

/** LLM + composer-default snapshot served to the web console (read-only). */
export interface RemoteComposerSnapshot {
  providers: Array<{ id: string; name: string; modelId: string }>;
  activeProviderId: string;
  composerInfinite: boolean;
  reasoningEffort: ReasoningEffort;
  /** Context window limit (tokens) — web console context gauge denominator. */
  contextLimitTokens?: number;
}

/** Per-path working-tree diff stat row (git:pathsDiffStats shape). */
export interface RemotePathDiffStats {
  path: string;
  isRepo: boolean;
  insertions: number;
  deletions: number;
  hasDiff: boolean;
}

/**
 * Mirror of relay protocol DeviceMaintenanceState (relay/src/protocol.ts) —
 * keep in sync manually (cross-package imports would break the build
 * boundary, same as the rest of the protocol mirror above).
 */
export interface RemoteMaintenanceState {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  id?: string;
  source?: string;
  version?: string;
  error?: string;
  logTail?: string;
  /**
   * Machine-readable pipeline step of a running update (mirror of the
   * relay protocol's step field — keep in sync with relay/src/protocol.ts).
   */
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  /** Byte-level download progress while step === "download". */
  progress?: {
    receivedBytes: number;
    totalBytes?: number;
    bytesPerSec?: number;
    pct?: number;
  };
  ts: number;
}

/**
 * Device maintenance surface (agentd ≥ 1.3.1 headless nodes). Injected by
 * src/agentd/runMain.ts; desktop builds leave it unset and the console gets
 * a clear "not available" error instead of a mystery failure.
 */
export interface RemoteDeviceMaintenance {
  /** Snapshot for the read-only deviceStatus action. */
  status(): unknown | Promise<unknown>;
  /** Live state for reconnect catch-up pushes (null = nothing to report). */
  currentState(): RemoteMaintenanceState | null;
  /** Schedule a graceful restart; throws when unsupported (no supervisor). */
  restart(): { restarting: boolean; supervisor: string } | Promise<{ restarting: boolean; supervisor: string }>;
  /** Reboot the host via the root reboot queue; throws when that unit is down. */
  reboot(): { rebooting: boolean } | Promise<{ rebooting: boolean }>;
  /** Queue an update/reinstall; throws with guidance when no channel exists. */
  update(input: {
    source: string;
    sha256?: string;
    force?: boolean;
    /** Target release version, when the console knows it (checkUpdate). */
    version?: string;
  }): Promise<{ queued: boolean; id: string; mode: "updater" | "in-process" }>;
  /** Fetch the downloads manifest for the agentd entry (device → origin;
   *  the relay stays signaling-only by design). */
  checkUpdate(manifestUrl: string): Promise<{ version: string; url: string; sha256?: string } | null>;
  /**
   * Opt-in for the `deviceExec` action. Deliberately NOT implied by the
   * presence of this interface: an unsandboxed user shell on a desktop is a
   * different threat class than agentd's NoNewPrivileges/ProtectSystem
   * sandbox, so only agentd sets it. Desktop maintenance implementations
   * leave it unset and `deviceExec` keeps refusing.
   */
  execSupported?: boolean;
}

/**
 * CoCo engine surface for the relay web console (desktop only — agentd has
 * no CoCo runtime). Late-bound via a getter because src/main/index.ts builds
 * the service after this bridge; a missing/null return yields the standard
 * "unknown action" error so the console hides the CoCo entry.
 */
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
  /** Tools whose cards the desktop Tools screen hides (tools.json overrides). */
  listHiddenToolCards?: () => string[];
  /** LLM providers + composer defaults for the web composer (listComposerOptions). */
  getComposerSnapshot?: () => Promise<RemoteComposerSnapshot>;
  /** Persist a base64 browser upload and return its device-side draft. */
  saveRemoteUpload?: (upload: {
    name: string;
    mimeType: string;
    contentBase64: string;
  }) => Promise<AttachmentDraft | null>;
  /** Directory saveRemoteUpload writes into — remote attachments must live inside. */
  remoteUploadDir?: () => string;
  /** Files-pane text preview (fs:readTextFile semantics — 1 MB cap, binary reject). */
  readTextFilePreview?: (path: string) => Promise<TextFilePreviewResult>;
  /** Existence filter for mentioned paths (fs:filterExistingFiles semantics). */
  filterExistingFiles?: (paths: string[]) => Promise<string[]>;
  /** Per-path working-tree diff stats for Files-pane badges (git:pathsDiffStats). */
  getPathsDiffStats?: (paths: string[]) => Promise<RemotePathDiffStats[]>;
  /** Home directory for browseDir scoping (tests inject a temp dir). */
  homeDir?: () => string;
  /** Device maintenance surface (agentd headless nodes; optional). */
  deviceMaintenance?: RemoteDeviceMaintenance;
  /**
   * Extra capabilities advertised in `hello.caps` besides the stream cipher
   * cap — e.g. `["maintenance"]` on desktop clients, `["maintenance",
   * "reboot", "exec"]` on agentd. Persisted by relay ≥ 1.5.x and used by the
   * web console to decide which panels a device gets.
   */
  deviceCaps?: string[];
  /**
   * Token Provider Hub sync — desktop and agentd inject the same
   * providerSync helpers bound to their settings/credential roots.
   */
  providerSync?: {
    list: () => Promise<SyncProviderPublic[]>;
    exportOne: (providerId: string) => Promise<SyncProviderTransfer & { id: string }>;
    upsert: (transfer: SyncProviderTransfer) => Promise<{ id: string; action: "added" | "overwritten" }>;
    remove: (baseUrl: string, modelId: string) => Promise<{ removed: boolean; id?: string }>;
    removeById?: (providerId: string) => Promise<{ removed: boolean; id?: string }>;
  };
  /**
   * MCP Hub sync — desktop and agentd inject the same mcpSync helpers
   * (configs + runtime live in the mcpManager singleton; roots are wired
   * via configureToolsConfigRoot / configureMcpPersistence at startup).
   */
  mcpSync?: {
    list: () => SyncMcpServerPublic[];
    exportOne: (serverId: string) => SyncMcpServerTransfer & { id: string };
    upsert: (transfer: SyncMcpServerTransfer) => Promise<{ id: string; action: "added" | "overwritten" }>;
    remove: (serverId: string) => Promise<{ removed: boolean; id?: string }>;
  };
  /**
   * Skill Hub sync — desktop and agentd inject the same skillSync helpers
   * (packages live under `{dataDir}/skills`; each transfer is a base64 zip of
   * the whole skill directory).
   */
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
  /** CoCo engine (cocoSnapshot / cocoCommand). Desktop only. */
  getCoco?: () => RemoteCocoEngine | null;
  events?: RemoteBridgeEvents;
  webSocketFactory?: WebSocketFactory;
  setTimeoutFn?: (fn: () => void, ms: number) => unknown;
  clearTimeoutFn?: (t: unknown) => void;
}

/** Defensive shape adapter — store sessions may come from older builds. */
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

/**
 * Session-scoped path guard for the Files-pane read-only actions: only paths
 * the conversation itself lists (tool-modified ∪ mentioned-in-reply) may be
 * previewed / filtered / stat'd — the same set the Mac Files pane shows. Keeps
 * read-only viewers from turning the preview pipeline into an
 * arbitrary-file-read channel.
 */
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
  // The session's own plan document rides the Approve | Discard bar — the
  // plan writer stages it outside tool calls, so it never lands in the
  // modified/mentioned lists (and planDoc.path is absolute while those are
  // workspace-relative — pathKey keeps the two in different keys). Desktop
  // reads it unscoped via fs:readTextFile; admit exactly this one path so
  // remote reviewers can open the doc they are approving.
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
  /** Settings changed — reconnect if needed. */
  reconfigure(): Promise<void>;
  /** Stream sink registered by the app shell. */
  handleStreamEvent(payload: { sessionId: string; event: unknown }): void;
  status(): RemoteBridgeStatus;
  /** Push live device-maintenance state (agentd update/restart progress). */
  pushMaintenanceState(state: RemoteMaintenanceState): void;
  /**
   * The device's LLM provider list changed outside the Token Hub RPC path
   * (local settings save, backup import). Fans out to the local renderer
   * (onProvidersChanged) and pushes providers_changed to web consoles.
   * exceptWebContentsId skips the originating window (its own save echo).
   */
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
  let generation = 0; // invalidates stale async closures after stop/reconfigure
  let helloSent = false;
  /** Last busy count pushed (−1 forces one push per fresh connection). */
  let lastRunningCount = -1;
  /**
   * Console viewers subscribed to this device, per the relay's presence
   * signal (relays ≥ 1.3). null until the relay reports presence — older
   * relays never do, and unknown keeps the legacy always-stream behavior.
   */
  let viewerCount: number | null = null;
  /**
   * E2EE v1 (relays ≥ 1.5): stream key derived from the API key + the two
   * per-direction ciphers. Built only after `welcome.caps` advertised
   * "e2ee-v1" — older relays never see sealed frames. Rebuilt per
   * connection (seq resets on both ends with the fresh handshake).
   */
  let streamKey: Buffer | null = null;
  let d2r: FrameCipher | null = null; // seals device→relay (events, responses)
  let r2d: FrameCipher | null = null; // opens relay→device (request payloads)
  /** pushActivity=active: sessions with an open turn seen on the wire. */
  const liveSessions = new Set<string>();

  const setStatus = (s: RemoteBridgeStatus, detail?: string) => {
    currentStatus = s;
    try {
      events?.onStatusChange?.(s, detail);
    } catch {
      /* listener errors are not ours */
    }
  };

  const notifyProvidersChanged = (options?: { exceptWebContentsId?: number }): void => {
    try {
      events?.onProvidersChanged?.(options);
    } catch {
      /* listener errors are not ours */
    }
    pushProvidersChanged();
  };

  /**
   * providers_changed push: tells subscribed web consoles the device's LLM
   * provider list moved (local settings edit, backup import, or Token Hub
   * sync) so their cached listComposerOptions probe re-runs. Same tier as
   * the busy count — a contentless flag frame, sealed under E2EE v1 when
   * active, gated only by the pushActivity=off kill switch (no conversation
   * content, so the presence gate would only lose updates).
   */
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
    // House rule: every frame that leaves this machine for the relay must
    // pulse the Relay button — this push is no exception.
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

  /**
   * Ping/pong liveness for one socket: every HEARTBEAT_PING_MS send a WS
   * ping and arm a pong deadline. A missed pong means the peer or the path
   * is gone — terminate locally so the close handler runs the reconnect.
   * No-ops when the socket implementation has no ping (nothing to probe
   * with; behavior falls back to event-driven reconnects only).
   */
  const startHeartbeat = (socket: WebSocketLike, myGeneration: number) => {
    stopHeartbeat();
    // Capture once: the typeof guard does not narrow inside the closure.
    const pingFn = socket.ping;
    if (typeof pingFn !== "function") return;
    const beat = () => {
      heartbeatTimer = null;
      if (generation !== myGeneration || ws !== socket) return;
      if (socket.readyState !== socket.OPEN) return;
      try {
        pingFn.call(socket);
      } catch {
        /* probe failed — the pong deadline below tears the socket down */
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
            /* already dead — the close handler takes it from here */
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
    // Accept friendly http(s) URLs and normalize to ws scheme.
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
      // E2EE v1: derive once per connection; ciphers activate on welcome.caps.
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
      // Fresh socket: force the busy count through so viewers can sync the
      // device status light immediately (covers reconnects mid-turn).
      lastRunningCount = -1;
      pushRunningStatus();
      // Liveness probe: a dead path produces no socket events at all —
      // ping/pong is the only way this side ever finds out.
      startHeartbeat(socket, myGeneration);
      // Backoff resets only once this connection proves stable. An instant
      // death (kick, proxy hiccup) keeps growing the delay instead of a 1s
      // loop; the guard also ignores stale timers from previous sockets.
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
        /* handler errors already reported per-request */
      });
    });

    socket.on("close", (code, reason) => {
      if (generation !== myGeneration) return;
      stopHeartbeat();
      ws = null;
      d2r = null;
      r2d = null;
      const why = reason?.toString() ?? "";
      // Kicks are deliberate server decisions: auth, blocked, key revoked,
      // replaced, removed. The relay mirrors the reason into the close
      // frame; older servers closed bare — match codes AND reason words.
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
      /* close event follows; nothing to do here */
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
      // Relays ≥ 1.3 report how many viewers hold this device open; the
      // count gates live streaming (absent on old relays → stay unknown).
      const raw = (msg as { viewers?: unknown }).viewers;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        viewerCount = Math.max(0, Math.floor(raw));
      }
      // E2EE v1: relays ≥ 1.5 advertise "e2ee-v1" — activate the frame
      // ciphers so everything leaving this socket is sealed.
      const rawCaps = (msg as { caps?: unknown }).caps;
      const caps = Array.isArray(rawCaps) ? rawCaps.filter((c): c is string => typeof c === "string") : [];
      if (caps.includes(STREAM_CAP) && streamKey) {
        d2r = new FrameCipher(streamKey, "d2r");
        r2d = new FrameCipher(streamKey, "r2d");
      }
      // Reconnect catch-up: the console's devices list lost this device's
      // maintenance state while it was offline — re-push the current one so
      // an in-flight remote update keeps its live progress after a restart.
      const maintenance = deps.deviceMaintenance?.currentState();
      if (maintenance) pushMaintenanceState(maintenance);
      return; // hello already sent on open
    }
    if (type === "presence") {
      const raw = (msg as { viewers?: unknown }).viewers;
      if (typeof raw === "number" && Number.isFinite(raw)) {
        const n = Math.max(0, Math.floor(raw));
        // Fresh watch window → drop latched in-flight sessions and resync
        // from the store on the next event instead of trusting stale state.
        if (n !== viewerCount) liveSessions.clear();
        viewerCount = n;
      }
      return;
    }
    if (type === "kick") {
      const raw = (msg as { reason?: unknown }).reason;
      const reason = typeof raw === "string" && raw.trim() ? raw.trim() : "kicked";
      // The relay closes this socket right after the kick message. Retrying
      // with the same identity would just re-trigger it (two installs
      // sharing one deviceId from a settings backup fight forever) — stop
      // and surface why instead of auto-reconnecting.
      generation += 1;
      clearReconnect();
      stopHeartbeat();
      if (ws) {
        const socket = ws;
        ws = null;
        try {
          socket.close(1000, "kicked");
        } catch {
          /* already closing */
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
    // E2EE v1: sealed request — the payload rides inside `enc` (the relay
    // sealed it with our stream key). A failed unseal answers with an error
    // instead of dispatching garbage; plaintext requests (older relays)
    // pass through as before.
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
    // A viewer-facing response just traveled up the wire.
    events?.onActivity?.();
    // Remote-initiated turn mutations can move the busy count even when
    // stream events are not flowing (pushActivity=off) — re-push once the
    // store settles.
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

    // Read-only surface — always allowed.
    switch (action) {
      case "listSessions":
        return { ok: true, result: store.listSessions(payload.includeCoco === true) };
      case "listWorkspaces":
        // Minimal shape for the remote console's project sidebar.
        return {
          ok: true,
          result: store.listWorkspaces().map((w) => ({ id: w.id, name: w.name, path: w.path })),
        };
      case "browseDir": {
        // New Task "browse folders" picker: list subfolders of a device
        // directory. Scoped to the home subtree — the picker never needs
        // system paths, and the cap keeps read-only viewers from probing
        // the whole filesystem. Dotfiles are hidden, files are omitted.
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
        // Mirror of the desktop toolCardVisibility set so the console can
        // skip the same cards the Mac conversation view skips.
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
        // Read-only local snapshot (version, install layout, maintenance
        // state) — no filesystem writes, no egress; safe for read-only
        // viewers like the other cases in this switch.
        const maintenance = deps.deviceMaintenance;
        if (!maintenance) {
          return { ok: false, error: "remote maintenance is not available on this device" };
        }
        return { ok: true, result: await maintenance.status() };
      }
      case "readTextFile":
      case "filterExistingFiles":
      case "getPathsDiffStats": {
        // Files-pane preview pipeline (web console Files tab). Read-only like
        // the cases above, but paths are additionally scoped to the session's
        // own file list — see sessionScopedPaths.
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
        // Shape gate only — the engine owns command validation. The relay's
        // audit log records just command.type (see AUDITED_ACTIONS notes).
        const command = payload.command as { type?: unknown } | undefined;
        if (!command || typeof command !== "object" || typeof command.type !== "string" || !command.type) {
          return { ok: false, error: "command required" };
        }
        coco.command(command as CocoCommand);
        return { ok: true, result: { accepted: true } };
      }
      case "createWorkspace": {
        // New Task "New Project…" flow. mkdir -p semantics confirmed with
        // the owner: a missing folder is created, an existing folder is
        // registered as-is; a non-folder path is refused. Idempotent —
        // re-registering a known path returns the existing workspace with
        // `existing: true` instead of a duplicate row.
        const name = typeof payload.name === "string" ? payload.name.trim() : "";
        const path = typeof payload.path === "string" ? payload.path.trim() : "";
        if (!name) return { ok: false, error: "name required" };
        if (!path) return { ok: false, error: "path required" };
        if (!path.startsWith("/")) {
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
        // store.createWorkspace also sets the new workspace active and
        // broadcasts workspace:changed — same as creating it on the Mac.
        const ws = await store.createWorkspace({ name, path: normalized });
        return { ok: true, result: { id: ws.id, name: ws.name, path: ws.path, existing: false } };
      }
      case "startTurn": {
        const userText = typeof payload.userText === "string" ? payload.userText : "";
        if (!userText.trim()) return { ok: false, error: "userText required" };
        const req: StartTurnRequest = {
          userText,
          // Bypass is opt-in per turn from the web composer; only reachable
          // here because startTurn itself sits behind the fullControl gate.
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
          // Attachments were offered but none survived validation — refuse
          // the turn instead of silently dropping files the user picked.
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
        // Mid-turn insertion is always opt-in; the store itself demotes
        // `interrupt` to `deferred` when no turn is running. Legacy `steer`
        // values from older remotes map to `interrupt`.
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
        // STOP-before-content rollback: web consumes the same take-once
        // latch the Mac renderer reads on remount.
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
        // New wire: dial level string. Legacy console builds still send the
        // Max boolean — map true/false to max/low (null un-pins).
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
        // The implementation acks first and schedules the exit afterwards —
        // this response must be on the wire before the process goes down.
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
        // Same refusal as the agentd CLI: a remote URL without a sha256 is
        // an unauthenticated download executing as root — never allowed.
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
        // Sandboxed one-shot shell for agentd maintenance (DB doctor, disk
        // health, log tails). Runs as the service user inside its systemd
        // sandbox — NoNewPrivileges + ProtectSystem=strict: no sudo, system
        // paths read-only; dataDir/workspace/tmp writable. Desktop devices
        // refuse: an unsandboxed user shell is a different threat class, so
        // having a maintenance surface is not enough — agentd sets
        // `execSupported` explicitly.
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
        // Prefer the service home; fall back to /tmp when it does not exist
        // (system users created with useradd -r may have no home dir) — a
        // missing cwd would fail EVERY command with ENOENT.
        const preferredCwd = deps.homeDir?.() ?? os.homedir();
        const cwd = existsSync(preferredCwd) ? preferredCwd : os.tmpdir();
        execInFlight = true;
        // Device-side audit: under E2EE the relay journals only the action
        // name, so the full command lands here (journald for agentd).
        // Output is never logged — it may carry secrets.
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
        // Same entry point as the desktop's agent:deleteSession IPC — its
        // guards apply: a session with a turn in flight or mid-compaction
        // refuses (deleting would drop in-flight tool work / resurrect the
        // row). Success archives the transcript into session_history and
        // broadcasts agent:sessionDeleted, which this bridge already
        // forwards as session_deleted to every viewer — lists drop the row
        // without any extra event plumbing here.
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

  /**
   * Push the device busy count (sessions with a turn in flight) whenever it
   * changes — the web console blinks the device status light off it. Like any
   * live push it respects the pushActivity gate. Deliberately NOT gated on
   * viewer presence: it is a single number, carries no conversation content,
   * and keeps the console device lights alive while nobody is watching.
   */
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
    // House rule: every frame sent to the relay pulses the Relay button.
    events?.onActivity?.();
  }

  /**
   * Push device-maintenance metadata (remote update/restart progress).
   * Same tier as the busy count: a single small frame, never conversation
   * content — but it still respects the pushActivity=off kill switch for
   * symmetry with pushRunningStatus.
   */
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

  /** Session statuses that mean a turn is open on the wire (paused resumes). */
  const IN_FLIGHT_STATUSES = new Set(["running", "paused"]);

  function storeSessionInFlight(sessionId: string): boolean {
    try {
      return store.listSessions().some((s) => s.id === sessionId && IN_FLIGHT_STATUSES.has(s.status));
    } catch {
      return false;
    }
  }

  /**
   * pushActivity=active gate: forward only events of sessions with an open
   * turn. Membership latches on the session's first streamed event — the
   * store flips status (idle/error) *before* the closing done/error events
   * are broadcast, so a pure status check would swallow every turn tail —
   * and unlatches on `done`.
   */
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
    /**
     * Provider list changed on this device (settings save, backup import,
     * caller-side edit). Fans out to the local renderer (onProvidersChanged)
     * and pushes providers_changed to subscribed web consoles.
     */
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
      // Turn lifecycle transitions move the busy count — push the fresh
      // number so viewer device lights blink on/off in real time. Runs
      // before the presence gate on purpose (see pushRunningStatus).
      if (event && typeof event === "object" && (event.type === "status" || event.type === "done")) {
        pushRunningStatus();
      }
      // Presence gate: with zero subscribed viewers the relay would fan the
      // event out to nobody — hold it instead of shipping conversation
      // content through the cloud. null = old relay never reported
      // presence; keep the legacy always-stream behavior for those.
      if (viewerCount === 0) return;
      // "active" narrows the stream to sessions with a turn in flight;
      // idle sessions stay local until their next turn starts.
      // session_deleted is exempt: deleted sessions are never in flight
      // (deleteSession refuses mid-turn), so the gate would swallow every
      // deletion notice — the console would never learn the session is gone.
      if (
        settings.pushActivity === "active" &&
        event?.type !== "session_deleted" &&
        !sessionInFlight(payload.sessionId, event)
      ) return;
      // E2EE v1: relays ≥ 1.5 get everything sealed ({sessionId, event}
      // inside the envelope); older relays keep the legacy plaintext frame.
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
      // Only fires when the event really left the machine (presence gate
      // and pushActivity off both return before this point).
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

/** Decoded byte size of a base64 string (padding-tolerant, no allocation). */
function base64ByteLength(base64: string): number {
  const clean = base64.replace(/[^A-Za-z0-9+/=]/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * Browser uploads carry no device paths — keep only the basename and refuse
 * hidden/dot files so a crafted name can never escape the upload directory.
 */
function sanitizeUploadName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f]/g, "").trim();
  if (!cleaned || cleaned === "." || cleaned === ".." || cleaned.startsWith(".")) {
    return "upload.bin";
  }
  return cleaned.slice(0, 120);
}

/**
 * Remote startTurn attachments must be files this bridge stored itself (see
 * uploadAttachment). Anything outside the remote upload dir — i.e. an
 * attempt to attach arbitrary device files by path — is rejected.
 */
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

/** Persist a stable deviceId for this install (randomUUID when absent). */
export function ensureDeviceId(existing: string | undefined): string {
  if (existing && /^[a-zA-Z0-9-]{8,}$/.test(existing)) return existing;
  return randomUUID();
}
