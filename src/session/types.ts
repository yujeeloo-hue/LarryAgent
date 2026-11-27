import type { ContextUsageBreakdown } from "../shared/contextUsageBreakdown.js";

export type TimestampMs = number;

export type SessionType = "agent";

export type SessionSource = "app" | "subagent" | "loop" | "coco" | "coco_chat" | "coco_internal";

export function isSessionSource(value: unknown): value is SessionSource {
  return value === "app" || value === "subagent" || value === "loop" || value === "coco" || value === "coco_chat" || value === "coco_internal";
}

export type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

export type SessionContextUsage = {
  usedTokens: number;
  displayUsedTokens?: number;
  cachedTokens?: number;
  inputTokens?: number | null;
  breakdown?: ContextUsageBreakdown;
  source?: "provider" | "estimate";
  requestEstimateTokens?: number;
};

export const PLAN_DOC_SUMMARY_MAX = 400;

export type PlanStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "cancelled";

export type PlanStatus = "active" | "completed" | "cancelled";

export type PlanStep = {
  id: string;
  title: string;
  status: PlanStepStatus;
  dependsOn?: string[];
};

export type SessionPlan = {
  id: string;
  title: string;
  status: PlanStatus;
  steps: PlanStep[];
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  createToolCallId: string;
  summary?: string;
  cardVisible?: boolean;
  planDoc?: {
    path: string;
    summary: string;
  };
};

export type SessionPlanDoc = {
  path: string;
  summary: string;
  updatedAt: TimestampMs;
  revision?: string;
  reviewedRevision?: string;
  approvedRevision?: string;
  approvedAt?: TimestampMs;
  executionRequestedRevision?: string;
  approvalPending?: boolean;
  stagedPlan?: {
    title: string;
    steps: Array<string | { title: string; dependsOn?: string[] }>;
    updatedAt: TimestampMs;
  };
};

export type Phase = import("./phase.js").Phase;
export type PlanPhase = Phase;

export type MessageRole = "user" | "assistant" | "system" | "tool";

export const STEER_CONTINUATION_PART_ID = "turn-continuation:steer";

export const RETRY_CONTINUATION_PART_ID = "turn-continuation:retry";

export type ToolCallStatus =
  | "pending"
  | "running"
  | "done"
  | "error"
  | "cancelled";

export type AttachmentKind =
  | "image"
  | "file"
  | "audio"
  | "video"
  | "source_code";

export type JsonObject = { [key: string]: JsonValue };
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | JsonObject;

export type TextPart = {
  type: "text";
  text: string;
  annotations?: JsonObject[];
  id?: string;
  path?: string;
  edited?: boolean;
  error?: boolean;
};

export type ReasoningPart = {
  type: "reasoning";
  text: string;
  providerScope?: string;
  id?: string;
  durationMs?: number;
  tokenCount?: number;
};

export type HostedToolPart = {
  type: "hosted_tool";
  id: string;
  name: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  item?: JsonObject;
};

export type ModelResponsePart = {
  type: "model_response";
  providerScope: string;
  model?: string;
  responseId: string;
  status: string;
  stored: boolean;
  output: JsonObject[];
  reasoningDisabled?: true;
  contextHash?: string;
  contextLength?: number;
  requestItemHashes?: string[];
  continuationInput?: JsonObject[];
  hostedEffects?: boolean;
  requestSafety?: "read_only" | "effects_possible";
  contextReplayBlocked?: boolean;
  resumeFrom?: Omit<ModelResponsePart, "type" | "resumeFrom">;
};

export type AttachmentS3Info = {
  url: string;
  key: string;
};

export type AttachmentPart = {
  type: "attachment";
  kind: AttachmentKind;
  uri: string;
  mimeType: string;
  name?: string;
  sizeBytes?: number;
  id?: string;
  s3?: AttachmentS3Info;
  thumbnailBase64?: string;
  thumbnailMimeType?: string;
  htmlBase64?: string;
};

export type ToolResultContentPart = TextPart | AttachmentPart;

export type ToolCallPart = {
  type: "tool_call";
  id: string;
  name: string;
  status: ToolCallStatus;
  arguments: JsonObject;
  argumentsRaw: string;
  argumentsError?: string;
  durationMs?: number;
};

export type ToolResultPart = {
  type: "tool_result";
  toolCallId: string;
  content: ToolResultContentPart[];
  returnCode: number;
  executionSummary?: string;
};

export type ContextCompactionWarmFold = {
  userMessageId: string;
  text: string;
};

export type ContextCompactionPart = {
  type: "context_compaction";
  id: string;
  summary: string;
  fromMessageId: string;
  toMessageId: string;
  usedTokensBefore: number;
  usedTokensAfter: number;
  coveredThroughUserMessageId?: string;
  coveredThroughMessageId?: string;
  coldTurnCount?: number;
  warmFolds?: ContextCompactionWarmFold[];
  demoVerbatim?: string;
};

export type ContextClearPart = {
  type: "context_clear";
  id: string;
  clearedMessageCount: number;
};

export type ContextNewTaskPart = {
  type: "context_new_task";
  id: string;
  reason?: "unrelated_prompt";
  hiddenMessageCount: number;
};

export type TurnContextPart = {
  type: "turn_context";
  source: "repository_snapshot";
  text: string;
};

export type SessionContextBuckets = {
  hotTurnCount: number;
  warmTurnCount: number;
  hot: number;
  warm: number;
  cold: number;
  updatedAt: TimestampMs;
};

export type MessagePart =
  | TextPart
  | ReasoningPart
  | HostedToolPart
  | ModelResponsePart
  | ToolCallPart
  | ToolResultPart
  | AttachmentPart
  | ContextCompactionPart
  | ContextClearPart
  | ContextNewTaskPart
  | TurnContextPart;

type MessageBase = {
  id: string;
  parts: MessagePart[];
  createdAt: TimestampMs;
};

export type UserMessage = MessageBase & {
  role: "user";
};

export type SystemMessage = MessageBase & {
  role: "system";
};

export type AssistantMessage = MessageBase & {
  role: "assistant";
  toolCallId?: string;
};

export type ToolMessage = MessageBase & {
  role: "tool";
  toolCallId: string;
};

export type Message =
  | UserMessage
  | SystemMessage
  | AssistantMessage
  | ToolMessage;

export type Session = {
  id: string;
  type: SessionType;
  source?: SessionSource;
  title: string;
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
  status: SessionStatus;
  progressText: string;
  messages: Message[];
  model: string;
  providerId: string;
  workspaceId: string;
  workspacePath: string;
  pinned: boolean;
  archived: boolean;
  archivedAt: TimestampMs | null;
  contextUsage: SessionContextUsage;
  contextBuckets?: SessionContextBuckets;
  plan: SessionPlan | null;
  planDoc?: SessionPlanDoc | null;
  phase?: Phase | null;
  pendingUserAsk?: import("./pendingUserAsk.js").SessionPendingUserAsk | null;
  composerRunMode?: import("../agent/ipcTypes.js").ComposerRunMode | null;
  composerFsmGraphId?: string | null;
  composerInfinite?: boolean | null;
  reasoningEffort?: import("../llm/reasoningEffort.js").ReasoningEffort | null;
  fsmLastGraphMode?:
    | "react"
    | "ask"
    | "plan_execute"
    | "subagent"
    | null;
  fsmLastGraphId?: string | null;
  fsmLastNodeId?: string | null;
  fsmLastNodeAt?: number | null;
  fsmBlackboard?: Record<string, unknown> | null;
};
