/**
 * Console types — protocol mirror + JellyBot domain types (type-only imports
 * from the main source tree so shapes can never drift silently).
 */
import type { Session, SessionStatus, Message, MessagePart, ToolResultPart } from "../../../src/session/types.js";
import type { SessionSummary, StartTurnResponse, QueuedPrompt, QueuedPromptMode, EnqueuePromptResponse, PromptQueueMutationResponse } from "../../../src/agent/ipcTypes.js";
import type { StreamEvent } from "../../../src/llm/streamEvents.js";
import type { UserAskAnswer } from "../../../src/tools/types.js";
import type { ReasoningEffort } from "../../../src/llm/reasoningEffort.js";

export type { Session, SessionStatus, Message, MessagePart, ToolResultPart, SessionSummary, StartTurnResponse, QueuedPrompt, QueuedPromptMode, EnqueuePromptResponse, PromptQueueMutationResponse, StreamEvent, UserAskAnswer, ReasoningEffort };

/** Composer reasoning-effort dial level (alias for readability). */
export type ComposerReasoningEffort = ReasoningEffort;

export const COMPOSER_EFFORT_LEVELS: ReadonlyArray<{
  id: ComposerReasoningEffort;
  short: string;
  name: string;
}> = [
  { id: "off", short: "OFF", name: "Off" },
  { id: "low", short: "LOW", name: "Low" },
  { id: "medium", short: "MED", name: "Medium" },
  { id: "high", short: "HIGH", name: "High" },
  { id: "max", short: "MAX", name: "Max" },
];

export function isComposerReasoningEffort(
  value: unknown,
): value is ComposerReasoningEffort {
  return (
    value === "off" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "max"
  );
}

/**
 * Stream events the console may receive beyond the agent StreamEvent union.
 * The device remote bridge synthesizes these from agent:userAsk /
 * agent:userAskDismiss broadcasts (sessionRuntime) so the web console can
 * render interactive ask panels during a live turn — Mac parity.
 */
export type ConsoleStreamEvent =
  | StreamEvent
  | {
      /** An ask_user / request_full_permissions card is waiting for an answer. */
      type: "user_ask";
      ask: {
        requestId: string;
        sessionId: string;
        toolCallId: string;
        question: string;
        options: string[];
        optionDetails?: import("../../../src/shared/askUser.js").UserAskOption[];
        allowCustom: boolean;
        allowMultiple: boolean;
      };
    }
  | {
      /** Pending ask settled (answered or cancelled), possibly on the Mac. */
      type: "user_ask_dismiss";
      requestId: string;
      sessionId: string;
      toolCallId: string;
    }
  | {
      /** The session was deleted on the device — drop it from the list live. */
      type: "session_deleted";
      sessionId: string;
    }
  | {
      /**
       * The device's LLM provider list changed (local settings edit, backup
       * import, or Token Hub sync) — cached listComposerOptions are stale;
       * invalidate the probe and repaint composer surfaces.
       */
      type: "providers_changed";
    };

export interface DeviceSummary {
  deviceId: string;
  name: string;
  platform: string;
  version: string;
  online: boolean;
  firstSeen: number;
  lastSeen: number;
  blocked: boolean;
  /** Key the device registered under (multi-key relay). */
  keyId?: string;
  keyName?: string;
  /** Live count of sessions with a turn in flight (absent on old device builds). */
  runningSessions?: number;
  /** Client IP of the most recent connection (server-side, XFF last hop / socket). */
  ip?: string;
  /** User-Agent of the most recent connection (absent for Node `ws` device clients). */
  ua?: string;
  /** Connection IP history, newest first. */
  ipHistory?: Array<{ ip: string; ts: number }>;
  /**
   * Device capabilities from `hello.caps` (mirror of relay/src/protocol.ts):
   * `"maintenance"` (remote update/restart of the process), `"reboot"`
   * (host reboot — agentd only), `"exec"` (sandboxed remote shell — agentd
   * only). Absent on devices/relays that predate the field.
   */
  caps?: string[];
  /** Live remote-maintenance state (agentd ≥ 1.3.1). */
  maintenance?: DeviceMaintenanceState;
}

