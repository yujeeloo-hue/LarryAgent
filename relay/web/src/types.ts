import type { Session, SessionStatus, Message, MessagePart, ToolResultPart } from "../../../src/session/types.js";
import type { SessionSummary, StartTurnResponse, QueuedPrompt, QueuedPromptMode, EnqueuePromptResponse, PromptQueueMutationResponse } from "../../../src/agent/ipcTypes.js";
import type { StreamEvent } from "../../../src/llm/streamEvents.js";
import type { UserAskAnswer } from "../../../src/tools/types.js";
import type { ReasoningEffort } from "../../../src/llm/reasoningEffort.js";

export type { Session, SessionStatus, Message, MessagePart, ToolResultPart, SessionSummary, StartTurnResponse, QueuedPrompt, QueuedPromptMode, EnqueuePromptResponse, PromptQueueMutationResponse, StreamEvent, UserAskAnswer, ReasoningEffort };

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

export type ConsoleStreamEvent =
  | StreamEvent
  | {
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
      type: "user_ask_dismiss";
      requestId: string;
      sessionId: string;
      toolCallId: string;
    }
  | {
      type: "session_deleted";
      sessionId: string;
    }
  | {
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
  keyId?: string;
  keyName?: string;
  runningSessions?: number;
  ip?: string;
  ua?: string;
  ipHistory?: Array<{ ip: string; ts: number }>;
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

export interface DeviceExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
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

export interface ComposerOptions {
  providers: Array<{ id: string; name: string; modelId: string }>;
  activeProviderId: string;
  defaults: {
    composerInfinite: boolean;
    reasoningEffort: ComposerReasoningEffort;
    reasoningEffortMax?: boolean;
    contextLimitTokens?: number;
  };
  remoteMode: "readonly" | "full";
}

export interface RemoteAttachmentDraft {
  path: string;
  name: string;
  kind: "image" | "file" | "audio" | "video" | "source_code";
  mimeType: string;
  sizeBytes?: number;
}

export interface DeviceEventEnvelope {
  deviceId: string;
  sessionId: string;
  event: ConsoleStreamEvent;
}


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

export type CocoUserAsk = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  options: string[];
  allowCustom: boolean;
  allowMultiple: boolean;
  onBehalfOf?: string;
};

export type CocoToolApprovalRequest = {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: CocoJsonObject;
  expiresAt: number;
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
