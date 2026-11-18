
export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  version: string;
}

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
  keyId?: string;
  keyName?: string;
  runningSessions?: number;
  ip?: string;
  ua?: string;
  ipHistory?: { ip: string; ts: number }[];
  caps?: string[];
  maintenance?: DeviceMaintenanceState;
}

export interface DeviceMaintenanceState {
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

export interface AuditEntry {
  ts: number;
  actor: string;
  action: string;
  detail?: string;
}

export interface PromptLogEntry {
  ts: number;
  deviceId: string;
  deviceName: string;
  keyId: string;
  keyName: string;
  actor: string;
  action: string;
  sessionId?: string;
  text: string;
}

export type DeviceAction =
  | "listSessions"
  | "listWorkspaces"
  | "browseDir"
  | "createWorkspace"
  | "getSession"
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
  | "readTextFile"
  | "filterExistingFiles"
  | "getPathsDiffStats"
  | "deviceStatus"
  | "restartDevice"
  | "updateDevice"
  | "rebootDevice"
  | "checkUpdate"
  | "deviceExec"
  | "listSyncProviders"
  | "exportSyncProvider"
  | "upsertSyncProvider"
  | "removeSyncProvider"
  | "listSyncMcpServers"
  | "exportSyncMcpServer"
  | "upsertSyncMcpServer"
  | "removeSyncMcpServer"
  | "listSyncSkills"
  | "exportSyncSkill"
  | "upsertSyncSkill"
  | "removeSyncSkill"
  | "cocoSnapshot"
  | "cocoCommand";

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

export function requestTimeoutMsFor(action: string): number {
  if (action === "uploadAttachment") return 120_000;
  if (action === "deviceExec") return 150_000;
  if (action === "upsertSyncMcpServer") return 30_000;
  if (action === "upsertSyncSkill" || action === "exportSyncSkill") return 30_000;
  return 20_000;
}

export const MAX_WS_PAYLOAD_BYTES = 32 * 1024 * 1024;

import type { StreamEnvelope } from "./streamCipher.js";

export type DeviceToServerMsg =
  | { type: "hello"; device: DeviceInfo; caps?: string[] }
  | { type: "event"; sessionId?: string; event?: unknown; enc?: StreamEnvelope }
  | { type: "status"; runningSessions?: number; maintenance?: DeviceMaintenanceState }
  | { type: "res"; requestId: string; ok: true; result?: unknown; enc?: StreamEnvelope }
  | { type: "res"; requestId: string; ok: false; error?: string; enc?: StreamEnvelope }
  | { type: "auth"; apiKey: string };

export type ServerToDeviceMsg =
  | { type: "welcome"; viewers?: number; caps?: string[] }
  | { type: "presence"; viewers: number }
  | { type: "req"; requestId: string; action: DeviceAction; payload?: unknown; enc?: StreamEnvelope }
  | { type: "kick"; reason: string };

export type ViewerToServerMsg =
  | { type: "auth"; apiKey?: string; sessionToken?: string; caps?: string[] }
  | { type: "devices" }
  | { type: "subscribe"; deviceId: string }
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

export type ServerToViewerMsg =
  | { type: "authOk"; keyTail: string; keyName: string; keyId: string; caps?: string[] }
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