export interface DeviceMaintenanceState {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  id?: string;
  source?: string;
  version?: string;
  error?: string;
  logTail?: string;
  /** Machine-readable pipeline step (agentd ≥ 1.4; absent on old devices). */
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

/** deviceExec result payload (agentd ≥ 1.3.5, sandboxed one-shot shell). */
export interface DeviceExecResult {
  /** Numeric exit code; null when the child was killed by a signal. */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  /** A stream exceeded the device-side cap and was cut. */
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export interface KeySummary {
  id: string;
  name: string;
  keyTail: string;
  createdAt: number;
  deviceCount: number;
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

export interface ServerInfo {
  version: string;
  uptimeSec: number;
  devicesOnline: number;
  devicesRegistered: number;
  viewers: number;
  rssMB: number;
}

export type DeviceAction =
  | "listSessions"
  | "listWorkspaces"
  | "browseDir"
  | "createWorkspace"
  | "getSession"
  /** Delete a session on the device {sessionId} — devices ≥ 1.3.4. */
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
  /** Read-only file inspection for the Files pane. */
  | "readTextFile"
  | "filterExistingFiles"
  | "getPathsDiffStats"
  /** Device maintenance (agentd ≥ 1.3.1 headless nodes). */
  | "deviceStatus"
  | "restartDevice"
  | "updateDevice"
  | "rebootDevice"
  | "checkUpdate"
  /** Run one shell command {command, timeoutMs?} — agentd devices ≥ 1.3.5. */
  | "deviceExec"
  /** Token Provider Hub sync (devices that implement the actions). */
  | "listSyncProviders"
  | "exportSyncProvider"
  | "upsertSyncProvider"
  | "removeSyncProvider"
  /** MCP Hub sync (devices that implement the actions). */
  | "listSyncMcpServers"
  | "exportSyncMcpServer"
  | "upsertSyncMcpServer"
  | "removeSyncMcpServer"
  /** Skill Hub sync (devices that implement the actions). */
  | "listSyncSkills"
  | "exportSyncSkill"
  | "upsertSyncSkill"
  | "removeSyncSkill"
  /** CoCo — engine snapshot (read-only); desktop devices with the "coco" cap. */
  | "cocoSnapshot"
  /** CoCo — forward one CocoCommand (chat / chatControl / goal / work / rule /
   *  budget / activation); full-control, audited. */
  | "cocoCommand";

/** Composer capability snapshot for one device (listComposerOptions). */
export interface ComposerOptions {
  providers: Array<{ id: string; name: string; modelId: string }>;
  activeProviderId: string;
  /** Settings defaults a New Task composer starts from (Mac parity). */
  defaults: {
    composerInfinite: boolean;
    reasoningEffort: ComposerReasoningEffort;
    /** Legacy device builds still report the Max boolean instead. */
    reasoningEffortMax?: boolean;
    /** Context window limit (tokens); absent on older device builds. */
    contextLimitTokens?: number;
  };
  /** Device Remote mode — Bypass is only offerable under "full". */
  remoteMode: "readonly" | "full";
  /** Older device builds reject the action — callers fall back gracefully. */
}

/** Device-side attachment draft (uploadAttachment result). */
export interface RemoteAttachmentDraft {
  path: string;
  name: string;
  kind: "image" | "file" | "audio" | "video" | "source_code";
  mimeType: string;
  sizeBytes?: number;
}

/** A live agent event scoped to one device + session. */
export interface DeviceEventEnvelope {
  deviceId: string;
  sessionId: string;
  event: ConsoleStreamEvent;
}

// ── CoCo engine mirror (source of truth: src/coco/types.ts) ─────────────
// Mirrors only what the web CoCo view renders. Keep field names in sync;
// extra engine-side fields may arrive and are ignored.

/** JSON object as the device sends it (display-only on the web). */
export type CocoJsonObject = Record<string, unknown>;

export type CocoCadence =
  | { kind: "minute"; n: number }
  | { kind: "hour"; minute: number }
  | { kind: "day"; time: string }
  | { kind: "week"; weekdays: number[]; time: string }
  | { kind: "month"; day: number; time: string }
  | { kind: "year"; month: number; day: number; time: string };

export type CocoScope = { all: boolean; workspaceIds: string[]; excludedWorkspaceIds: string[] };

export type CocoSettings = {
  enabled: boolean;
  providerId: string;
  fastProviderId?: string;
  hourlyTokens: number;
  dailyTokens: number;
  timezone: string;
  excludedWorkspaceIds: string[];
  fullPermissions: boolean;
  heartbeatMinutes: number;
  repairLimit: number;
  reportTime: string;
  historyRetentionDays: number;
};

export type CocoWorkStatus =
  | "draft" | "queued" | "executing" | "recovering" | "verifying"
  | "waiting" | "to_decide" | "completed" | "cancelled";

export type CocoTimelineEntry = { at: number; text: string; status?: CocoWorkStatus; revision?: number };

export type CocoCriterion = {
  id: string;
  description: string;
  kind: "review" | "file_exists" | "file_contains" | "command_succeeded";
  path?: string;
  text?: string;
  command?: string;
};

/** Structured choice UI for work waiting on a user decision. */
export type CocoDecisionPrompt = {
  question: string;
  options: string[];
  allowCustom?: boolean;
  allowMultiple?: boolean;
};

export type CocoWork = {
  id: string;
  goalId: string;
  title: string;
  objective: string;
  workspaceId: string;
  status: CocoWorkStatus;
  priority: number;
  prioritySource?: "user" | "coco";
  deadlineAt?: number;
  dependsOn: string[];
  steps: string[];
  acceptance: CocoCriterion[];
  deliverables: string[];
  ruleIds: string[];
  sessionId?: string;
  waitingForSession?: boolean;
  budgetHold?: boolean;
  revision: number;
  repairs: number;
  createdAt: number;
  updatedAt: number;
  summary: string;
  decision?: string;
  decisionPrompt?: CocoDecisionPrompt;
  timeline: CocoTimelineEntry[];
};

export type CocoRule = {
  id: string;
  name: string;
  objective: string;
  mode: "fixed" | "inspection";
  scope: CocoScope;
  enabled: boolean;
  confirmed: boolean;
  cadence: CocoCadence;
  origin?: "coco" | "user";
  draftOnly?: boolean;
  fullPermissions: boolean;
  providerId: string;
  acceptance: CocoCriterion[];
  nextRunAt: number;
  createdAt: number;
};

export type CocoMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  status?: "streaming" | "completed" | "stopped" | "error";
  origin?: "wake";
  workId?: string;
  goalId?: string;
};

export type CocoReport = { id: string; at: number; title: string; markdown: string; workIds: string[] };

export type CocoBackgroundTask = {
  id: string;
  sessionId: string;
  purpose: string;
  title: string;
  workId?: string;
  status: "running" | "completed" | "error" | "interrupted";
  startedAt: number;
  updatedAt: number;
  progress: string;
  summary: string;
};

/** One scheduled/manual rule run (Recent runs on the Overview page). */
export type CocoRuleRun = {
  id: string;
  source?: "rule" | "chat";
  ruleId: string;
  ruleName: string;
  startedAt: number;
  endedAt?: number;
  status: "running" | "retrying" | "no_action" | "planned" | "failed";
  attempts: number;
  summary?: string;
  error?: string;
};

/** Live ask_user panel state inside the CoCo chat session. */
export type CocoUserAsk = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  allowMultiple: boolean;
  /** Present when the ask is parked from a handed-over session (D-4). */
  onBehalfOf?: string;
};

/** Live tool-approval request state inside the CoCo chat session. */
export type CocoToolApprovalRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: CocoJsonObject;
  expiresAt: number;
  /** Present when the approval is parked from a handed-over session (D-4). */
  onBehalfOf?: string;
};

