import type { JsonObject, SessionStatus } from "../session/types.js";
import type { ContextUsageBreakdown } from "../shared/contextUsageBreakdown.js";

export type ProviderRequestSafety = "read_only" | "effects_possible";


export type StreamTextDeltaEvent = {
  type: "text_delta";
  text: string;
  messageId?: string;
};

export type StreamReasoningDeltaEvent = {
  type: "reasoning_delta";
  text: string;
  messageId?: string;
};

export type StreamHostedToolEvent = {
  type: "hosted_tool";
  id: string;
  name: string;
  status: "in_progress" | "completed" | "failed" | "incomplete";
  item?: JsonObject;
  messageId?: string;
};

export type StreamResponseStateEvent = {
  type: "response_state";
  responseId: string;
  status: string;
  output?: JsonObject[];
  stored?: boolean;
  requestSafety?: ProviderRequestSafety;
  rejectedPreviousResponseId?: string;
  rejectedStore?: boolean;
  rejectedReasoningReplay?: true;
  messageId?: string;
};

export type StreamToolCallDeltaEvent = {
  type: "tool_call_delta";
  id: string;
  messageId?: string;
  name?: string;
  argumentsRawDelta: string;
};

export type StreamToolCallEvent = {
  type: "tool_call";
  id: string;
  messageId?: string;
  name: string;
  arguments: JsonObject;
  argumentsRaw: string;
  argumentsError?: string;
};

export type StreamToolFinishedEvent = {
  type: "tool_finished";
  id: string;
  messageId: string;
  name?: string;
};

export type StreamStatusValue = SessionStatus | "streaming" | "tool_running";

export type StreamStatusEvent = {
  type: "status";
  status: StreamStatusValue;
};

export type StreamProgressEvent = {
  type: "progress";
  text: string;
  toolName?: string;
};

export type StreamRoundInterruptedEvent = {
  type: "round_interrupted";
  messageId: string;
};

export type StreamUsageEvent = {
  type: "usage";
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  contextDisplayHandled?: true;
};

export type StreamContextDisplayEvent = {
  type: "context_display";
  usedTokens: number;
  source: "provider" | "estimate";
  cachedTokens?: number;
  inputTokens?: number | null;
  breakdown?: ContextUsageBreakdown;
};

export type StreamErrorEvent = {
  type: "error";
  message: string;
  returnCode?: number;
};

export type StreamDoneReason =
  | "completed"
  | "cancelled"
  | "paused"
  | "error";

export type StreamDoneEvent = {
  type: "done";
  reason: StreamDoneReason;
};

export type StreamPlanEvent = {
  type: "plan";
  plan: import("../session/types.js").SessionPlan | null;
};

export type StreamPhaseEvent = {
  type: "phase";
  phase: import("../session/types.js").Phase | null;
  error?: string;
};

export type StreamPlanApprovalEvent = {
  type: "plan_approval";
  pending: boolean;
  error?: string;
};

export type StreamSubagentEvent = {
  type: "subagent";
  id: string;
  parentToolCallId: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "cancelled";
  title: string;
  priority?: number;
  progressText?: string;
  summary?: string;
  errorMessage?: string;
  usedTokens?: number;
};

export type StreamSubagentLiveEvent = {
  type: "subagent_live";
  id: string;
  name: string;
  role: string;
  status:
    | "queued"
    | "running"
    | "completed"
    | "error"
    | "cancelled";
  kind: "delta" | "reasoning" | "tool";
  text?: string;
  tool?: {
    id: string;
    name: string;
    summary: string;
    finished: boolean;
  };
};

export type StreamFullPermissionsEvent = {
  type: "full_permissions";
  enabled: boolean;
};

export type StreamFsmNodeEvent = {
  type: "fsm_node";
  nodeId: string;
  phase: "enter";
  transition?: { from: string; to: string };
};

export type StreamSteerConsumedEvent = {
  type: "steer_consumed";
  id: string;
  applied: boolean;
};

export type StreamToolLiveEvent = {
  type: "tool_live";
  toolCallId: string;
  kind: string;
  payload: import("../session/types.js").JsonObject;
};

export type StreamPromptQueueEvent = {
  type: "prompt_queue";
  items: {
    id: string;
    sessionId: string;
    userText: string;
    attachments: {
      path: string;
      name: string;
      kind: string;
      mimeType: string;
      sizeBytes?: number;
    }[];
    createdAt: number;
    mode: "deferred" | "interrupt";
  }[];
};

export type StreamPromptRestoredEvent = {
  type: "prompt_restored";
  text: string;
  attachments: {
    path: string;
    name: string;
    kind: string;
    mimeType: string;
    sizeBytes?: number;
  }[];
};

export type StreamEvent =
  | {type:"transcript_changed"}
  | {type:"new_task_boundary"}
  | StreamTextDeltaEvent
  | StreamReasoningDeltaEvent
  | StreamHostedToolEvent
  | StreamResponseStateEvent
  | StreamToolCallDeltaEvent
  | StreamToolCallEvent
  | StreamToolFinishedEvent
  | StreamStatusEvent
  | StreamProgressEvent
  | StreamRoundInterruptedEvent
  | StreamUsageEvent
  | StreamContextDisplayEvent
  | StreamErrorEvent
  | StreamDoneEvent
  | StreamPlanEvent
  | StreamPhaseEvent
  | StreamPlanApprovalEvent
  | StreamSubagentEvent
  | StreamSubagentLiveEvent
  | StreamFullPermissionsEvent
  | StreamSteerConsumedEvent
  | StreamPromptQueueEvent
  | StreamPromptRestoredEvent
  | StreamFsmNodeEvent
  | StreamToolLiveEvent;
