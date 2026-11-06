/**
 * Wire protocol shared by relay server, JellyBot device client, and web console.
 * Agent stream events are opaque payloads relayed untouched.
 */

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  version: string;
}

/** One API key entry. Plaintext keys never appear in summaries. */
export interface KeySummary {
  id: string;
  name: string;
  keyTail: string;
  createdAt: number;
  deviceCount: number;
}

export interface DeviceSummary extends DeviceInfo {
  online: boolean;
  firstSeen: number;
  lastSeen: number;
  blocked: boolean;
  /** Key the device registered with (devices registered before multi-key lack it). */
  keyId?: string;
  keyName?: string;
  /** Live count of sessions with a turn in flight (absent/stale on old device builds). */
  runningSessions?: number;
  /** Client IP of the most recent connection (server-side, XFF last hop / socket). */
  ip?: string;
  /** User-Agent of the most recent connection (absent for Node `ws` device clients). */
  ua?: string;
  /** Connection IP history, newest first; consecutive same-IP connections merge (ts refreshed). */
  ipHistory?: { ip: string; ts: number }[];
  /**
   * Capabilities the device advertised in `hello.caps` (relay ≥ 1.5.x
   * persists them; absent on devices/relays that predate the field).
   *
   * `"maintenance"` — remote update + restart of the *process* is available
   * (agentd and desktop clients ≥ 1.5.2). `"reboot"` — the *host* may be
   * rebooted remotely (agentd only; desktop never advertises it).
   * `"exec"` — sandboxed one-shot remote shell (agentd only).
   *
   * The web console gates the Maintenance card on these instead of sniffing
   * `platform`, which could never distinguish a headless node from a desktop
   * client on the same OS family.
   */
  caps?: string[];
  /**
   * Live device-maintenance state (agentd remote update/restart reporting;
   * agentd ≥ 1.3.1 only — absent otherwise). Rides the devices broadcast.
   */
  maintenance?: DeviceMaintenanceState;
}

/**
 * Remote-maintenance progress for an agentd device, reported via the
 * `status` frame (metadata like runningSessions — never conversation
 * content) and fanned out through DeviceSummary.
 */
export interface DeviceMaintenanceState {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  /** Update request id (present once one has been queued). */
  id?: string;
  /** Update source (URL or device-local path) of the in-flight/last request. */
  source?: string;
  /** Release version of the in-flight/last update, when known. */
  version?: string;
  error?: string;
  /** Tail of the updater log (capped by the device). */
  logTail?: string;
  /**
   * Machine-readable pipeline step of a running update (agentd ≥ 1.4;
   * absent on older devices, which only report phase + logTail). The
   * console buckets the granular ids into its five UI steps.
   */
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  /**
   * Byte-level download progress while step === "download". pct is absent
   * when the server sends no usable Content-Length (indeterminate bar).
   */
  progress?: {
    receivedBytes: number;
    totalBytes?: number;
    bytesPerSec?: number;
    pct?: number;
  };
  ts: number;
}

export interface AuditEntry {
  ts: number;
  actor: string;
  action: string;
  detail?: string;
}

/** A prompt (or user answer) sent from a remote console to a device. */
export interface PromptLogEntry {
  ts: number;
  deviceId: string;
  deviceName: string;
  /** Key the device is registered with. */
  keyId: string;
  keyName: string;
  /** Viewer identity: console username or API key name. */
  actor: string;
  /** The underlying device action (startTurn, enqueuePrompt, respondUserAsk, …). */
  action: string;
  sessionId?: string;
  /** Full prompt text / answer, untruncated. */
  text: string;
}

