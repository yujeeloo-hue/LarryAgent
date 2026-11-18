
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiChatMessage,
  OpenAiCompatibleClientConfig,
  OpenAiToolDefinition,
} from "../../llm/types.js";
import type { AttachmentDraft, PendingSteer } from "../ipcTypes.js";
import type {
  AssistantMessage,
  Session,
  SessionStatus,
  TextPart,
  ToolCallPart,
} from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { SessionPatch } from "../contracts/index.js";
import type {
  DesktopNotifyInput,
  FsmRunShellInput,
  FsmRunShellResult,
  RunAgentTurnResult,
  StreamChatFn,
  SummarizeFn,
} from "../types.js";

export type TurnRunResult = RunAgentTurnResult;

export type TurnStreamLlm = {
  client: OpenAiCompatibleClientConfig;
  stream: StreamChatFn;
};

export type TurnStartOptions = {
  userText: string;
  attachments?: AttachmentDraft[];
  continuation?: "retry";
  suppressUserMessage?: boolean;
  skipTopicBoundary?: boolean;
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  parentSessionId?: string;
  subagentId?: string;
};

export type PrepareToolsInput = {
  toolPredicate?: (name: string) => boolean;
  useOfferSet?: boolean;
};

export type PrepareToolsResult = {
  tools: OpenAiToolDefinition[];
};

export type PrepareModelWindowInput = {
  reasoningScope?: string;
  personaLabel?: string;
  agentTemplateOverride?: string;
  roleSystemPrompt?: string;
  trailingOverlay?: string;
  skipCompact?: boolean;
  skipHardTruncate?: boolean;
  tools: OpenAiToolDefinition[];
  hostedTools?: import("../../session/types.js").JsonObject[];
  progressLabel?: string;
};

export type PrepareModelWindowOk = {
  ok: true;
  reasoningScope?: string;
  messages: OpenAiChatMessage[];
  estimatedTokens: number;
  compacted: boolean;
};

export type PrepareModelWindowResult =
  | PrepareModelWindowOk
  | { ok: false; result: TurnRunResult };

export type ModelRoundResult =
  | {
      kind: "ok";
      assistant: AssistantMessage;
      toolCalls: ToolCallPart[];
      textPart?: TextPart;
      reasoningBuf: string;
      roundBillableTokens: number;
    }
  | {
      kind: "interrupted";
      assistant: AssistantMessage;
      reasoningBuf: string;
      roundBillableTokens: number;
      sealedToolCalls: number;
    }
  | { kind: "cancelled"; result: TurnRunResult }
  | { kind: "error"; result: TurnRunResult };

export type ToolsPhaseResult =
  | {
      kind: "ok";
      cancelled: false;
      toolFailureCount: number;
      routeEvents?: import("../contracts/index.js").RouteEventPatch[];
      receipts?: import("../runTools.js").ToolCallReceipt[];
    }
  | { kind: "cancelled"; result: TurnRunResult }
  | { kind: "error"; result: TurnRunResult };

export type AwaitSubagentResult =
  | "injected"
  | "none"
  | "cancelled";

export type TurnHostCounters = {
  modelIterations: number;
  turnBillableTokens: number;
  toolFailureCount: number;
  turnModelIterations: number;
  toolErrorCount: number;
  toolRecoveryCount: number;
  skillsReadCount: number;
};