export type CocoChatState = {
  sessionId: string;
  status: string;
  question?: CocoUserAsk;
  approval?: CocoToolApprovalRequest;
};

export type CocoSnapshot = {
  state: "idle" | "working" | "paused" | "cooldown" | "blocked" | "stopping";
  settings: CocoSettings;
  budget: { hourly: number; daily: number; estimated: boolean };
  work: CocoWork[];
  rules: CocoRule[];
  messages: CocoMessage[];
  reports: CocoReport[];
  workspaces: { id: string; name: string }[];
  chat?: CocoChatState;
  backgroundTasks?: CocoBackgroundTask[];
  ruleRuns?: CocoRuleRun[];
  error?: string;
  resumeAt?: number;
};

export type CocoCommand =
  | { type: "chatControl"; action: "stop" }
  | { type: "chatControl"; action: "answer"; requestId: string; selected: string; selections?: string[]; custom: boolean }
  | { type: "chatControl"; action: "approval"; requestId: string; approved: boolean }
  | { type: "chat"; text: string; workId?: string; workspaceId?: string; planOnly?: boolean; continuation?: "retry" }
  | { type: "work"; id: string; action: "start" | "pause" | "resume" | "cancel" | "priority"; priority?: number; answer?: string }
  | { type: "rule"; action: "confirm" | "toggle" | "delete" | "run"; id: string }
  | { type: "budget"; action: "reset" };
