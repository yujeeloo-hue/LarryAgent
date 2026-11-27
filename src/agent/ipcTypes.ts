import type { StreamEvent } from "../llm/streamEvents.js";
import type { ReasoningEffort } from "../llm/reasoningEffort.js";
import type {
  AttachmentKind,
  JsonObject,
  Session,
  SessionSource,
  SessionStatus,
  SessionType,
  UserMessage,
} from "../session/types.js";
import type { Workspace } from "../workspace/types.js";
import type { ToolApprovalRisk, ToolConfirmationSource } from "../tools/types.js";

export type SessionSummary = {
  id: string;
  title: string;
  updatedAt: number;
  status: SessionStatus;
  progressText: string;
  type: SessionType;
  messageCount: number;
  workspaceId: string;
  archived: boolean;
  archivedAt: number | null;
  source?: SessionSource;
};

export type AttachmentDraft = {
  path: string;
  name: string;
  kind: AttachmentKind;
  mimeType: string;
  sizeBytes?: number;
  s3?: { url: string; key: string };
};

export type ComposerRunMode = "agent" | "ask" | "plan" | "custom";

export type StartTurnRequest = {
  cocoExecutionId?: string;
  sessionId?: string;
  workspaceId?: string;
  providerId?: string;
  title?: string;
  userText: string;
  fullPermissions: boolean;
  autoSkillSummarize?: boolean;
  runMode?: ComposerRunMode;
  fsmGraphId?: string;
  planMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  composerInfinite?: boolean;
  attachments?: AttachmentDraft[];
  editorContext?: {
    activeFile?: string | null;
    openFiles?: string[];
  };
  continuation?: "retry";
  suppressUserMessage?: boolean;
  resumeAfterUserAsk?: boolean;
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  controlIntent?: "approve" | "discard";
  source?: SessionSource;
  headless?: boolean;
  cocoWorkId?: string;
};

export type StartTurnResponse = {
  sessionId: string;
};

export type QueuedPromptMode = "deferred" | "interrupt";

export type QueuedPrompt = {
  id: string;
  sessionId: string;
  userText: string;
  attachments: AttachmentDraft[];
  createdAt: number;
  mode: QueuedPromptMode;
  cocoWorkId?: string;
};

export type PendingSteer = QueuedPrompt;

export type CocoChatPrompt = Pick<QueuedPrompt, "userText" | "attachments" | "cocoWorkId"> & {
  continuation?: "retry";
};

export type EnqueuePromptRequest = {
  sessionId: string;
  userText: string;
  attachments?: AttachmentDraft[];
  mode?: QueuedPromptMode;
  cocoWorkId?: string;
};

export type EnqueuePromptResponse = {
  queued: QueuedPrompt;
  items: QueuedPrompt[];
};

export type PromptQueueMutationResponse = {
  ok: boolean;
  reason?: string;
  started?: boolean;
  items: QueuedPrompt[];
};

export type AgentStreamPayload = {
  sessionId: string;
  event: StreamEvent;
};

export type ToolApprovalRequestPayload = {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: JsonObject;
  expiresAt: number;
  risk?: ToolApprovalRisk;
  source?: ToolConfirmationSource;
};

export type ToolApprovalDismissPayload = {
  requestId: string;
  sessionId: string;
};

export type ToolApprovalResponseRequest = {
  requestId: string;
  approved: boolean;
};

export type UserAskRequestPayload = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  detail?: string;
  options: string[];
  optionDetails?: import("../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
  suppressChime?: boolean;
  passwordDestination?: import("../shared/askUser.js").HandoffPasswordDestination;
  handoffQrPng?: string;
};

export type UserAskDismissPayload = {
  requestId: string;
  sessionId: string;
  toolCallId: string;
};

export type UserAskResponseRequest = {
  requestId: string;
  selected?: string | null;
  selections?: string[] | null;
  custom?: boolean;
  comment?: string;
};

export type CreateWorkspaceRequest = {
  name: string;
  path: string;
  origin?: "coco";
};

export type UpdateWorkspaceRequest = {
  id: string;
  name?: string;
  path?: string;
};

export function toSessionSummary(session: Session): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    updatedAt: session.updatedAt,
    status: session.status,
    progressText: session.progressText,
    type: session.type,
    messageCount: session.messages.length,
    workspaceId: session.workspaceId,
    archived: session.archived,
    archivedAt: session.archivedAt,
    ...(session.source ? { source: session.source } : {}),
  };
}

export type { Workspace };
export type { SessionSearchHit } from "./searchSessions.js";