export type CreateTurnHostConfig = {
  session: Session;
  client: OpenAiCompatibleClientConfig;
  gate: PermissionGateState;
  createId: () => string;
  signal?: AbortSignal;
  interruptPort?: { fire: (() => boolean) | null };
  onEvent?: (event: StreamEvent) => void;
  checkpoint?: () => void | Promise<void>;
  desktopNotify?: (input: DesktopNotifyInput) => void;
  requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  blackboardGet?: (key: string) => unknown;
  blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  hooks?: import("../../hooks/types.js").HookRunner;
  unlimitedTurnBudgets?: boolean;
  maxModelIterations?: number;
  maxTurnTokens?: number;
  isSubagentTurn?: boolean;
  contextLimitTokens?: number;
  compactTriggerRatio?: number;
  iterationProtectRawIterationCount?: number;
  iterationProtectTokenRatio?: number;
  imageUrls?: boolean;
  toolRoleImages?: boolean;
  uploadReadImage?: (input: {
    imagePath: string;
    mimeType: string;
  }) => Promise<{ url: string; key: string } | null>;
  environmentContext?: {
    flags: import("../../settings/types.js").EnvironmentContextFlags;
    workspace: import("../environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("../environmentContext.js").EnvironmentLocaleSnapshot;
  };
  getVisionClient?: () => Promise<
    import("../../tools/types.js").VisionClientConfig | null
  >;
  getImageGenClient?: () => Promise<
    import("../../tools/types.js").ImageGenClientConfig | null
  >;
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  streamChat?: StreamChatFn;
  summarize?: SummarizeFn;
  topicBoundaryComplete?: SummarizeFn;
  sessionDb?: import("../../session/db/openDb.js").SessionDatabase;
  llmBundle?: import("../roles/types.js").RoleLlmBundle;
  toolPredicate?: (name: string) => boolean;
  additionalTools?: import("../../tools/types.js").RegisteredTool[];
  takePendingSteer?: () => PendingSteer[];
  hasPendingSteer?: () => boolean;
  takePauseRequested?: () => boolean;
  extraSystemPrompt?: string;
  resolvePersona?: () => import("./buildSystemPrefix.js").PersonaOverride;
  wireTrailingNote?: string;
  skillCatalogPrompt?: string;
  turnContext?: string;
  conversationTurnLimit?: number;
  conversationTurnStartIds?: () => ReadonlySet<string>;
  parentSessionId?: string;
  subagentId?: string;
  subagentRoleKind?: import("../subagents/types.js").SubagentRole;
  listAgentSessions?: () => Session[];
  listSessionHistory?: () => import("../../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  listWorkspaces?: () => { id: string; name: string }[];
  fsmGraphLibrary?: import("../../tools/fsmGraphAuthoring.js").FsmGraphLibraryPort;
  loops?: import("../../tools/loopsTool.js").LoopsToolPort;
  notify?: import("../../tools/notifyTool.js").NotifyToolPort;
};

export interface TurnHost {
  readonly session: Session;
  readonly gate: PermissionGateState;
  readonly createId: () => string;
  readonly signal?: AbortSignal;
  requestInterrupt(): boolean;
  readonly onEvent?: (event: StreamEvent) => void;
  readonly desktopNotify?: (input: DesktopNotifyInput) => void;
  readonly requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  readonly runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  readonly blackboardGet?: (key: string) => unknown;
  readonly blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  readonly isSubagentTurn: boolean;

  buildSkillReflectDigest(): string;

  getCounters(): TurnHostCounters;
  setCounters(next: Partial<TurnHostCounters>): void;
  resetTurnBudgets(reason: string): void;
  applySessionPatch(patch: SessionPatch): void;
  planDocExists(path: string): boolean;
  readPlanDocContent?(path: string): Promise<string | null>;
  adoptPlanDoc?(path: string, executionRequested: boolean): Promise<import("../../session/types.js").SessionPlanDoc | null>;
  deletePlanDoc(path: string): void;

  startTurn(input: TurnStartOptions): Promise<"ok" | TurnRunResult>;

  checkAbort(): boolean;
  enforceBudget(): Promise<"resume" | TurnRunResult>;
  drainPendingSteer(): Promise<boolean>;
  hasPendingSteer(): boolean;

  prepareTools(input?: PrepareToolsInput): PrepareToolsResult;

  prepareModelWindow(
    input: PrepareModelWindowInput,
  ): Promise<PrepareModelWindowResult>;

  streamModelRound(input: {
    llm: TurnStreamLlm;
    messages: OpenAiChatMessage[];
    tools: OpenAiToolDefinition[];
    builtScope?: string;
    hostedTools?: import("../../session/types.js").JsonObject[];
    progressText: string;
  }): Promise<ModelRoundResult>;

  runToolsPhase(
    assistant: AssistantMessage,
    toolCalls: ToolCallPart[],
    options?: {
      disabledTools?: string[];
      allowedTools?: string[];
      extra?: Record<string, unknown>;
    },
  ): Promise<ToolsPhaseResult>;

  appendSyntheticToolRound(input: {
    toolCalls: ToolCallPart[];
    progressText?: string;
  }): AssistantMessage;

  awaitSubagentBatches(options?: {
    waitIfIncomplete?: boolean;
  }): Promise<AwaitSubagentResult>;

  dropMessage(id: string): void;
  finalizeEmptyAssistant(input: {
    assistant: AssistantMessage;
    textPart?: TextPart;
    reasoningBuf: string;
  }): void;

  finish(
    status: SessionStatus,
    progressText: string,
    doneReason: "completed" | "cancelled" | "paused" | "error",
    iterations?: number,
  ): Promise<TurnRunResult>;

  emitProgress(text: string): void;
  emitError(message: string): void;
  touchSession(progressText?: string): void;

  dispose(): void;
}