/** Actions a viewer may invoke on a device (mirrors main-process sessionRuntime API). */
export type DeviceAction =
  /** Session list { includeCoco?: boolean } — true also returns CoCo-owned
   *  sessions (sources `coco_chat` chat + `coco` autonomous runs); the
   *  `coco_internal` background sessions stay hidden either way. Default
   *  false keeps the desktop renderer's list unchanged. */
  | "listSessions"
  | "listWorkspaces"
  /** Read-only directory listing for the New Task project picker's
   *  "browse folders" flow. Home-subtree scoped on the device; returns
   *  subfolder names only (dotfiles excluded). Like listWorkspaces it is
   *  never audited and allowed in read-only mode. */
  | "browseDir"
  /** Create a workspace on the device {name, path}. Full-control only,
   *  audited. mkdir -p semantics: a missing folder is created; an existing
   *  folder is registered as-is (idempotent — same path returns the
   *  existing workspace with `existing: true`). */
  | "createWorkspace"
  | "getSession"
  /** Delete a session on the device {sessionId}. Full-control only,
   *  audited. Mirrors the desktop `agent:deleteSession` IPC: refuses while
   *  a turn is in flight or the session is compacting; success runs the
   *  archive funnel (session_history) and the device broadcasts
   *  session_deleted so every viewer's list drops the row. */
  | "deleteSession"
  | "getHiddenToolCards"
  | "listComposerOptions"
  | "listPromptQueue"
  | "startTurn"
  | "cancelTurn"
  | "takePromptRestore"
  | "pauseTurn"
  | "resumeTurn"
  | "enqueuePrompt"
  | "promoteQueuedPrompt"
  | "deferQueuedPrompt"
  | "removeQueuedPrompt"
  | "updateQueuedPromptText"
  | "moveQueuedPromptToFront"
  | "uploadAttachment"
  | "setSessionProvider"
  | "setComposerPrefs"
  | "respondUserAsk"
  | "respondToolApproval"
  | "approvePlan"
  | "discardPlan"
  /** Read-only file inspection for the Files pane (post-turn file list +
   *  remote text preview). Never audited, always allowed — same semantics as
   *  the desktop `fs:readTextFile` / `fs:filterExistingFiles` /
   *  `fs:getPathsDiffStats` IPC handlers. */
  | "readTextFile"
  | "filterExistingFiles"
  | "getPathsDiffStats"
  /** Device maintenance (agentd ≥ 1.3.1; headless nodes only). deviceStatus
   *  is read-only local info (version, install layout, maintenance state);
   *  the rest mutate the device and sit behind its full-control gate. */
  | "deviceStatus"
  | "restartDevice"
  | "updateDevice"
  | "rebootDevice"
  | "checkUpdate"
  /** Run one shell command on the device {command, timeoutMs?} (agentd ≥
   *  1.3.5; headless nodes only). Full-control only, audited. Executes as
   *  the service user inside its systemd sandbox (no sudo, system paths
   *  read-only); single-flight, hard timeout (≤ 120s), output truncated.
   *  Under E2EE the relay sees only the action name — command and output
   *  stay sealed viewer↔device; the device journals the full command. */
  | "deviceExec"
  /** Token Provider Hub sync — list device LLM providers (no API keys).
   *  Read-only; older devices return unknown action. */
  | "listSyncProviders"
  /** Export one device LLM provider including API key. Full-control, audited.
   *  Payload { providerId }. Result never returned to the browser — relay
   *  console endpoints consume it server-side only. */
  | "exportSyncProvider"
  /** Upsert one LLM provider by Base URL + Model ID. Full-control, audited.
   *  Matching entries keep the destination provider id; unrelated providers
   *  are never deleted. Payload is the transfer shape (may include apiKey). */
  | "upsertSyncProvider"
  /** Remove one LLM provider by its device id. Full-control, audited.
   *  Payload { providerId }; legacy { baseUrl, modelId } remains supported. */
  | "removeSyncProvider"
  /** MCP Hub sync — list device MCP servers (configs + runtime status, no
   *  env/header values). Read-only; older devices return unknown action. */
  | "listSyncMcpServers"
  /** Export one device MCP server including env/header values. Full-control,
   *  audited. Payload { serverId }. Result never returned to the browser —
   *  relay console endpoints consume it server-side only. */
  | "exportSyncMcpServer"
  /** Upsert one MCP server by name. Full-control, audited. Matching device
   *  entries keep their device id; payload is the transfer shape
   *  { name, enabled, transport } (transport may carry env/headers). */
  | "upsertSyncMcpServer"
  /** Remove one MCP server by its device id. Full-control, audited.
   *  Payload { serverId }. Also clears the server's mcp__ tool overrides. */
  | "removeSyncMcpServer"
  /** Skill Hub sync — list device skills (name/enabled/description/file
   *  count, never the SKILL.md body). Read-only; older devices return
   *  unknown action. */
  | "listSyncSkills"
  /** Export one device skill as a base64 zip of its whole directory.
   *  Full-control, audited. Payload { skillId }. Result never returned to the
   *  browser — relay console endpoints consume it server-side only. */
  | "exportSyncSkill"
  /** Upsert one skill package from a base64 zip by name. Full-control,
   *  audited. Matching device entries keep their device id; the directory is
   *  replaced wholesale, so files absent from the zip are removed. */
  | "upsertSyncSkill"
  /** Remove one skill by its device id. Full-control, audited.
   *  Payload { skillId }. */
  | "removeSyncSkill"
  /** CoCo — read-only snapshot of the on-device CoCo engine (state, budget,
   *  work, rules, messages, chat question/approval, background tasks).
   *  Desktop only (advertises the "coco" cap); agentd and older devices
   *  return unknown action, which the console treats as "no CoCo entry". */
  | "cocoSnapshot"
  /** CoCo — forward one CocoCommand to the engine: chat send, chatControl
   *  (stop / answer / approval), goal, work (start/pause/resume/cancel/
   *  priority/answer), rule (confirm/toggle/delete/run), budget reset,
   *  activation. Full-control only, audited (detail records command.type
   *  only — never command payloads). Desktop only. */
  | "cocoCommand";

