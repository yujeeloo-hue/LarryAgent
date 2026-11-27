import type { StreamEvent } from "../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../llm/types.js";
import {
  chatCompletionOnce,

} from "../llm/openaiCompatibleClient.js";
import type { HookRunner } from "../hooks/types.js";
import type { Session, SessionStatus } from "../session/types.js";
import type { PermissionGateState } from "../tools/types.js";
import type { AttachmentDraft, PendingSteer } from "./ipcTypes.js";

export type StreamChatFn = (
  config: OpenAiCompatibleClientConfig,
  options: StreamChatOptions,
) => AsyncGenerator<StreamEvent, void, undefined>;

export type SummarizeFn = typeof chatCompletionOnce;

export type RunAgentTurnInput = {
  session: Session;
  userText: string;
  attachments?: AttachmentDraft[];
  continuation?: "retry";
  suppressUserMessage?: boolean;
  resumeAfterUserAsk?: boolean;
  resumeToolBatch?: {
    assistantMessageId: string;
    toolCallIds: string[];
  };
  takePendingSteer?: () => PendingSteer[];
  hasPendingSteer?: () => boolean;
  takePauseRequested?: () => boolean;
  client: OpenAiCompatibleClientConfig;
  gate: PermissionGateState;
  autoSkillSummarize?: boolean;
  createId: () => string;
  signal?: AbortSignal;
  interruptPort?: { fire: (() => boolean) | null };
  maxModelIterations?: number;
  maxTurnTokens?: number;
  unlimitedTurnBudgets?: boolean;
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
  agentSystemPrompt?: string;
  environmentContext?: {
    flags: import("../settings/types.js").EnvironmentContextFlags;
    workspace: import("./environmentContext.js").EnvironmentWorkspaceSnapshot;
    locale: import("./environmentContext.js").EnvironmentLocaleSnapshot;
  };
  onEvent?: (event: StreamEvent) => void;
  checkpoint?: () => void | Promise<void>;
  desktopNotify?: (input: DesktopNotifyInput) => void;
  requestComposerRunMode?: (mode: "agent" | "ask" | "plan") => void;
  notify?: import("../tools/notifyTool.js").NotifyToolPort;
  runShell?: (input: FsmRunShellInput) => Promise<FsmRunShellResult>;
  blackboardGet?: (key: string) => unknown;
  blackboardSet?: (
    key: string,
    value: unknown,
  ) => { ok: true } | { ok: false; error: string };
  streamChat?: StreamChatFn;
  summarize?: SummarizeFn;
  topicBoundaryComplete?: SummarizeFn;
  getVisionClient?: () => Promise<
    import("../tools/types.js").VisionClientConfig | null
  >;
  getImageGenClient?: () => Promise<
    import("../tools/types.js").ImageGenClientConfig | null
  >;
  uploadImageGenInput?: (
    bytes: Uint8Array,
    mimeType: string,
    ext: string,
  ) => Promise<string>;
  hooks?: HookRunner;
  isSubagentTurn?: boolean;
  parentSessionId?: string;
  subagentId?: string;
  toolPredicate?: (name: string) => boolean;
  additionalTools?: import("../tools/types.js").RegisteredTool[];
  extraSystemPrompt?: string;
  resolvePersona?: () => import("./turnHost/buildSystemPrefix.js").PersonaOverride;
  wireTrailingNote?: string;
  skillCatalogPrompt?: string;
  knowledgeCatalogPrompt?: string;
  collaborativePrompt?: string;
  turnContext?: string;
  conversationTurnLimit?: number;
  conversationTurnStartIds?: () => ReadonlySet<string>;
  runMode?: import("./ipcTypes.js").ComposerRunMode;
  fsmGraphId?: string;
  fsmGraphConfig?: import("./fsm/types.js").FSMGraphConfig;
  llmBundle?: import("./roles/types.js").RoleLlmBundle;
  controlIntent?: "approve" | "discard";
  subagentRoleKind?: import("./subagents/types.js").SubagentRole;
  listAgentSessions?: () => import("../session/types.js").Session[];
  listSessionHistory?: () => import("../session/db/sessionHistoryRepository.js").SessionHistoryRecord[];
  fsmGraphLibrary?: import("../tools/fsmGraphAuthoring.js").FsmGraphLibraryPort;
  loops?: import("../tools/loopsTool.js").LoopsToolPort;
  listWorkspaces?: () => { id: string; name: string }[];
  sessionDb?: import("../session/db/openDb.js").SessionDatabase;
};

export type DesktopNotifyInput = {
  title: string;
  body: string;
  sessionId?: string;
  celebrate?: boolean;
};

export type RunAgentTurnResult = {
  status: SessionStatus;
  modelIterations: number;
};

export type FsmRunShellInput = {
  command?: string;
  scriptPath?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type FsmRunShellResult = {
  status: "ok" | "error";
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
  command: string;
  cwd: string;
  errorMessage?: string;
};