/** Mutating actions that must land in the audit log. */
export const AUDITED_ACTIONS = new Set<string>([
  "startTurn",
  "createWorkspace",
  "deleteSession",
  "cancelTurn",
  "pauseTurn",
  "resumeTurn",
  "enqueuePrompt",
  "promoteQueuedPrompt",
  "deferQueuedPrompt",
  "removeQueuedPrompt",
  "updateQueuedPromptText",
  "moveQueuedPromptToFront",
  "uploadAttachment",
  "setSessionProvider",
  "setComposerPrefs",
  "respondUserAsk",
  "respondToolApproval",
  "approvePlan",
  "discardPlan",
  "restartDevice",
  "updateDevice",
  "rebootDevice",
  "deviceExec",
  "exportSyncProvider",
  "upsertSyncProvider",
  "removeSyncProvider",
  "exportSyncMcpServer",
  "upsertSyncMcpServer",
  "removeSyncMcpServer",
  "exportSyncSkill",
  "upsertSyncSkill",
  "removeSyncSkill",
  "cocoCommand",
]);

/**
 * Base64 attachment uploads can dwarf the default device-request budget on
 * slow links — give them a longer relay-side window.
 */
export function requestTimeoutMsFor(action: string): number {
  if (action === "uploadAttachment") return 120_000;
  // deviceExec: commands may run up to the 120s device-side cap — the relay
  // window must outlast that plus sealing/routing slack, or the viewer gets
  // a false "device timeout" while the device is still working.
  if (action === "deviceExec") return 150_000;
  // MCP upsert connects the server on the device before answering (stdio
  // spawn or HTTP handshake) — slow servers would falsely time out at 20s.
  if (action === "upsertSyncMcpServer") return 30_000;
  // Skill transfers move a whole package (zip of SKILL.md + supporting
  // files); agentd writes it file by file, so give the same 30s window.
  if (action === "upsertSyncSkill" || action === "exportSyncSkill") return 30_000;
  return 20_000;
}

/**
 * WebSocket frame cap for the relay server. Must comfortably exceed the
 * largest client→device payload: an 8 MB attachment is ~10.7 MB after base64
 * (plus JSON envelope), and large session snapshots ride the same socket.
 * 4 MB used to crash the hub with an unhandled
 * WS_ERR_UNSUPPORTED_MESSAGE_LENGTH — taking every connection down with it.
 */
export const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;

import type { StreamEnvelope } from "./streamCipher.js";

// ── device → server ──────────────────────────────────────────
export type DeviceToServerMsg =
  | { type: "hello"; device: DeviceInfo; caps?: string[] }
  /**
   * E2EE v1: when `enc` is present the plaintext `sessionId`/`event` fields
   * are absent — both live inside the envelope ({sessionId, event} JSON).
   * Relays < 1.5.0 ignore `enc` and would relay undefined fields, so devices
   * only send encrypted frames after `welcome.caps` advertised "e2ee-v1".
   */
  | { type: "event"; sessionId?: string; event?: unknown; enc?: StreamEnvelope }
  /** Live busy count — devices push it when a turn starts/ends so viewers
   *  can blink the device status light without subscribing to its events.
   *  `maintenance` (agentd ≥ 1.3.1) carries the remote update/restart
   *  progress; like the busy count it is device metadata, not content. */
  | { type: "status"; runningSessions?: number; maintenance?: DeviceMaintenanceState }
  | { type: "res"; requestId: string; ok: true; result?: unknown; enc?: StreamEnvelope }
  | { type: "res"; requestId: string; ok: false; error?: string; enc?: StreamEnvelope }
  | { type: "auth"; apiKey: string };

// ── server → device ──────────────────────────────────────────
export type ServerToDeviceMsg =
  /**
   * Sent right after the device hello. `viewers` is the number of console
   * viewers currently subscribed to this device; devices gate live event
   * streaming on it (0 = nobody watching → hold events). Absent on relays
   * older than 1.3.0 — devices treat absence as "unknown" and keep the
   * legacy always-stream behavior. `caps` (relays ≥ 1.5.0) advertises
   * "e2ee-v1": the relay accepts/re-emits encrypted frames, so the device
   * starts sealing everything it sends.
   */
  | { type: "welcome"; viewers?: number; caps?: string[] }
  /**
   * Live subscriber count for this device, pushed whenever a viewer
   * subscribes, switches away, or disconnects. Devices stop streaming
   * agent events at 0 and resume at ≥1 (busy-count pushes are exempt).
   */
  | { type: "presence"; viewers: number }
  /**
   * E2EE v1: `payload` is sealed inside `enc` ({...payload} JSON); the
   * plaintext payload field is omitted. `action` stays in the clear for
   * routing. Devices accept both forms (older viewers send plaintext).
   */
  | { type: "req"; requestId: string; action: DeviceAction; payload?: unknown; enc?: StreamEnvelope }
  /**
   * Deliberate kick. The accompanying WS close frame carries the same reason
   * plus a code so clients can tell kicks from network drops and stop
   * reconnecting: 4409 replaced by a newer connection (shared deviceId),
   * 4003 api key deleted/rotated, 4010 blocked/removed by admin, 4001 auth.
   */
  | { type: "kick"; reason: string };

// ── viewer → server ──────────────────────────────────────────
export type ViewerToServerMsg =
  | { type: "auth"; apiKey?: string; sessionToken?: string; caps?: string[] }
  | { type: "devices" }
  | { type: "subscribe"; deviceId: string }
  /**
   * E2EE v1: `payload` sealed inside `enc` (relays ≥ 1.5.0 unseal it for
   * audit/prompts.jsonl, then re-seal toward the device). `sessionId` may
   * ride the plaintext layer so audit attribution survives encryption.
   */
  | { type: "req"; requestId: string; deviceId: string; action: DeviceAction; payload?: unknown; enc?: StreamEnvelope; sessionId?: string }
  | { type: "audit"; limit?: number }
  | { type: "auditClear" }
  | { type: "prompts"; limit?: number }
  | { type: "rotateKey"; keyId: string }
  | { type: "revealKey"; keyId: string }
  | { type: "blockDevice"; deviceId: string; blocked: boolean }
  | { type: "removeDevice"; deviceId: string }
  | { type: "serverInfo" }
  | { type: "listKeys" }
  | { type: "createKey"; name: string }
  | { type: "renameKey"; keyId: string; name: string }
  | { type: "deleteKey"; keyId: string };

// ── server → viewer ──────────────────────────────────────────
export type ServerToViewerMsg =
  | { type: "authOk"; keyTail: string; keyName: string; keyId: string; caps?: string[] }
  /**
   * E2EE v1: delivered to session-token (console) viewers on subscribe —
   * the per-device stream key (base64 32B), derived from the device's
   * registered API key. API-key viewers derive it locally instead and never
   * receive this frame. Travels inside TLS; the relay holds the key anyway.
   */
  | { type: "streamKey"; deviceId: string; key: string }
  | { type: "authFailed" }
  | { type: "devices"; devices: DeviceSummary[] }
  | { type: "keys"; keys: KeySummary[] }
  | { type: "keyCreated"; key: string; summary: KeySummary }
  | { type: "event"; deviceId: string; sessionId?: string; event?: unknown; enc?: StreamEnvelope }
  | { type: "res"; requestId: string; ok: true; result?: unknown; enc?: StreamEnvelope }
  | { type: "res"; requestId: string; ok: false; error?: string; enc?: StreamEnvelope }
  | { type: "audit"; logs: AuditEntry[] }
  | { type: "prompts"; logs: PromptLogEntry[] }
  | { type: "keyRotated"; key: string }
  | { type: "keyRevealed"; keyId: string; key: string }
  | { type: "serverInfo"; info: ServerInfo }
  | { type: "error"; message: string };

export interface ServerInfo {
  version: string;
  uptimeSec: number;
  devicesOnline: number;
  devicesRegistered: number;
  viewers: number;
  rssMB: number;
}

export function safeParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
