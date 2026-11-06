import {
  contextBridge,
  ipcRenderer,
  webFrame,
  webUtils,
  type IpcRendererEvent,
} from "electron";
import type {
  AgentStreamPayload,
  AttachmentDraft,
  EnqueuePromptRequest,
  EnqueuePromptResponse,
  PromptQueueMutationResponse,
  QueuedPrompt,
  SessionSearchHit,
  SessionSummary,
  StartTurnRequest,
  StartTurnResponse,
  ToolApprovalDismissPayload,
  ToolApprovalRequestPayload,
  ToolApprovalResponseRequest,
  UserAskDismissPayload,
  UserAskRequestPayload,
  UserAskResponseRequest,
} from "../agent/ipcTypes.js";
import type { LogEntry, ProcessMetrics } from "../logging/types.js";
import type { Session } from "../session/types.js";
import type {
  SessionMessageWindow,
  SessionTailResult,
} from "../session/messageWindow.js";
import type { FsmGraphView } from "../main/fsmGraphView.js";
import type { AppNotifySnapshot } from "../main/appNotify.js";
import type {
  DevModeDirEntry,
  DevModeFsEvent,
  DevModeIndexChunk,
  DevModeListResult,
  DevModeSearchOptions,
  DevModeSearchResult,
  EditorFileResult,
  ProjectFileContentResult,
} from "../main/devModeFs.js";
import type {
  CppCompletionHit,
  CppCompletionRequest,
  CppSymbolHit,
  CppSymbolProgressEvent,
  CppSymbolRootMutationResult,
  CppSymbolRootsResult,
  CppUsageSearchRequest,
  CppUsageSearchResult,
} from "../main/cppSymbols/types.js";
import {
  CPP_SYMBOL_ADD_ROOT_CHANNEL,
  CPP_SYMBOL_COMPLETE_CHANNEL,
  CPP_SYMBOL_LOOKUP_CHANNEL,
  CPP_SYMBOL_PROGRESS_CHANNEL,
  CPP_SYMBOL_REMOVE_ROOT_CHANNEL,
  CPP_SYMBOL_ROOTS_CHANNEL,
  CPP_USAGE_CANCEL_CHANNEL,
  CPP_USAGE_SEARCH_CHANNEL,
} from "../main/cppSymbols/types.js";
import type {
  ClangdCompletionResult,
  ClangdDefinitionResult,
  ClangdHoverResult,
  ClangdIndexProgressEvent,
  ClangdPositionRequest,
  ClangdReferencesResult,
  ClangdSignatureHelpResult,
  ClangdStatus,
  ClangdWorkspaceSymbolsResult,
} from "../main/clangd/types.js";
import {
  CLANGD_COMPLETION_CHANNEL,
  CLANGD_CANCEL_QUERY_CHANNEL,
  CLANGD_DEFINITION_CHANNEL,
  CLANGD_DOC_CHANGED_CHANNEL,
  CLANGD_DOC_CLOSED_CHANNEL,
  CLANGD_HOVER_CHANNEL,
  CLANGD_INDEX_COMPLETE_CHANNEL,
  CLANGD_PROGRESS_CHANNEL,
  CLANGD_REFERENCES_CHANNEL,
  CLANGD_SIGNATURE_HELP_CHANNEL,
  CLANGD_STATUS_CHANNEL,
  CLANGD_WORKSPACE_SYMBOLS_CHANNEL,
  CLANGD_DOWNLOAD_CHANNEL,
  CLANGD_ENSURE_CHANNEL,
} from "../main/clangd/types.js";
import type {
  VcsAction,
  VcsFileBaseResult,
  VcsFileDiff,
  VcsStatusResult,
} from "../main/vcsStatus.js";
import type { VcsBlameResult } from "../main/vcsBlame.js";
import type {
  VcsAuthRequestPayload,
  VcsAuthResponse,
} from "../vcs/vcsAuth.js";
import type {
  FsmActionCatalogEntry,
  FsmBuiltinTemplate,
  FsmGraphLibraryEntry,
  FsmGraphLibraryRecord,
} from "../agent/fsm/graphLibrary/types.js";
import type { FSMGraphConfig } from "../agent/fsm/types.js";
import type { SubagentDetailSnapshot } from "../agent/subagents/types.js";
import type { SubagentStatusSnapshot } from "../agent/subagents/types.js";
import type { SubagentRunSummary } from "../agent/subagents/types.js";
import type { SubagentTranscript } from "../agent/subagents/types.js";
import type { LlmProvider, PromptDefaults, ResolvedWorkspaceSettings, EnvironmentContextFlags, ObjectStorageConfig, ImageGenProvider } from "../settings/types.js";
import type { ReasoningEffort } from "../llm/reasoningEffort.js";
import type { Workspace } from "../workspace/types.js";
import type {
  WorkspaceTemplateId,
  WorkspaceTemplateInfo,
} from "../workspace/templates.js";
import type {
  TemplateInitInspection,
  TemplateInitOutcome,
  WorkspaceInitProgress,
} from "../main/workspaceInit.js";
import type { ToolCatalogEntry, ToolCategory } from "../tools/catalog.js";
import type { ToolPermissionUpdate } from "../tools/catalogService.js";
import type { PermissionLevel } from "../tools/types.js";
import type { ShellSafetyOptions as ShellSafety } from "../toolsConfig/types.js";
import type {
  McpServerRuntime,
  McpServerUpsertInput,
} from "../mcp/types.js";
import type {
  SkillInstallResult,
  SkillRecord,
  SkillUpsertInput,
} from "../skills/types.js";
import type { HooksSnapshot } from "../hooks/service.js";
import type { UserMemorySnapshot } from "../memory/types.js";
import type { ProjectMemorySnapshot } from "../projectMemory/types.js";
import type { CleanupResult, StorageUsage } from "../main/storageCleanup.js";
import type {
  DevTaskConfigQueryResult,
  DevTaskOutputEvent,
  DevTaskProgressEvent,
  DevTaskRunSnapshot,
  DevTaskStateResult,
  RunDevTaskResult,
} from "../main/devTasks.js";
import type {
  DebugCommand,
  DebugEvaluateResult,
  DebugOutputEvent,
  DebugSnapshot,
  DebugStartRequest,
  DebugStartResult,
  DebugVariablesResult,
} from "../debug/debugSessionManager.js";
import type {
  SpeechHelperEvent,
  SpeechStopResult,
} from "../main/speechTranscription.js";
import type {
  CommitResult,
  PathDiffStats,
  PrepareCommitResult,
  WorkingTreeChangesResult,
  WorkingTreePathDiff,
  WorkingTreeStats,
} from "../git/types.js";
import type {
  ToolInvocationRecord,
  ToolInvocationSummaryRow,
} from "../session/db/toolInvocationRepository.js";
import type { LlmTimelineSnapshot } from "../llm/llmTimeline/recorder.js";
import type { LoopRunRecord } from "../loops/db.js";
import type { LoopView, LoopsDaemonView } from "../main/loops/service.js";
import type { Cadence } from "../loops/schedule.js";

/**
 * Preload bridge — renderer must not get Node or Electron APIs directly.
 */

export type ToolCatalogGroup = {
  category: ToolCategory;
  tools: ToolCatalogEntry[];
};

export type SettingsSnapshot = {
  settings: ResolvedWorkspaceSettings;
  /** Markdown defaults from `resources/prompts/` (for Reset in Settings). */
  promptDefaults: PromptDefaults;
  apiKeyConfiguredByProviderId: Record<string, boolean>;
  /** App version from package.json / electron-builder (`app.getVersion()`). */
  appVersion: string;
};

export type LlmHealthResult = {
  ok: boolean;
  providerId: string;
  reason?: string;
};

/** Provider setup wizard: models discovered on a gateway, or why not. */
export type LlmProbeModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: string };

export type ProviderBalanceResult = {
  providerId: string;
  text: string | null;
};

/* ---- Tray usage popup (mirrors src/llm/usage/types.ts) ---- */

export type UsageProviderKey =
  | "kimi-code"
  | "glm-code"
  | "kimi"
  | "deepseek"
  | "openrouter"
  | "qwen-code";

export type UsageBar = {
  label: string;
  percent: number;
  detail?: string;
};

export type ProviderUsageSnapshot = {
  key: UsageProviderKey;
  title: string;
  badge?: string;
  bars: UsageBar[];
  lines: string[];
  error?: string;
  fetchedAt: number;
};

export type ProviderUsageResult = {
  snapshots: ProviderUsageSnapshot[];
  activeKey: UsageProviderKey | null;
};

/** Tray usage popup footer/window actions (fire-and-forget send). */
export type UsagePopupAction =
  | { type: "close" }
  | { type: "resize"; height: number }
  | { type: "new-task" }
  | { type: "settings" }
  | { type: "quit" };

export type WorkspaceChangedPayload =
  | { type: "created"; workspace: Workspace }
  | { type: "updated"; workspace: Workspace }
  | { type: "deleted"; workspaceId: string }
  | { type: "active"; workspaceId: string | null };

/** Loop create/update payload (cadence validated on the main side). */
export type LoopInputPayload = {
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: "agent" | "plan" | "ask";
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadence: Cadence;
  enabled: boolean;
};

/** Remote relay bridge config (mirrors env.d.ts RemoteRelayConfig). */
export type RemoteMemorySyncConfig = {
  enabled: boolean;
  sessionArchive: boolean;
  projectDocs: boolean;
};
export type RemoteRelayConfig = {
  enabled: boolean;
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  mode: "readonly" | "full";
  pushActivity: "all" | "active" | "off";
  memorySync?: RemoteMemorySyncConfig;
};

export type MemorySyncStatusSnapshot = {
  lastRunAt: number | null;
  lastResult: "ok" | "error" | "off" | null;
  lastError: string | null;
  pushed: number;
  inserted: number;
  updated: number;
  cursor: number;
  pendingPush: number;
};

/**
 * Local update pipeline state (mirror of the main-side maintenance engine —
 * same shape the relay console renders for remote devices).
 */
export type UpdateMaintenanceState = {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  id?: string;
  version?: string;
  error?: string;
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  progress?: { receivedBytes: number; totalBytes?: number; bytesPerSec?: number; pct?: number };
  ts: number;
};

export type MemorySyncOutcomeSnapshot = {
  kind: "ok" | "error" | "off";
  reason?: string;
  pushed: number;
  inserted: number;
  updated: number;
  skipped: number;
  badRows: number;
  nextSince: number;
  ranAt: number;
};

export type JellyBotBridge = {
  appName: string;
  platform: NodeJS.Platform;
  getWorkspaceSettings: () => Promise<ResolvedWorkspaceSettings>;
  getSettingsSnapshot: () => Promise<SettingsSnapshot>;
  saveWorkspaceSettings: (
    settings: {
      /** Omit to leave disk providers unchanged. */
      providers?: LlmProvider[];
      activeProviderId?: string;
      visionProviderId?: string | null;
      imageGenProviders?: ImageGenProvider[];
      activeImageGenProviderId?: string;
      fullPermissionsDefault?: boolean;
      contextLimitTokens?: number;
      compactTriggerRatio?: number;
      iterationProtectRawIterationCount?: number;
      iterationProtectTokenRatio?: number;
      maxModelIterations?: number;
      maxTurnTokens?: number;
      llmRequestTimeoutMs?: number;
      environmentContext?: EnvironmentContextFlags;
      activeWorkspaceId?: string;
      userMemoryAutoExtract?: boolean;
      projectMemoryAutoExtract?: boolean;
      toolStatsEnabled?: boolean;
      /** Renderer theme id. */
      themeId?: "dark" | "light";
    },
  ) => Promise<ResolvedWorkspaceSettings>;
  getRemoteConfig: () => Promise<{ config: RemoteRelayConfig; hasKey: boolean }>;
  setRemoteConfig: (patch: Partial<RemoteRelayConfig>) => Promise<{ config: RemoteRelayConfig }>;
  regenerateRemoteDeviceId: () => Promise<{ config: RemoteRelayConfig }>;
  saveRemoteKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  getRemoteStatus: () => Promise<{ status: string }>;
  syncMemoryNow: () => Promise<{ outcome: MemorySyncOutcomeSnapshot; status: MemorySyncStatusSnapshot }>;
  fullResyncMemory: () => Promise<{ outcome: MemorySyncOutcomeSnapshot; status: MemorySyncStatusSnapshot }>;
  getMemorySyncStatus: () => Promise<{ status: MemorySyncStatusSnapshot }>;
  onRemoteStatus: (
    listener: (payload: { status: string; detail?: string }) => void,
  ) => () => void;
  onRemoteActivity: (listener: () => void) => () => void;
  /** Settings → Update card: snapshot for the initial render (main-side TTL cache). */
  getUpdateState: () => Promise<{
    currentVersion: string;
    platform: string;
    maintenance: UpdateMaintenanceState | null;
    check: {
      at: number;
      entry: { version: string; url: string; sha256?: string } | null;
      upToDate: boolean;
    } | null;
  }>;
  /** Check the release manifest (force=false reuses a fresh main-side cache). */
  checkForUpdate: (input?: { force?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    entry?: { version: string; url: string; sha256?: string } | null;
    checkedAt?: number;
    currentVersion?: string;
    upToDate?: boolean;
  }>;
  /** Queue the local in-place update (download → verify → install → relaunch). */
  runUpdate: () => Promise<{ ok: boolean; error?: string }>;
  /** Live update pipeline state pushed from main while an update runs. */
  onUpdateState: (listener: (state: UpdateMaintenanceState) => void) => () => void;
  /** Token Hub changed this device's LLM provider list. */
  onLlmProvidersChanged: (listener: () => void) => () => void;
  /** Export the full settings backup (encrypted .jbbundle) via save dialog. */
  exportSettingsBackup: (passphrase: string) => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    sections?: string[];
    error?: string;
  }>;
  /** Pick a .jbbundle and read its plaintext header summary (no passphrase). */
  importBackupSummary: () => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    version?: number;
    sections?: string[];
    exportedAt?: string;
    appVersion?: string;
    error?: string;
  }>;
  /** Decrypt + apply a .jbbundle (whole-file replace, .bak backups first). */
  applySettingsBackup: (
    path: string,
    passphrase: string,
  ) => Promise<{
    ok: boolean;
    applied?: string[];
    backups?: string[];
    warnings?: string[];
    error?: string;
  }>;
  setActiveProvider: (
    providerId: string,
  ) => Promise<ResolvedWorkspaceSettings>;
  setComposerRunMode: (
    runMode: "agent" | "ask" | "plan",
  ) => Promise<ResolvedWorkspaceSettings>;
  setComposerInfinite: (
    enabled: boolean,
  ) => Promise<ResolvedWorkspaceSettings>;
  setReasoningEffort: (
    level: ReasoningEffort,
  ) => Promise<ResolvedWorkspaceSettings>;
  setComposerVoiceMode: (
    enabled: boolean,
  ) => Promise<ResolvedWorkspaceSettings>;
  setComposerPowerCombo: (req: {
    composerInfinite: boolean;
    reasoningEffort: ReasoningEffort;
  }) => Promise<ResolvedWorkspaceSettings>;
  setApiKey: (req: {
    providerId: string;
    apiKey?: string;
    clear?: boolean;
  }) => Promise<{ apiKeyConfigured: boolean }>;
  testObjectStorage: (req?: {
    objectStorage?: ObjectStorageConfig;
  }) => Promise<
    { ok: true; message: string } | { ok: false; message: string }
  >;
  checkLlmHealth: (req?: {
    providerId?: string;
  }) => Promise<LlmHealthResult>;
  probeLlmModels: (req: {
    baseUrl: string;
    apiKey?: string;
  }) => Promise<LlmProbeModelsResult>;
  hasUsableLlmProvider: () => Promise<{ usable: boolean }>;
  getProviderBalance: (req?: {
    providerId?: string;
  }) => Promise<ProviderBalanceResult>;
  getProviderUsage: (req?: {
    force?: boolean;
  }) => Promise<ProviderUsageResult>;
  usagePopupAction: (action: UsagePopupAction) => void;
  /** Resident panel reveal/hide from main (theme + refresh on reveal). */
  onUsagePopupPresent: (
    handler: (payload: {
      theme?: string;
      accentColor?: string | null;
      visible: boolean;
    }) => void,
  ) => () => void;
  optimizeUserPrompt: (req?: {
    text?: string;
    sessionId?: string;
    providerId?: string;
  }) => Promise<{ text: string } | { error: string }>;
  listSessions: () => Promise<SessionSummary[]>;
  getSession: (sessionId: string) => Promise<Session | null>;
  /** Progressive load: session metadata + only the last N turns. */
  getSessionTail: (
    sessionId: string,
    opts?: { turns?: number },
  ) => Promise<SessionTailResult | null>;
  /** Older page ending just before the cursor message (null = stale cursor). */
  getMessagesBefore: (
    sessionId: string,
    beforeMessageId: string,
    opts?: { turns?: number },
  ) => Promise<SessionMessageWindow | null>;
  /** DevTools FSM Graph tab: serialized graph topology per workflow mode. */
  fsmGraphConfig: (
    mode: "react" | "ask" | "plan_execute" | "subagent",
  ) => Promise<FsmGraphView | null>;
  /** DevTools FSM Graph tab: view DTO for a saved custom graph. */
  fsmGraphViewById: (id: string) => Promise<FsmGraphView | null>;
  listFsmGraphs: () => Promise<FsmGraphLibraryEntry[]>;
  /** Composer graph picker: read-only built-ins (Auto V2) + enabled library graphs. */
  listComposerGraphs: () => Promise<FsmGraphLibraryEntry[]>;
  getFsmGraph: (id: string) => Promise<FsmGraphLibraryRecord | null>;
  createFsmGraph: (name: string) => Promise<FsmGraphLibraryRecord>;
  forkBuiltinFsmGraph: (
    mode: "react" | "react_v2" | "ask" | "plan_execute" | "subagent",
    name?: string,
  ) => Promise<FsmGraphLibraryRecord>;
  fsmBuiltinTemplates: () => Promise<FsmBuiltinTemplate[]>;
  saveFsmGraph: (record: FsmGraphLibraryRecord) => Promise<FsmGraphLibraryRecord>;
  deleteFsmGraph: (id: string) => Promise<void>;
  setFsmGraphEnabled: (
    id: string,
    enabled: boolean,
  ) => Promise<FsmGraphLibraryRecord | null>;
  validateFsmGraph: (config: FSMGraphConfig) => Promise<{ ok: true }>;
  fsmActionCatalog: () => Promise<FsmActionCatalogEntry[]>;
  getSubagent: (
    sessionId: string,
    subagentId: string,
  ) => Promise<SubagentDetailSnapshot | null>;
  listRunningSubagents: (
    sessionId: string,
  ) => Promise<SubagentStatusSnapshot[]>;
  /** Subagents window: every run for a session, terminal ones included. */
  listSubagents: (sessionId: string) => Promise<SubagentRunSummary[]>;
  /** Subagents window: raw Message[] transcript for one run. */
  getSubagentTranscript: (
    sessionId: string,
    subagentId: string,
  ) => Promise<SubagentTranscript | null>;
  /** Open/focus the singleton Subagents window bound to a session. */
  openSubagentsWindow: (sessionId: string) => Promise<{ ok: true }>;
  /** Session follow broadcast for the Subagents window. */
  onSubagentsWindowSession: (
    handler: (payload: { sessionId: string }) => void,
  ) => () => void;
  searchSessions: (query: string) => Promise<SessionSearchHit[]>;
  startTurn: (req: StartTurnRequest) => Promise<StartTurnResponse>;
  setSessionProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<Session>;
  /** Pin per-session composer prefs (null = un-pin, follow global default). */
  setComposerPrefs: (
    sessionId: string,
    patch: {
      runMode?: "agent" | "ask" | "plan" | "custom" | null;
      fsmGraphId?: string | null;
      infinite?: boolean | null;
      reasoningEffort?: ReasoningEffort | null;
      handoffEnabled?: boolean | null;
    },
  ) => Promise<Session>;
  /** Queue a prompt (default: starts a new turn after the current one ends). */
  enqueuePrompt: (req: EnqueuePromptRequest) => Promise<EnqueuePromptResponse>;
  listPromptQueue: (sessionId: string) => Promise<QueuedPrompt[]>;
  removeQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => Promise<PromptQueueMutationResponse>;
  updateQueuedPromptText: (
    sessionId: string,
    promptId: string,
    text: string,
  ) => Promise<PromptQueueMutationResponse>;
  /** Consume a persisted turn error row (Retry click) before resending. */
  removeTurnError: (
    sessionId: string,
    messageId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** Insert now: arm for the next round boundary, or send when idle. */
  promoteQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => Promise<PromptQueueMutationResponse>;
  deferQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => Promise<PromptQueueMutationResponse>;
  moveQueuedPromptToFront: (
    sessionId: string,
    promptId: string,
  ) => Promise<PromptQueueMutationResponse>;
  cancelTurn: (sessionId: string) => Promise<boolean>;
  /**
   * Take-once STOP-rollback prompt: the cancelled-before-content turn's
   * prompt, handed back for the composer. Null when nothing is latched.
   */
  takePromptRestore: (
    sessionId: string,
  ) => Promise<{ text: string; attachments: AttachmentDraft[] } | null>;
  /** /pause: queue graceful pause; { ok, reason } outcome. */
  pauseTurn: (sessionId: string) => Promise<{ ok: boolean; reason?: string }>;
  /** /resume: continue a paused session with a system-note turn. */
  resumeTurn: (req: {
    sessionId: string;
    fullPermissions: boolean;
    autoSkillSummarize?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** /compact: force one compaction pass on a quiescent session. */
  compactSession: (
    sessionId: string,
    /** One-off `/compact <keep>` override of the protect token ratio. */
    options?: { protectTokenRatio?: number },
  ) => Promise<{
    ok: boolean;
    reason?: string;
    compacted?: boolean;
    estimatedTokens?: number;
  }>;
  /** /clear: soft-clear a quiescent session (marker + fresh window). */
  clearSession: (
    sessionId: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
  /** /end: fold the whole conversation into one digest (idle sessions). */
  endSession: (
    sessionId: string,
  ) => Promise<{
    ok: boolean;
    reason?: string;
    compacted?: boolean;
    estimatedTokens?: number;
  }>;
  abortToolCall: (req: {
    sessionId: string;
    toolCallId: string;
  }) => Promise<{ stopped: boolean }>;
  deleteSession: (sessionId: string) => Promise<boolean>;
  setSessionArchived: (req: {
    sessionId: string;
    archived: boolean;
  }) => Promise<SessionSummary>;
  respondToolApproval: (req: ToolApprovalResponseRequest) => Promise<boolean>;
  respondUserAsk: (req: UserAskResponseRequest) => Promise<boolean>;
  respondVcsAuth: (req: VcsAuthResponse) => Promise<boolean>;
  approvePlan: (
    sessionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  discardPlan: (
    sessionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  listPendingToolApprovals: (
    sessionId: string,
  ) => Promise<ToolApprovalRequestPayload[]>;
  listPendingUserAsks: (sessionId: string) => Promise<UserAskRequestPayload[]>;
  listWorkspaces: () => Promise<Workspace[]>;
  listArchivedWorkspaces: () => Promise<Workspace[]>;
  setWorkspaceArchived: (req: {
    workspaceId: string;
    archived: boolean;
  }) => Promise<Workspace>;
  createWorkspace: (req: {
    name: string;
    path: string;
  }) => Promise<Workspace>;
  /** New-workspace template flow (menu → scaffold → progress → register). */
  listWorkspaceTemplates: () => Promise<WorkspaceTemplateInfo[]>;
  inspectWorkspaceInit: (req: {
    path: string;
    templateId: WorkspaceTemplateId;
  }) => Promise<TemplateInitInspection>;
  createWorkspaceFromTemplate: (req: {
    templateId: WorkspaceTemplateId;
    name: string;
    path: string;
  }) => Promise<TemplateInitOutcome>;
  cancelWorkspaceInit: (runId: string) => Promise<boolean>;
  onWorkspaceInitProgress: (
    handler: (progress: WorkspaceInitProgress) => void,
  ) => () => void;
  updateWorkspace: (req: {
    id: string;
    name?: string;
    path?: string;
  }) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  getActiveWorkspaceId: () => Promise<string | null>;
  setActiveWorkspaceId: (workspaceId: string) => Promise<string>;
  pickWorkspaceFolder: () => Promise<string | null>;
  confirmDialog: (req: {
    message: string;
    detail?: string;
    title?: string;
  }) => Promise<boolean>;
  alertDialog: (req: {
    message: string;
    title?: string;
    type?: "info" | "warning" | "error";
  }) => Promise<void>;
  pickAttachmentFiles: (
    mode?: "images" | "files",
  ) => Promise<AttachmentDraft[]>;
  /** Drag-and-drop support: validate dropped absolute paths into drafts. */
  resolveAttachmentPaths: (paths: string[]) => Promise<AttachmentDraft[]>;
  /** Electron-safe replacement for the removed File.path (drag-and-drop). */
  attachmentPathForFile: (file: File) => string;
  listTools: () => Promise<ToolCatalogGroup[]>;
  getShellSafety: () => Promise<ShellSafety>;
  setShellSafety: (req?: {
    enabled?: boolean;
    fatalPolicy?: "ask" | "block";
  }) => Promise<ShellSafety>;
  setToolPermissionLevel: (req: {
    name: string;
    level: PermissionLevel;
  }) => Promise<ToolPermissionUpdate>;
  setToolOffer: (req: {
    name: string;
    include: boolean;
  }) => Promise<ToolPermissionUpdate>;
  setToolDisplay: (req: {
    name: string;
    visible: boolean;
  }) => Promise<ToolPermissionUpdate>;
  getHiddenToolCards: () => Promise<string[]>;
  autoOrganizeToolOffers: () => Promise<{
    baseline: string[];
    offered: string[];
  }>;
  listMcpServers: () => Promise<McpServerRuntime[]>;
  upsertMcpServer: (input: McpServerUpsertInput) => Promise<McpServerRuntime>;
  removeMcpServer: (serverId: string) => Promise<boolean>;
  setMcpServerEnabled: (req: {
    id: string;
    enabled: boolean;
  }) => Promise<McpServerRuntime>;
  reconnectMcpServer: (serverId: string) => Promise<McpServerRuntime>;
  reloadMcpServers: () => Promise<McpServerRuntime[]>;
  listSkills: () => Promise<SkillRecord[]>;
  upsertSkill: (input: SkillUpsertInput) => Promise<SkillRecord>;
  removeSkill: (skillId: string) => Promise<boolean>;
  setSkillEnabled: (req: {
    id: string;
    enabled: boolean;
  }) => Promise<SkillRecord>;
  installSkillZip: () => Promise<SkillInstallResult | null>;
  listHooks: () => Promise<HooksSnapshot>;
  reloadHooks: () => Promise<HooksSnapshot>;
  getUserMemory: () => Promise<UserMemorySnapshot>;
  saveUserMemory: (req: { profile: string }) => Promise<UserMemorySnapshot>;
  clearUserMemory: () => Promise<UserMemorySnapshot>;
  getProjectMemory: (req?: {
    workspacePath?: string;
    workspaceId?: string;
  }) => Promise<ProjectMemorySnapshot>;
  saveProjectMemory: (req: {
    body: string;
    workspacePath?: string;
    workspaceId?: string;
  }) => Promise<ProjectMemorySnapshot>;
  clearProjectMemory: (req?: {
    workspacePath?: string;
    workspaceId?: string;
  }) => Promise<ProjectMemorySnapshot>;
  getWorkingTreeStats: (workspacePath: string) => Promise<WorkingTreeStats>;
  getPathsDiffStats: (paths: string[]) => Promise<PathDiffStats[]>;
  listWorkingTreeChanges: (
    workspacePath: string,
  ) => Promise<WorkingTreeChangesResult>;
  getWorkingTreePathDiff: (
    workspacePath: string,
    relativePath: string,
  ) => Promise<WorkingTreePathDiff>;
  openWorkspaceChangesWindow: (workspacePath: string) => Promise<{ ok: true }>;
  closeWorkspaceChangesWindow: () => Promise<{ ok: true }>;
  openFileReader: (path: string) => Promise<{ ok: true }>;
  onFileReaderDocument: (
    handler: (payload: { path: string }) => void,
  ) => () => void;
  onWorkspaceChangesPath: (
    handler: (payload: { workspacePath: string }) => void,
  ) => () => void;
  /** `paths` (workspace-relative) scopes the draft to those files only. */
  prepareCommit: (
    workspacePath: string,
    providerId?: string,
    paths?: string[],
  ) => Promise<PrepareCommitResult>;
  commitWorkspace: (req: {
    workspacePath: string;
    message: string;
    /** Workspace-relative pathspec; omit to commit the whole working tree. */
    paths?: string[];
  }) => Promise<CommitResult>;
  openPath: (path: string) => Promise<string>;
  /** Open http(s) URL in the system browser. */
  openExternal: (url: string) => Promise<boolean>;
  showItemInFolder: (path: string) => Promise<boolean>;
  /** Copy a file to a user-chosen location via the Save As dialog. */
  saveFileAs: (
    path: string,
  ) => Promise<
    { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
  >;
  downloadResponseFile: (request: {
    sessionId: string; messageId: string; fileId: string; containerId?: string; filename?: string;
  }) => Promise<{ ok: boolean; cancelled?: boolean; path?: string; error?: string }>;
  trashItem: (
    path: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  cocoHistory: (ruleId: string, cursor?: { at: number; id: string }) => Promise<import("../coco/types.js").CocoHistoryPage>;
  cocoSnapshot: () => Promise<import("../coco/types.js").CocoSnapshot>;
  cocoWorkResults: (workId: string) => Promise<import("../coco/types.js").CocoWorkResult[]>;
  cocoActivity: () => Promise<import("../coco/activity.js").CocoActivity>;
  /** Pushed only when the shell icon state changes. */
  onCocoActivity: (handler: (activity: import("../coco/activity.js").CocoActivity) => void) => () => void;
  /** Coalesced "snapshot is stale" signal from the CoCo engine. */
  onCocoChanged: (handler: () => void) => () => void;
  cocoCommand: (command: import("../coco/types.js").CocoCommand) => Promise<import("../coco/types.js").CocoSnapshot>;
  cocoHandoverSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  cocoTakeBackSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  loopsList: () => Promise<LoopView[]>;
  loopsListRuns: (
    loopId: string,
    limit?: number,
  ) => Promise<LoopRunRecord[]>;
  loopsCreate: (loop: LoopInputPayload) => Promise<LoopView>;
  loopsUpdate: (
    loopId: string,
    loop: LoopInputPayload,
  ) => Promise<LoopView>;
  loopsDelete: (loopId: string) => Promise<boolean>;
  loopsSetEnabled: (
    loopId: string,
    enabled: boolean,
  ) => Promise<LoopView>;
  loopsDaemonStatus: () => Promise<LoopsDaemonView>;
  loopsInstallDaemon: () => Promise<LoopsDaemonView>;
  loopsEnsureDaemon: () => Promise<LoopsDaemonView>;
  loopsRepairDaemon: () => Promise<LoopsDaemonView>;
  loopsStopDaemon: () => Promise<LoopsDaemonView>;
  loopsUninstallDaemon: () => Promise<{
    ok: boolean;
    message?: string;
  }>;
  readTextFile: (
    path: string,
  ) => Promise<{ ok: true; content: string } | { ok: false; message: string }>;
  /** Keep only the paths that exist and are regular files. */
  filterExistingFiles: (paths: string[]) => Promise<string[]>;
  // Dev Mode (plan: dev-mode-v1)
  listDevModeDir: (path: string) => Promise<DevModeListResult>;
  runDevModeExecutable: (
    path: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readDevModeProjectFile: (
    path: string,
  ) => Promise<ProjectFileContentResult>;
  /** Unreal engine source root for a workspace, or null when there is none. */
  getDevModeEngineRoot: (rootPath: string) => Promise<string | null>;
  /** Map a DAP/build-machine source path to a local project or Engine file. */
  resolveDevModeSourcePath: (
    rootPath: string,
    sourcePath: string,
  ) => Promise<string | null>;
  searchDevModeFiles: (
    rootPath: string,
    query: string,
    options?: DevModeSearchOptions,
  ) => Promise<DevModeSearchResult>;
  /**
   * Start a streaming file-index walk; batches arrive on
   * `onDevModeIndexChunk` and the final message carries `done`. One walk per
   * window — starting another supersedes it.
   */
  startDevModeFileIndex: (
    rootPath: string,
    requestId: number,
    options?: DevModeSearchOptions,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Supersede this window's in-flight index walk. */
  cancelDevModeFileIndex: () => Promise<void>;
  onDevModeIndexChunk: (
    listener: (payload: DevModeIndexChunk) => void,
  ) => () => void;
  /** VCS badge status (git/svn status only — no diff, no content reads). */
  getVcsStatus: (rootPath: string) => Promise<VcsStatusResult>;
  /** Per-file line marks (gutter) — clean files skip the diff spawn. */
  getVcsFileDiff: (
    rootPath: string,
    absPath: string,
  ) => Promise<
    { ok: true; diff: VcsFileDiff } | { ok: false; message: string }
  >;
  /** HEAD (git) / BASE (svn) content for the Dev Mode diff editor. */
  getVcsFileBase: (
    rootPath: string,
    absPath: string,
  ) => Promise<VcsFileBaseResult>;
  /** Annotate (blame) a versioned file for the Dev Mode editor gutter. */
  annotateFile: (
    rootPath: string,
    absPath: string,
  ) => Promise<VcsBlameResult>;
  /** Stage/unstage/discard/revert/update — argv passed, shell never involved. */
  runVcsAction: (
    rootPath: string,
    action: VcsAction,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Reveal a path in Finder / Explorer. */
  revealPath: (path: string) => Promise<{ ok: boolean }>;
  /** Dev Mode tasks (.larry/tasks.json) — Build/Run icon buttons. */
  getDevTaskConfig: (
    workspacePath: string,
  ) => Promise<DevTaskConfigQueryResult>;
  runDevTask: (
    workspacePath: string,
    task: string,
  ) => Promise<RunDevTaskResult>;
  stopDevTask: (runId: string) => Promise<{ ok: boolean }>;
  getDevTaskState: (workspacePath: string) => Promise<DevTaskStateResult>;
  startDebug: (request: DebugStartRequest) => Promise<DebugStartResult>;
  setDebugBreakpoints: (
    path: string,
    breakpoints: Array<{ line: number; condition?: string }>,
  ) => Promise<{ ok: boolean; message?: string }>;
  runDebugCommand: (
    command: DebugCommand,
  ) => Promise<{ ok: boolean; message?: string }>;
  selectDebugThread: (
    threadId: number,
  ) => Promise<{ ok: boolean; message?: string }>;
  selectDebugTarget: (
    targetId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Open one call-stack frame: locals follow the picked frame. */
  selectDebugFrame: (
    frameId: number,
  ) => Promise<{
    ok: boolean;
    message?: string;
    frame?: DebugSnapshot["stack"][number];
  }>;
  evaluateDebugExpression: (
    expression: string,
    frameId: number,
  ) => Promise<DebugEvaluateResult>;
  getDebugVariables: (
    variablesReference: number,
  ) => Promise<DebugVariablesResult>;
  getDebugState: () => Promise<DebugSnapshot>;
  onDebugState: (listener: (snapshot: DebugSnapshot) => void) => () => void;
  onDebugOutput: (listener: (payload: DebugOutputEvent) => void) => () => void;
  onDevTaskOutput: (
    listener: (payload: DevTaskOutputEvent) => void,
  ) => () => void;
  /** UBT build progress frames (throttled ~4Hz; phase changes flush). */
  onDevTaskProgress: (
    listener: (payload: DevTaskProgressEvent) => void,
  ) => () => void;
  /** Run reached a terminal state (snapshot carries the replay buffer). */
  onDevTaskExit: (
    listener: (payload: DevTaskRunSnapshot) => void,
  ) => () => void;
  /** `git push` for the Dev Mode Push button. */
  pushWorkspace: (
    workspacePath: string,
  ) => Promise<{ ok: boolean; message?: string; output?: string }>;
  watchDevModePath: (
    rootPath: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  unwatchDevModePath: (rootPath: string) => Promise<{ ok: true }>;
  /** Definitions for one identifier from the workspace C++ symbol database. */
  lookupCppSymbols: (
    rootPath: string,
    word: string,
  ) => Promise<CppSymbolHit[]>;
  /** Text-index completion (own class → bases → globals). */
  completeCppSymbols: (
    rootPath: string,
    request: CppCompletionRequest,
  ) => Promise<CppCompletionHit[]>;
  findCppUsages: (
    rootPath: string,
    request: CppUsageSearchRequest,
  ) => Promise<CppUsageSearchResult>;
  cancelCppUsageSearch: (queryId: string) => Promise<{ ok: true }>;
  /** clangd semantic engine (Unreal workspaces with compile_commands.json). */
  clangdStatus: (rootPath: string) => Promise<ClangdStatus>;
  /** Spawn clangd + start the background index early (fire-and-forget). */
  clangdWarmup: (rootPath: string) => Promise<ClangdStatus>;
  /** Download the standalone clangd zip into the JellyBot tools dir. */
  clangdDownload: () => Promise<{ ok: true; path: string } | { ok: false; message: string }>;
  clangdReferences: (
    rootPath: string,
    request: ClangdPositionRequest,
  ) => Promise<ClangdReferencesResult>;
  clangdDefinition: (
    rootPath: string,
    request: ClangdPositionRequest,
    queryId?: string,
  ) => Promise<ClangdDefinitionResult>;
  /** Abort an in-flight definition query (ESC) by its query id. */
  clangdCancelQuery: (queryId: string) => Promise<boolean>;
  /** Whole-index symbol lookup — feeds Quick Open semantic symbol rows. */
  clangdWorkspaceSymbols: (
    rootPath: string,
    query: string,
  ) => Promise<ClangdWorkspaceSymbolsResult>;
  clangdHover: (
    rootPath: string,
    request: ClangdPositionRequest,
  ) => Promise<ClangdHoverResult>;
  /** `queryId` lets `clangdCancelQuery` drop a superseded request. */
  clangdCompletion: (
    rootPath: string,
    request: ClangdPositionRequest,
    queryId?: string,
  ) => Promise<ClangdCompletionResult>;
  /** Members from clangd's persistent index (works while the preamble builds). */
  clangdIndexComplete: (
    rootPath: string,
    request: CppCompletionRequest,
  ) => Promise<CppCompletionHit[]>;
  clangdSignatureHelp: (
    rootPath: string,
    request: ClangdPositionRequest,
  ) => Promise<ClangdSignatureHelpResult>;
  /** Sync one live editor buffer into the clangd session (didChange). */
  clangdDocChanged: (
    rootPath: string,
    path: string,
    text: string,
  ) => Promise<{ ok: true }>;
  clangdDocClosed: (rootPath: string, path: string) => Promise<{ ok: true }>;
  /** User-added C++ symbol-index scan roots for one workspace. */
  getCppSymbolExtraRoots: (rootPath: string) => Promise<CppSymbolRootsResult>;
  /** Add a directory (e.g. engine sources) to the symbol-index scan. */
  addCppSymbolExtraRoot: (
    rootPath: string,
    dirPath: string,
  ) => Promise<CppSymbolRootMutationResult>;
  /** Remove the scan root covering a directory; symbols prune on rescan. */
  removeCppSymbolExtraRoot: (
    rootPath: string,
    dirPath: string,
  ) => Promise<CppSymbolRootMutationResult>;
  /** Background scan progress. Returns an unsubscribe function. */
  onCppSymbolProgress: (
    listener: (payload: CppSymbolProgressEvent) => void,
  ) => () => void;
  /** clangd background-index progress. Returns an unsubscribe function. */
  onClangdProgress: (
    listener: (payload: ClangdIndexProgressEvent) => void,
  ) => () => void;
  readFileForEditor: (path: string) => Promise<EditorFileResult>;
  writeTextFile: (
    path: string,
    content: string,
    addBom: boolean,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onDevModeFsEvent: (
    listener: (payload: DevModeFsEvent) => void,
  ) => () => void;
  /** Main detected VCS metadata activity (commit / branch switch / svn up). */
  onVcsChanged: (
    listener: (payload: { rootPath: string }) => void,
  ) => () => void;
  /** Another window saved appearance settings — follow live (theme/accent/scales). */
  onAppearanceChanged: (
    listener: (payload: {
      themeId: string;
      accentColor: string | null;
      uiFontScale?: number;
      chatFontScale?: number;
    }) => void,
  ) => () => void;
  /** Whole-window UI text zoom (Settings → Appearance → Interface text). */
  setUiZoomFactor: (factor: number) => void;
  getProcessMetrics: () => Promise<ProcessMetrics>;
  getRecentLogs: () => Promise<LogEntry[]>;
  getToolStatsSummary: (req?: {
    sessionId?: string;
  }) => Promise<ToolInvocationSummaryRow[]>;
  listToolStatsFailures: (req?: {
    name?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
  }) => Promise<ToolInvocationRecord[]>;
  listToolStatsInvocations: (req?: {
    name?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
  }) => Promise<ToolInvocationRecord[]>;
  getToolStatsInvocation: (id: string) => Promise<ToolInvocationRecord | null>;
  getToolStatsEnabled: () => Promise<boolean>;
  resetToolStats: () => Promise<number>;
  llmTimelineList: (sessionId: string) => Promise<LlmTimelineSnapshot>;
  onLlmTimelineUpdated: (
    handler: (payload: { sessionId: string }) => void,
  ) => () => void;
  onNotificationCenterEvent: (
    handler: (payload: { eventName: string; params: unknown }) => void,
  ) => () => void;
  getFullRequestLog: () => Promise<boolean>;
  setFullRequestLog: (enabled: boolean) => Promise<boolean>;
  openLogsFolder: () => Promise<{
    ok: boolean;
    path?: string;
    error?: string;
  }>;
  saveLogsToFile: (
    content: string,
  ) => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    error?: string;
  }>;
  /** Scan cleanable storage (logs older than retention, sqlite backups, caches, temp). */
  getStorageUsage: () => Promise<StorageUsage>;
  /** Delete cleanable storage; returns what was freed. */
  cleanupStorage: () => Promise<CleanupResult>;
  terminalRun: (req: {
    command: string;
    cwd: string;
  }) => Promise<{ runId: string }>;
  terminalCancel: (runId: string) => Promise<{ ok: boolean }>;
  onTerminalOutput: (
    handler: (payload: {
      runId: string;
      stream: "stdout" | "stderr";
      text: string;
    }) => void,
  ) => () => void;
  onTerminalDone: (
    handler: (payload: {
      runId: string;
      exitCode: number;
      signal?: string;
      cwd?: string;
    }) => void,
  ) => () => void;
  /** Windows self-drawn caption buttons (min/max/close); macOS uses only `close` (Dev Mode chord fallback). */
  windowControls: {
    minimize: () => Promise<{ ok: boolean }>;
    toggleMaximize: () => Promise<{ ok: boolean; maximized: boolean }>;
    close: () => Promise<{ ok: boolean }>;
  };
  /** Maximize state push so the Max button can swap its glyph. */
  onWindowMaximizeChanged: (
    handler: (payload: { maximized: boolean }) => void,
  ) => () => void;
  /** Parked ⌘W / Ctrl+F4 — consume as a file-tab close, or close the window. */
  onWindowCloseRequest: (handler: () => void) => () => void;
  /** Parked F12 — Go to Definition in the Dev Mode editor. */
  onEditorGoToDefinition: (handler: () => void) => () => void;
  /** Parked Shift+F12 — Find Usages in the Dev Mode editor. */
  onEditorFindUsages: (handler: () => void) => () => void;
  /** Push-to-talk transcription (macOS speech helper). */
  speechStart: () => Promise<void>;
  speechStop: () => Promise<SpeechStopResult>;
  onSpeechEvent: (
    handler: (event: SpeechHelperEvent) => void,
  ) => () => void;
  onDiagnosticLog: (handler: (entry: LogEntry) => void) => () => void;
  onAgentStream: (
    handler: (payload: AgentStreamPayload) => void,
  ) => () => void;
  onSessionUpdated: (handler: (summary: SessionSummary) => void) => () => void;
  onSessionDeleted: (handler: (payload: { id: string }) => void) => () => void;
  onWorkspaceChanged: (
    handler: (payload: WorkspaceChangedPayload) => void,
  ) => () => void;
  onToolApproval: (
    handler: (payload: ToolApprovalRequestPayload) => void,
  ) => () => void;
  /** VCS credential prompt (annotate/push auth failure → ask + retry). */
  onVcsAuthRequest: (
    handler: (payload: VcsAuthRequestPayload) => void,
  ) => () => void;
  onToolApprovalDismiss: (
    handler: (payload: ToolApprovalDismissPayload) => void,
  ) => () => void;
  onUserAsk: (handler: (payload: UserAskRequestPayload) => void) => () => void;
  onUserAskDismiss: (
    handler: (payload: UserAskDismissPayload) => void,
  ) => () => void;
  /** Celebration confetti trigger (task-done effect / Shift+F12 test hook). */
  onCelebration: (
    handler: (payload: { source: "task" | "f12" }) => void,
  ) => () => void;
  /** Menu bar brand menu (macOS): quick action after the app focused. */
  onMenubarAction: (
    handler: (payload: {
      action: "new-task" | "loop" | "settings";
    }) => void,
  ) => () => void;
  /** Notification ledger snapshot (bell inbox + in-app toast trigger). */
  onAppNotify: (
    handler: (snapshot: AppNotifySnapshot) => void,
  ) => () => void;
  getNotifyLedger: () => Promise<AppNotifySnapshot>;
  markNotifyRead: (req: {
    id?: number;
    all?: boolean;
  }) => Promise<AppNotifySnapshot>;
  /** Clear every ledger entry (inbox "Clear all" chip). */
  clearNotifyLedger: () => Promise<AppNotifySnapshot>;
  /** Background popup card actions (activate = click, dismiss = X). */
  notifyPopupAction: (
    id: number,
    action: "activate" | "dismiss",
  ) => Promise<void>;
  /** Notification click → open its session (main → renderer). */
  onNotifyActivate: (
    handler: (payload: { sessionId?: string }) => void,
  ) => () => void;
};

const bridge: JellyBotBridge = {
  appName: "Larry Agent",
  platform: process.platform,
  getWorkspaceSettings: () =>
    ipcRenderer.invoke(
      "settings:getWorkspace",
    ) as Promise<ResolvedWorkspaceSettings>,
  getSettingsSnapshot: () =>
    ipcRenderer.invoke("settings:getSnapshot") as Promise<SettingsSnapshot>,
  saveWorkspaceSettings: (settings) =>
    ipcRenderer.invoke(
      "settings:saveWorkspace",
      settings,
    ) as Promise<ResolvedWorkspaceSettings>,
  getRemoteConfig: () =>
    ipcRenderer.invoke("remote:getConfig") as Promise<{
      config: RemoteRelayConfig;
      hasKey: boolean;
    }>,
  setRemoteConfig: (patch: Partial<RemoteRelayConfig>) =>
    ipcRenderer.invoke("remote:setConfig", patch) as Promise<{
      config: RemoteRelayConfig;
    }>,
  regenerateRemoteDeviceId: () =>
    ipcRenderer.invoke("remote:regenerateDeviceId") as Promise<{
      config: RemoteRelayConfig;
    }>,
  saveRemoteKey: (key: string) =>
    ipcRenderer.invoke("remote:saveKey", key) as Promise<{
      ok: boolean;
      error?: string;
    }>,
  getRemoteStatus: () =>
    ipcRenderer.invoke("remote:getStatus") as Promise<{
      status: string;
    }>,
  syncMemoryNow: () =>
    ipcRenderer.invoke("memorySync:syncNow") as Promise<{
      outcome: MemorySyncOutcomeSnapshot;
      status: MemorySyncStatusSnapshot;
    }>,
  fullResyncMemory: () =>
    ipcRenderer.invoke("memorySync:fullResync") as Promise<{
      outcome: MemorySyncOutcomeSnapshot;
      status: MemorySyncStatusSnapshot;
    }>,
  getMemorySyncStatus: () =>
    ipcRenderer.invoke("memorySync:getStatus") as Promise<{
      status: MemorySyncStatusSnapshot;
    }>,
  onRemoteStatus: (listener: (payload: { status: string; detail?: string }) => void) => {
    const wrapped = (_event: unknown, payload: { status: string; detail?: string }) => listener(payload);
    ipcRenderer.on("remote:status", wrapped as never);
    return () => ipcRenderer.removeListener("remote:status", wrapped as never);
  },
  onRemoteActivity: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("remote:activity", wrapped as never);
    return () => ipcRenderer.removeListener("remote:activity", wrapped as never);
  },
  getUpdateState: () =>
    ipcRenderer.invoke("update:getState") as ReturnType<JellyBotBridge["getUpdateState"]>,
  checkForUpdate: (input?: { force?: boolean }) =>
    ipcRenderer.invoke("update:check", input) as ReturnType<JellyBotBridge["checkForUpdate"]>,
  runUpdate: () =>
    ipcRenderer.invoke("update:run") as ReturnType<JellyBotBridge["runUpdate"]>,
  onUpdateState: (listener: (state: never) => void) => {
    const wrapped = (_event: unknown, state: never) => listener(state);
    ipcRenderer.on("update:state", wrapped as never);
    return () => ipcRenderer.removeListener("update:state", wrapped as never);
  },
  onLlmProvidersChanged: (listener: () => void) => {
    const wrapped = () => listener();
    ipcRenderer.on("llm:providersChanged", wrapped as never);
    return () => ipcRenderer.removeListener("llm:providersChanged", wrapped as never);
  },
  exportSettingsBackup: (passphrase) =>
    ipcRenderer.invoke("settings:exportBackup", {
      passphrase,
    }) as ReturnType<JellyBotBridge["exportSettingsBackup"]>,
  importBackupSummary: () =>
    ipcRenderer.invoke(
      "settings:importBackupSummary",
    ) as ReturnType<JellyBotBridge["importBackupSummary"]>,
  applySettingsBackup: (path, passphrase) =>
    ipcRenderer.invoke("settings:applyBackup", {
      path,
      passphrase,
    }) as ReturnType<JellyBotBridge["applySettingsBackup"]>,
  setActiveProvider: (providerId) =>
    ipcRenderer.invoke(
      "settings:setActiveProvider",
      providerId,
    ) as Promise<ResolvedWorkspaceSettings>,
  setComposerRunMode: (runMode) =>
    ipcRenderer.invoke(
      "settings:setComposerRunMode",
      runMode,
    ) as Promise<ResolvedWorkspaceSettings>,
  setComposerInfinite: (enabled) =>
    ipcRenderer.invoke(
      "settings:setComposerInfinite",
      enabled,
    ) as Promise<ResolvedWorkspaceSettings>,
  setReasoningEffort: (level) =>
    ipcRenderer.invoke(
      "settings:setReasoningEffort",
      level,
    ) as Promise<ResolvedWorkspaceSettings>,
  setComposerVoiceMode: (enabled) =>
    ipcRenderer.invoke(
      "settings:setComposerVoiceMode",
      enabled,
    ) as Promise<ResolvedWorkspaceSettings>,
  setComposerPowerCombo: (req) =>
    ipcRenderer.invoke(
      "settings:setComposerPowerCombo",
      req,
    ) as Promise<ResolvedWorkspaceSettings>,
  setApiKey: (req) =>
    ipcRenderer.invoke("settings:setApiKey", req) as Promise<{
      apiKeyConfigured: boolean;
    }>,
  testObjectStorage: (req?: {
    objectStorage?: ObjectStorageConfig;
  }) =>
    ipcRenderer.invoke("settings:testObjectStorage", req) as Promise<
      { ok: true; message: string } | { ok: false; message: string }
    >,
  checkLlmHealth: (req) =>
    ipcRenderer.invoke("llm:checkHealth", req ?? {}) as Promise<LlmHealthResult>,
  probeLlmModels: (req) =>
    ipcRenderer.invoke(
      "llm:probeModels",
      req,
    ) as Promise<LlmProbeModelsResult>,
  hasUsableLlmProvider: () =>
    ipcRenderer.invoke("llm:hasUsableProvider") as Promise<{
      usable: boolean;
    }>,
  getProviderBalance: (req) =>
    ipcRenderer.invoke("llm:getProviderBalance", req ?? {}) as Promise<ProviderBalanceResult>,
  getProviderUsage: (req) =>
    ipcRenderer.invoke("llm:getProviderUsage", req ?? {}) as Promise<ProviderUsageResult>,
  usagePopupAction: (action) => {
    ipcRenderer.send("usagePopup:action", action);
  },
  onUsagePopupPresent: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: {
        theme?: string;
        accentColor?: string | null;
        visible: boolean;
      },
    ) => handler(payload);
    ipcRenderer.on("usagePopup:present", listener);
    return () => ipcRenderer.removeListener("usagePopup:present", listener);
  },
  optimizeUserPrompt: (req) =>
    ipcRenderer.invoke("llm:optimizePrompt", req ?? {}) as Promise<
      { text: string } | { error: string }
    >,
  listSessions: () =>
    ipcRenderer.invoke("agent:listSessions") as Promise<SessionSummary[]>,
  getSession: (sessionId) =>
    ipcRenderer.invoke("agent:getSession", sessionId) as Promise<Session | null>,
  getSessionTail: (sessionId, opts) =>
    ipcRenderer.invoke("agent:getSessionTail", sessionId, opts) as Promise<
      SessionTailResult | null
    >,
  getMessagesBefore: (sessionId, beforeMessageId, opts) =>
    ipcRenderer.invoke(
      "agent:getMessagesBefore",
      sessionId,
      beforeMessageId,
      opts,
    ) as Promise<SessionMessageWindow | null>,
  fsmGraphConfig: (mode) =>
    ipcRenderer.invoke("fsm:graphConfig", mode) as Promise<
      FsmGraphView | null
    >,
  fsmGraphViewById: (id) =>
    ipcRenderer.invoke("fsm:graphViewById", id) as Promise<FsmGraphView | null>,
  listFsmGraphs: () =>
    ipcRenderer.invoke("fsm:listGraphs") as Promise<FsmGraphLibraryEntry[]>,
  listComposerGraphs: () =>
    ipcRenderer.invoke("fsm:listComposerGraphs") as Promise<FsmGraphLibraryEntry[]>,
  getFsmGraph: (id) =>
    ipcRenderer.invoke("fsm:getGraph", id) as Promise<FsmGraphLibraryRecord | null>,
  createFsmGraph: (name) =>
    ipcRenderer.invoke("fsm:createGraph", name) as Promise<FsmGraphLibraryRecord>,
  forkBuiltinFsmGraph: (mode, name) =>
    ipcRenderer.invoke("fsm:forkBuiltinGraph", mode, name) as Promise<FsmGraphLibraryRecord>,
  fsmBuiltinTemplates: () =>
    ipcRenderer.invoke("fsm:builtinTemplates") as Promise<FsmBuiltinTemplate[]>,
  saveFsmGraph: (record) =>
    ipcRenderer.invoke("fsm:saveGraph", record) as Promise<FsmGraphLibraryRecord>,
  deleteFsmGraph: (id) =>
    ipcRenderer.invoke("fsm:deleteGraph", id) as Promise<void>,
  setFsmGraphEnabled: (id, enabled) =>
    ipcRenderer.invoke("fsm:setGraphEnabled", id, enabled) as Promise<FsmGraphLibraryRecord | null>,
  validateFsmGraph: (config) =>
    ipcRenderer.invoke("fsm:validateGraph", config) as Promise<{ ok: true }>,
  fsmActionCatalog: () =>
    ipcRenderer.invoke("fsm:actionCatalog") as Promise<FsmActionCatalogEntry[]>,
  getSubagent: (sessionId, subagentId) =>
    ipcRenderer.invoke(
      "agent:getSubagent",
      sessionId,
      subagentId,
    ) as Promise<SubagentDetailSnapshot | null>,
  listRunningSubagents: (sessionId) =>
    ipcRenderer.invoke(
      "agent:listRunningSubagents",
      sessionId,
    ) as Promise<SubagentStatusSnapshot[]>,
  listSubagents: (sessionId) =>
    ipcRenderer.invoke(
      "agent:listSubagents",
      sessionId,
    ) as Promise<SubagentRunSummary[]>,
  getSubagentTranscript: (sessionId, subagentId) =>
    ipcRenderer.invoke(
      "agent:getSubagentTranscript",
      sessionId,
      subagentId,
    ) as Promise<SubagentTranscript | null>,
  openSubagentsWindow: (sessionId) =>
    ipcRenderer.invoke("subagentsWindow:open", sessionId) as Promise<{
      ok: true;
    }>,
  onSubagentsWindowSession: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { sessionId: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("subagents-window:setSession", listener);
    return () => {
      ipcRenderer.removeListener(
        "subagents-window:setSession",
        listener,
      );
    };
  },
  searchSessions: (query) =>
    ipcRenderer.invoke("agent:searchSessions", query) as Promise<
      SessionSearchHit[]
    >,
  startTurn: (req) =>
    ipcRenderer.invoke("agent:startTurn", req) as Promise<StartTurnResponse>,
  setSessionProvider: (sessionId, providerId) =>
    ipcRenderer.invoke(
      "agent:setSessionProvider",
      sessionId,
      providerId,
    ) as Promise<Session>,
  setComposerPrefs: (sessionId, patch) =>
    ipcRenderer.invoke(
      "agent:setComposerPrefs",
      sessionId,
      patch,
    ) as Promise<Session>,
  enqueuePrompt: (req) =>
    ipcRenderer.invoke(
      "agent:enqueuePrompt",
      req,
    ) as Promise<EnqueuePromptResponse>,
  listPromptQueue: (sessionId) =>
    ipcRenderer.invoke(
      "agent:listPromptQueue",
      sessionId,
    ) as Promise<QueuedPrompt[]>,
  removeQueuedPrompt: (sessionId, promptId) =>
    ipcRenderer.invoke(
      "agent:removeQueuedPrompt",
      sessionId,
      promptId,
    ) as Promise<PromptQueueMutationResponse>,
  updateQueuedPromptText: (sessionId, promptId, text) =>
    ipcRenderer.invoke(
      "agent:updateQueuedPromptText",
      sessionId,
      promptId,
      text,
    ) as Promise<PromptQueueMutationResponse>,
  removeTurnError: (sessionId, messageId) =>
    ipcRenderer.invoke(
      "agent:removeTurnError",
      sessionId,
      messageId,
    ) as Promise<{ ok: true } | { ok: false; error: string }>,
  promoteQueuedPrompt: (sessionId, promptId) =>
    ipcRenderer.invoke(
      "agent:promoteQueuedPrompt",
      sessionId,
      promptId,
    ) as Promise<PromptQueueMutationResponse>,
  deferQueuedPrompt: (sessionId, promptId) =>
    ipcRenderer.invoke(
      "agent:deferQueuedPrompt",
      sessionId,
      promptId,
    ) as Promise<PromptQueueMutationResponse>,
  moveQueuedPromptToFront: (sessionId, promptId) =>
    ipcRenderer.invoke(
      "agent:moveQueuedPromptToFront",
      sessionId,
      promptId,
    ) as Promise<PromptQueueMutationResponse>,
  cancelTurn: (sessionId) =>
    ipcRenderer.invoke("agent:cancelTurn", sessionId) as Promise<boolean>,
  takePromptRestore: (sessionId) =>
    ipcRenderer.invoke(
      "agent:takePromptRestore",
      sessionId,
    ) as Promise<{ text: string; attachments: AttachmentDraft[] } | null>,
  pauseTurn: (sessionId) =>
    ipcRenderer.invoke("agent:pauseTurn", sessionId) as Promise<{
      ok: boolean;
      reason?: string;
    }>,
  resumeTurn: (req) =>
    ipcRenderer.invoke("agent:resumeTurn", req) as Promise<{
      ok: boolean;
      reason?: string;
    }>,
  compactSession: (sessionId, options) =>
    ipcRenderer.invoke("agent:compactSession", sessionId, options) as Promise<{
      ok: boolean;
      reason?: string;
      compacted?: boolean;
      estimatedTokens?: number;
    }>,
  clearSession: (sessionId) =>
    ipcRenderer.invoke("agent:clearSession", sessionId) as Promise<{
      ok: boolean;
      reason?: string;
    }>,
  endSession: (sessionId) =>
    ipcRenderer.invoke("agent:endSession", sessionId) as Promise<{
      ok: boolean;
      reason?: string;
      compacted?: boolean;
      estimatedTokens?: number;
    }>,
  abortToolCall: (req) =>
    ipcRenderer.invoke("agent:abortToolCall", req) as Promise<{
      stopped: boolean;
    }>,
  deleteSession: (sessionId) =>
    ipcRenderer.invoke("agent:deleteSession", sessionId) as Promise<boolean>,
  setSessionArchived: (req) =>
    ipcRenderer.invoke("session:setArchived", req) as Promise<SessionSummary>,
  respondToolApproval: (req) =>
    ipcRenderer.invoke("agent:respondToolApproval", req) as Promise<boolean>,
  respondUserAsk: (req) =>
    ipcRenderer.invoke("agent:respondUserAsk", req) as Promise<boolean>,
  approvePlan: (sessionId) =>
    ipcRenderer.invoke("agent:approvePlan", sessionId) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  discardPlan: (sessionId) =>
    ipcRenderer.invoke("agent:discardPlan", sessionId) as Promise<
      { ok: true } | { ok: false; error: string }
    >,
  listPendingToolApprovals: (sessionId) =>
    ipcRenderer.invoke("agent:listPendingToolApprovals", sessionId) as Promise<
      ToolApprovalRequestPayload[]
    >,
  listPendingUserAsks: (sessionId) =>
    ipcRenderer.invoke("agent:listPendingUserAsks", sessionId) as Promise<
      UserAskRequestPayload[]
    >,
  listWorkspaces: () =>
    ipcRenderer.invoke("workspace:list") as Promise<Workspace[]>,
  listArchivedWorkspaces: () =>
    ipcRenderer.invoke("workspace:listArchived") as Promise<Workspace[]>,
  setWorkspaceArchived: (req) =>
    ipcRenderer.invoke("workspace:setArchived", req) as Promise<Workspace>,
  createWorkspace: (req) =>
    ipcRenderer.invoke("workspace:create", req) as Promise<Workspace>,
  updateWorkspace: (req) =>
    ipcRenderer.invoke("workspace:update", req) as Promise<Workspace>,
  deleteWorkspace: (workspaceId) =>
    ipcRenderer.invoke("workspace:delete", workspaceId) as Promise<boolean>,
  getActiveWorkspaceId: () =>
    ipcRenderer.invoke("workspace:getActive") as Promise<string | null>,
  setActiveWorkspaceId: (workspaceId) =>
    ipcRenderer.invoke("workspace:setActive", workspaceId) as Promise<string>,
  pickWorkspaceFolder: () =>
    ipcRenderer.invoke("workspace:pickFolder") as Promise<string | null>,
  // New-workspace template flow (menu → scaffold → progress → register).
  listWorkspaceTemplates: () =>
    ipcRenderer.invoke("workspace:listTemplates") as Promise<
      WorkspaceTemplateInfo[]
    >,
  inspectWorkspaceInit: (req) =>
    ipcRenderer.invoke(
      "workspace:inspectTemplateInit",
      req,
    ) as Promise<TemplateInitInspection>,
  createWorkspaceFromTemplate: (req) =>
    ipcRenderer.invoke(
      "workspace:createFromTemplate",
      req,
    ) as Promise<TemplateInitOutcome>,
  cancelWorkspaceInit: (runId) =>
    ipcRenderer.invoke(
      "workspace:cancelTemplateInit",
      runId,
    ) as Promise<boolean>,
  onWorkspaceInitProgress: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: WorkspaceInitProgress,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("workspace:initProgress", listener);
    return () => {
      ipcRenderer.removeListener("workspace:initProgress", listener);
    };
  },
  confirmDialog: (req) =>
    ipcRenderer.invoke("dialog:confirm", req) as Promise<boolean>,
  alertDialog: (req) =>
    ipcRenderer.invoke("dialog:alert", req) as Promise<void>,
  pickAttachmentFiles: (mode) =>
    ipcRenderer.invoke(
      "attachments:pickFiles",
      mode ?? "files",
    ) as Promise<AttachmentDraft[]>,
  resolveAttachmentPaths: (paths) =>
    ipcRenderer.invoke(
      "attachments:resolvePaths",
      paths,
    ) as Promise<AttachmentDraft[]>,
  attachmentPathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return "";
    }
  },
  listTools: () =>
    ipcRenderer.invoke("tools:list") as Promise<ToolCatalogGroup[]>,
  getShellSafety: () =>
    ipcRenderer.invoke("tools:getShellSafety") as Promise<ShellSafety>,
  setShellSafety: (req) =>
    ipcRenderer.invoke("tools:setShellSafety", req) as Promise<ShellSafety>,
  setToolPermissionLevel: (req) =>
    ipcRenderer.invoke(
      "tools:setPermissionLevel",
      req,
    ) as Promise<ToolPermissionUpdate>,
  setToolOffer: (req) =>
    ipcRenderer.invoke("tools:setOffer", req) as Promise<ToolPermissionUpdate>,
  setToolDisplay: (req) =>
    ipcRenderer.invoke(
      "tools:setDisplay",
      req,
    ) as Promise<ToolPermissionUpdate>,
  getHiddenToolCards: () =>
    ipcRenderer.invoke("tools:hiddenCards") as Promise<string[]>,
  autoOrganizeToolOffers: () =>
    ipcRenderer.invoke("tools:autoOrganizeOffers") as Promise<{
      baseline: string[];
      offered: string[];
    }>,
  listMcpServers: () =>
    ipcRenderer.invoke("mcp:list") as Promise<McpServerRuntime[]>,
  upsertMcpServer: (input) =>
    ipcRenderer.invoke("mcp:upsert", input) as Promise<McpServerRuntime>,
  removeMcpServer: (serverId) =>
    ipcRenderer.invoke("mcp:remove", serverId) as Promise<boolean>,
  setMcpServerEnabled: (req) =>
    ipcRenderer.invoke("mcp:setEnabled", req) as Promise<McpServerRuntime>,
  reconnectMcpServer: (serverId) =>
    ipcRenderer.invoke("mcp:reconnect", serverId) as Promise<McpServerRuntime>,
  reloadMcpServers: () =>
    ipcRenderer.invoke("mcp:reload") as Promise<McpServerRuntime[]>,
  listSkills: () =>
    ipcRenderer.invoke("skills:list") as Promise<SkillRecord[]>,
  upsertSkill: (input) =>
    ipcRenderer.invoke("skills:upsert", input) as Promise<SkillRecord>,
  removeSkill: (skillId) =>
    ipcRenderer.invoke("skills:remove", skillId) as Promise<boolean>,
  setSkillEnabled: (req) =>
    ipcRenderer.invoke("skills:setEnabled", req) as Promise<SkillRecord>,
  installSkillZip: () =>
    ipcRenderer.invoke("skills:installZip") as Promise<SkillInstallResult | null>,
  listHooks: () =>
    ipcRenderer.invoke("hooks:list") as Promise<HooksSnapshot>,
  reloadHooks: () =>
    ipcRenderer.invoke("hooks:reload") as Promise<HooksSnapshot>,
  getUserMemory: () =>
    ipcRenderer.invoke("memory:get") as Promise<UserMemorySnapshot>,
  saveUserMemory: (req) =>
    ipcRenderer.invoke("memory:save", req) as Promise<UserMemorySnapshot>,
  clearUserMemory: () =>
    ipcRenderer.invoke("memory:clear") as Promise<UserMemorySnapshot>,
  getProjectMemory: (req) =>
    ipcRenderer.invoke("projectMemory:get", req ?? {}) as Promise<ProjectMemorySnapshot>,
  saveProjectMemory: (req) =>
    ipcRenderer.invoke("projectMemory:save", req) as Promise<ProjectMemorySnapshot>,
  clearProjectMemory: (req) =>
    ipcRenderer.invoke(
      "projectMemory:clear",
      req ?? {},
    ) as Promise<ProjectMemorySnapshot>,
  getWorkingTreeStats: (workspacePath) =>
    ipcRenderer.invoke(
      "git:workingTreeStats",
      workspacePath,
    ) as Promise<WorkingTreeStats>,
  getPathsDiffStats: (paths) =>
    ipcRenderer.invoke("git:pathsDiffStats", paths) as Promise<PathDiffStats[]>,
  listWorkingTreeChanges: (workspacePath) =>
    ipcRenderer.invoke(
      "git:listChanges",
      workspacePath,
    ) as Promise<WorkingTreeChangesResult>,
  getWorkingTreePathDiff: (workspacePath, relativePath) =>
    ipcRenderer.invoke(
      "git:pathDiff",
      workspacePath,
      relativePath,
    ) as Promise<WorkingTreePathDiff>,
  openWorkspaceChangesWindow: (workspacePath) =>
    ipcRenderer.invoke("workspaceChanges:open", workspacePath) as Promise<{
      ok: true;
    }>,
  closeWorkspaceChangesWindow: () =>
    ipcRenderer.invoke("workspaceChanges:close") as Promise<{ ok: true }>,
  openFileReader: (path) =>
    ipcRenderer.invoke("fileReader:open", path) as Promise<{ ok: true }>,
  onFileReaderDocument: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { path: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("file-reader:setDocument", listener);
    return () => {
      ipcRenderer.removeListener(
        "file-reader:setDocument",
        listener,
      );
    };
  },
  onWorkspaceChangesPath: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { workspacePath: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("workspace-changes:setWorkspacePath", listener);
    return () => {
      ipcRenderer.removeListener(
        "workspace-changes:setWorkspacePath",
        listener,
      );
    };
  },
  prepareCommit: (workspacePath, providerId, paths) =>
    ipcRenderer.invoke(
      "git:prepareCommit",
      workspacePath,
      providerId,
      paths,
    ) as Promise<PrepareCommitResult>,
  commitWorkspace: (req) =>
    ipcRenderer.invoke("git:commit", req) as Promise<CommitResult>,
  openPath: (path) =>
    ipcRenderer.invoke("shell:openPath", path) as Promise<string>,
  openExternal: (url) =>
    ipcRenderer.invoke("shell:openExternal", url) as Promise<boolean>,
  showItemInFolder: (path) =>
    ipcRenderer.invoke("shell:showItemInFolder", path) as Promise<boolean>,
  saveFileAs: (path) =>
    ipcRenderer.invoke("shell:saveFileAs", path) as Promise<
      { ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }
    >,
  downloadResponseFile: (request) =>
    ipcRenderer.invoke("agent:downloadResponseFile", request) as Promise<{
      ok: boolean; cancelled?: boolean; path?: string; error?: string;
    }>,
  trashItem: (path) =>
    ipcRenderer.invoke("shell:trashItem", path) as Promise<
      { ok: true } | { ok: false; message: string }
    >,
  cocoHistory: (ruleId, cursor) => ipcRenderer.invoke("coco:history", { ruleId, cursor }),
  cocoSnapshot: () => ipcRenderer.invoke("coco:snapshot"),
  cocoWorkResults: (workId) => ipcRenderer.invoke("coco:workResults", workId),
  cocoActivity: () => ipcRenderer.invoke("coco:activity"),
  onCocoActivity: (handler) => {
    const listener = (_event: IpcRendererEvent, activity: import("../coco/activity.js").CocoActivity) => handler(activity);
    ipcRenderer.on("coco:activity", listener);
    return () => { ipcRenderer.removeListener("coco:activity", listener); };
  },
  onCocoChanged: (handler) => {
    const listener = () => handler();
    ipcRenderer.on("coco:changed", listener);
    return () => { ipcRenderer.removeListener("coco:changed", listener); };
  },
  cocoCommand: (command) => ipcRenderer.invoke("coco:command", command),
  cocoHandoverSession: (sessionId) => ipcRenderer.invoke("coco:handoverSession", sessionId),
  cocoTakeBackSession: (sessionId) => ipcRenderer.invoke("coco:takeBackSession", sessionId),
  loopsList: () =>
    ipcRenderer.invoke("loops:list") as Promise<LoopView[]>,
  loopsListRuns: (loopId, limit) =>
    ipcRenderer.invoke("loops:listRuns", {
      loopId,
      limit,
    }) as Promise<LoopRunRecord[]>,
  loopsCreate: (loop) =>
    ipcRenderer.invoke("loops:create", loop) as Promise<LoopView>,
  loopsUpdate: (loopId, loop) =>
    ipcRenderer.invoke("loops:update", { loopId, loop }) as Promise<LoopView>,
  loopsDelete: (loopId) =>
    ipcRenderer.invoke("loops:delete", { loopId }) as Promise<boolean>,
  loopsSetEnabled: (loopId, enabled) =>
    ipcRenderer.invoke("loops:setEnabled", { loopId, enabled }) as Promise<
      LoopView
    >,
  loopsDaemonStatus: () =>
    ipcRenderer.invoke("loops:daemonStatus") as Promise<LoopsDaemonView>,
  loopsInstallDaemon: () =>
    ipcRenderer.invoke("loops:installDaemon") as Promise<LoopsDaemonView>,
  loopsEnsureDaemon: () =>
    ipcRenderer.invoke("loops:ensureDaemon") as Promise<LoopsDaemonView>,
  loopsRepairDaemon: () =>
    ipcRenderer.invoke("loops:repairDaemon") as Promise<LoopsDaemonView>,
  loopsStopDaemon: () =>
    ipcRenderer.invoke("loops:stopDaemon") as Promise<LoopsDaemonView>,
  loopsUninstallDaemon: () =>
    ipcRenderer.invoke("loops:uninstallDaemon") as Promise<{
      ok: boolean;
      message?: string;
    }>,
  readTextFile: (path) =>
    ipcRenderer.invoke("fs:readTextFile", path) as Promise<
      { ok: true; content: string } | { ok: false; message: string }
    >,
  filterExistingFiles: (paths) =>
    ipcRenderer.invoke("fs:filterExistingFiles", paths) as Promise<string[]>,
  // Dev Mode (plan: dev-mode-v1)
  listDevModeDir: (path) =>
    ipcRenderer.invoke("devmode:listDir", path) as Promise<DevModeListResult>,
  runDevModeExecutable: (path) =>
    ipcRenderer.invoke("devmode:runExecutable", path) as Promise<
      { ok: true } | { ok: false; message: string }
    >,
  readDevModeProjectFile: (path) =>
    ipcRenderer.invoke("devmode:readProjectFile", path) as Promise<
      ProjectFileContentResult
    >,
  getDevModeEngineRoot: (rootPath) =>
    ipcRenderer.invoke("devmode:engineRoot", rootPath) as Promise<string | null>,
  resolveDevModeSourcePath: (rootPath, sourcePath) =>
    ipcRenderer.invoke(
      "devmode:resolveSourcePath",
      rootPath,
      sourcePath,
    ) as Promise<string | null>,
  searchDevModeFiles: (
    rootPath: string,
    query: string,
    options?: DevModeSearchOptions,
  ) =>
    ipcRenderer.invoke(
      "devmode:searchFiles",
      rootPath,
      query,
      options,
    ) as Promise<DevModeSearchResult>,
  startDevModeFileIndex: (
    rootPath: string,
    requestId: number,
    options?: DevModeSearchOptions,
  ) =>
    ipcRenderer.invoke(
      "devmode:indexFiles",
      rootPath,
      requestId,
      options,
    ) as Promise<{ ok: boolean; message?: string }>,
  cancelDevModeFileIndex: () =>
    ipcRenderer.invoke("devmode:indexCancel") as Promise<void>,
  onDevModeIndexChunk: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DevModeIndexChunk,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("devmode:indexChunk", listener);
    return () => {
      ipcRenderer.removeListener("devmode:indexChunk", listener);
    };
  },
  getVcsStatus: (rootPath) =>
    ipcRenderer.invoke("vcs:status", rootPath) as Promise<VcsStatusResult>,
  getVcsFileDiff: (rootPath, absPath) =>
    ipcRenderer.invoke("vcs:fileDiff", rootPath, absPath) as Promise<
      { ok: true; diff: VcsFileDiff } | { ok: false; message: string }
    >,
  getVcsFileBase: (rootPath, absPath) =>
    ipcRenderer.invoke(
      "vcs:fileBase",
      rootPath,
      absPath,
    ) as Promise<VcsFileBaseResult>,
  annotateFile: (rootPath, absPath) =>
    ipcRenderer.invoke("vcs:blame", rootPath, absPath) as Promise<VcsBlameResult>,
  runVcsAction: (rootPath, action) =>
    ipcRenderer.invoke("vcs:action", rootPath, action) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  revealPath: (path) =>
    ipcRenderer.invoke("vcs:reveal", path) as Promise<{ ok: boolean }>,
  // Dev Mode tasks (.larry/tasks.json) — Build/Run icon buttons
  getDevTaskConfig: (workspacePath) =>
    ipcRenderer.invoke(
      "devtask:config",
      workspacePath,
    ) as Promise<DevTaskConfigQueryResult>,
  runDevTask: (workspacePath, task) =>
    ipcRenderer.invoke(
      "devtask:run",
      workspacePath,
      task,
    ) as Promise<RunDevTaskResult>,
  stopDevTask: (runId) =>
    ipcRenderer.invoke("devtask:stop", runId) as Promise<{ ok: boolean }>,
  getDevTaskState: (workspacePath) =>
    ipcRenderer.invoke(
      "devtask:state",
      workspacePath,
    ) as Promise<DevTaskStateResult>,
  startDebug: (request) =>
    ipcRenderer.invoke("debug:start", request) as Promise<DebugStartResult>,
  setDebugBreakpoints: (path, breakpoints) =>
    ipcRenderer.invoke("debug:setBreakpoints", path, breakpoints) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  runDebugCommand: (command) =>
    ipcRenderer.invoke("debug:command", command) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  selectDebugThread: (threadId) =>
    ipcRenderer.invoke("debug:selectThread", threadId) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  selectDebugTarget: (targetId) =>
    ipcRenderer.invoke("debug:selectTarget", targetId) as Promise<{
      ok: boolean;
      message?: string;
    }>,
  selectDebugFrame: (frameId) =>
    ipcRenderer.invoke("debug:selectFrame", frameId) as Promise<{
      ok: boolean;
      message?: string;
      frame?: DebugSnapshot["stack"][number];
    }>,
  evaluateDebugExpression: (expression, frameId) =>
    ipcRenderer.invoke(
      "debug:evaluate",
      expression,
      frameId,
    ) as Promise<DebugEvaluateResult>,
  getDebugVariables: (variablesReference) =>
    ipcRenderer.invoke(
      "debug:variables",
      variablesReference,
    ) as Promise<DebugVariablesResult>,
  getDebugState: () =>
    ipcRenderer.invoke("debug:state") as Promise<DebugSnapshot>,
  onDebugState: (handler) => {
    const listener = (_event: IpcRendererEvent, snapshot: DebugSnapshot): void => {
      handler(snapshot);
    };
    ipcRenderer.on("debug:state", listener);
    return () => ipcRenderer.removeListener("debug:state", listener);
  },
  onDebugOutput: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DebugOutputEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("debug:output", listener);
    return () => ipcRenderer.removeListener("debug:output", listener);
  },
  onDevTaskOutput: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DevTaskOutputEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("devtask:output", listener);
    return () => {
      ipcRenderer.removeListener("devtask:output", listener);
    };
  },
  onDevTaskProgress: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DevTaskProgressEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("devtask:progress", listener);
    return () => {
      ipcRenderer.removeListener("devtask:progress", listener);
    };
  },
  onDevTaskExit: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DevTaskRunSnapshot,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("devtask:exit", listener);
    return () => {
      ipcRenderer.removeListener("devtask:exit", listener);
    };
  },
  pushWorkspace: (workspacePath) =>
    ipcRenderer.invoke("git:push", workspacePath) as Promise<{
      ok: boolean;
      message?: string;
      output?: string;
    }>,
  watchDevModePath: (rootPath) =>
    ipcRenderer.invoke("devmode:watch", rootPath) as Promise<
      { ok: true } | { ok: false; message: string }
    >,
  unwatchDevModePath: (rootPath) =>
    ipcRenderer.invoke("devmode:unwatch", rootPath) as Promise<{ ok: true }>,
  lookupCppSymbols: (rootPath, word) =>
    ipcRenderer.invoke(
      CPP_SYMBOL_LOOKUP_CHANNEL,
      rootPath,
      word,
    ) as Promise<CppSymbolHit[]>,
  completeCppSymbols: (rootPath, request) =>
    ipcRenderer.invoke(
      CPP_SYMBOL_COMPLETE_CHANNEL,
      rootPath,
      request,
    ) as Promise<CppCompletionHit[]>,
  findCppUsages: (rootPath, request) =>
    ipcRenderer.invoke(
      CPP_USAGE_SEARCH_CHANNEL,
      rootPath,
      request,
    ) as Promise<CppUsageSearchResult>,
  cancelCppUsageSearch: (queryId) =>
    ipcRenderer.invoke(CPP_USAGE_CANCEL_CHANNEL, queryId) as Promise<{
      ok: true;
    }>,
  clangdStatus: (rootPath) =>
    ipcRenderer.invoke(CLANGD_STATUS_CHANNEL, rootPath) as Promise<ClangdStatus>,
  clangdWarmup: (rootPath) =>
    ipcRenderer.invoke(CLANGD_ENSURE_CHANNEL, rootPath) as Promise<ClangdStatus>,
  clangdDownload: () =>
    ipcRenderer.invoke(CLANGD_DOWNLOAD_CHANNEL) as Promise<
      { ok: true; path: string } | { ok: false; message: string }
    >,
  clangdReferences: (rootPath, request) =>
    ipcRenderer.invoke(
      CLANGD_REFERENCES_CHANNEL,
      rootPath,
      request,
    ) as Promise<ClangdReferencesResult>,
  clangdDefinition: (rootPath, request, queryId) =>
    ipcRenderer.invoke(
      CLANGD_DEFINITION_CHANNEL,
      rootPath,
      request,
      queryId,
    ) as Promise<ClangdDefinitionResult>,
  clangdCancelQuery: (queryId) =>
    ipcRenderer.invoke(CLANGD_CANCEL_QUERY_CHANNEL, queryId) as Promise<boolean>,
  clangdWorkspaceSymbols: (rootPath, query) =>
    ipcRenderer.invoke(
      CLANGD_WORKSPACE_SYMBOLS_CHANNEL,
      rootPath,
      query,
    ) as Promise<ClangdWorkspaceSymbolsResult>,
  clangdHover: (rootPath, request) =>
    ipcRenderer.invoke(
      CLANGD_HOVER_CHANNEL,
      rootPath,
      request,
    ) as Promise<ClangdHoverResult>,
  clangdCompletion: (rootPath, request, queryId) =>
    ipcRenderer.invoke(
      CLANGD_COMPLETION_CHANNEL,
      rootPath,
      request,
      queryId,
    ) as Promise<ClangdCompletionResult>,
  clangdIndexComplete: (rootPath, request) =>
    ipcRenderer.invoke(
      CLANGD_INDEX_COMPLETE_CHANNEL,
      rootPath,
      request,
    ) as Promise<CppCompletionHit[]>,
  clangdSignatureHelp: (rootPath, request) =>
    ipcRenderer.invoke(
      CLANGD_SIGNATURE_HELP_CHANNEL,
      rootPath,
      request,
    ) as Promise<ClangdSignatureHelpResult>,
  clangdDocChanged: (rootPath, path, text) =>
    ipcRenderer.invoke(
      CLANGD_DOC_CHANGED_CHANNEL,
      rootPath,
      path,
      text,
    ) as Promise<{ ok: true }>,
  clangdDocClosed: (rootPath, path) =>
    ipcRenderer.invoke(
      CLANGD_DOC_CLOSED_CHANNEL,
      rootPath,
      path,
    ) as Promise<{ ok: true }>,
  getCppSymbolExtraRoots: (rootPath) =>
    ipcRenderer.invoke(
      CPP_SYMBOL_ROOTS_CHANNEL,
      rootPath,
    ) as Promise<CppSymbolRootsResult>,
  addCppSymbolExtraRoot: (rootPath, dirPath) =>
    ipcRenderer.invoke(
      CPP_SYMBOL_ADD_ROOT_CHANNEL,
      rootPath,
      dirPath,
    ) as Promise<CppSymbolRootMutationResult>,
  removeCppSymbolExtraRoot: (rootPath, dirPath) =>
    ipcRenderer.invoke(
      CPP_SYMBOL_REMOVE_ROOT_CHANNEL,
      rootPath,
      dirPath,
    ) as Promise<CppSymbolRootMutationResult>,
  onCppSymbolProgress: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: CppSymbolProgressEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(CPP_SYMBOL_PROGRESS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CPP_SYMBOL_PROGRESS_CHANNEL, listener);
    };
  },
  onClangdProgress: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: ClangdIndexProgressEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on(CLANGD_PROGRESS_CHANNEL, listener);
    return () => {
      ipcRenderer.removeListener(CLANGD_PROGRESS_CHANNEL, listener);
    };
  },
  readFileForEditor: (path) =>
    ipcRenderer.invoke("fs:readFileForEditor", path) as Promise<EditorFileResult>,
  writeTextFile: (path, content, addBom) =>
    ipcRenderer.invoke("fs:writeTextFile", {
      path,
      content,
      addBom,
    }) as Promise<{ ok: true } | { ok: false; message: string }>,
  onDevModeFsEvent: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: DevModeFsEvent,
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("devmode:fsEvent", listener);
    return () => {
      ipcRenderer.removeListener("devmode:fsEvent", listener);
    };
  },
  onVcsChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { rootPath: string },
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("vcs:changed", listener);
    return () => {
      ipcRenderer.removeListener("vcs:changed", listener);
    };
  },
  onAppearanceChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: {
        themeId: string;
        accentColor: string | null;
        uiFontScale?: number;
        chatFontScale?: number;
      },
    ): void => {
      handler(payload);
    };
    ipcRenderer.on("settings:appearanceChanged", listener);
    return () => {
      ipcRenderer.removeListener("settings:appearanceChanged", listener);
    };
  },
  setUiZoomFactor: (factor) => {
    if (typeof factor !== "number" || !Number.isFinite(factor)) return;
    webFrame.setZoomFactor(Math.min(1.5, Math.max(0.8, factor)));
  },
  getProcessMetrics: () =>
    ipcRenderer.invoke(
      "diagnostics:getProcessMetrics",
    ) as Promise<ProcessMetrics>,
  getRecentLogs: () =>
    ipcRenderer.invoke("diagnostics:getRecentLogs") as Promise<LogEntry[]>,
  getToolStatsSummary: (req) =>
    ipcRenderer.invoke(
      "toolStats:getSummary",
      req ?? {},
    ) as Promise<ToolInvocationSummaryRow[]>,
  listToolStatsFailures: (req) =>
    ipcRenderer.invoke(
      "toolStats:listFailures",
      req ?? {},
    ) as Promise<ToolInvocationRecord[]>,
  listToolStatsInvocations: (req) =>
    ipcRenderer.invoke(
      "toolStats:listInvocations",
      req ?? {},
    ) as Promise<ToolInvocationRecord[]>,
  getToolStatsInvocation: (id) =>
    ipcRenderer.invoke(
      "toolStats:getInvocation",
      id,
    ) as Promise<ToolInvocationRecord | null>,
  getToolStatsEnabled: () =>
    ipcRenderer.invoke("toolStats:getEnabled") as Promise<boolean>,
  resetToolStats: () =>
    ipcRenderer.invoke("toolStats:reset") as Promise<number>,
  llmTimelineList: (sessionId) =>
    ipcRenderer.invoke(
      "llmTimeline:list",
      sessionId,
    ) as Promise<LlmTimelineSnapshot>,
  onLlmTimelineUpdated: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { sessionId: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("llmTimeline:updated", listener);
    return () => {
      ipcRenderer.removeListener("llmTimeline:updated", listener);
    };
  },
  onNotificationCenterEvent: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { eventName: string; params: unknown },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("nc:event", listener);
    return () => {
      ipcRenderer.removeListener("nc:event", listener);
    };
  },
  getFullRequestLog: () =>
    ipcRenderer.invoke("diagnostics:getFullRequestLog") as Promise<boolean>,
  setFullRequestLog: (enabled) =>
    ipcRenderer.invoke(
      "diagnostics:setFullRequestLog",
      enabled,
    ) as Promise<boolean>,
  openLogsFolder: () =>
    ipcRenderer.invoke("diagnostics:openLogsFolder") as Promise<{
      ok: boolean;
      path?: string;
      error?: string;
    }>,
  saveLogsToFile: (content) =>
    ipcRenderer.invoke("diagnostics:saveLogs", content) as Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      error?: string;
    }>,
  getStorageUsage: () =>
    ipcRenderer.invoke("storage:getUsage") as Promise<StorageUsage>,
  cleanupStorage: () =>
    ipcRenderer.invoke("storage:cleanup") as Promise<CleanupResult>,
  terminalRun: (req) =>
    ipcRenderer.invoke("terminal:run", req) as Promise<{ runId: string }>,
  terminalCancel: (runId) =>
    ipcRenderer.invoke("terminal:cancel", { runId }) as Promise<{
      ok: boolean;
    }>,
  windowControls: {
    minimize: () =>
      ipcRenderer.invoke("window:minimize") as Promise<{ ok: boolean }>,
    toggleMaximize: () =>
      ipcRenderer.invoke("window:toggleMaximize") as Promise<{
        ok: boolean;
        maximized: boolean;
      }>,
    close: () =>
      ipcRenderer.invoke("window:close") as Promise<{ ok: boolean }>,
  },
  onWindowMaximizeChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { maximized: boolean },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("window:maximizeChanged", listener);
    return () => {
      ipcRenderer.removeListener("window:maximizeChanged", listener);
    };
  },
  onWindowCloseRequest: (handler) => {
    const listener = (): void => handler();
    ipcRenderer.on("window:closeRequest", listener);
    return () => {
      ipcRenderer.removeListener("window:closeRequest", listener);
    };
  },
  onEditorGoToDefinition: (handler) => {
    const listener = (): void => handler();
    ipcRenderer.on("editor:goToDefinition", listener);
    return () => {
      ipcRenderer.removeListener("editor:goToDefinition", listener);
    };
  },
  onEditorFindUsages: (handler) => {
    const listener = (): void => handler();
    ipcRenderer.on("editor:findUsages", listener);
    return () => {
      ipcRenderer.removeListener("editor:findUsages", listener);
    };
  },
  speechStart: () =>
    ipcRenderer.invoke("speech:start").then(() => undefined),
  speechStop: () =>
    ipcRenderer.invoke("speech:stop") as Promise<SpeechStopResult>,
  onSpeechEvent: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      event: SpeechHelperEvent,
    ) => {
      handler(event);
    };
    ipcRenderer.on("speech:event", listener);
    return () => {
      ipcRenderer.removeListener("speech:event", listener);
    };
  },
  onTerminalOutput: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { runId: string; stream: "stdout" | "stderr"; text: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("terminal:output", listener);
    return () => {
      ipcRenderer.removeListener("terminal:output", listener);
    };
  },
  onTerminalDone: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: {
        runId: string;
        exitCode: number;
        signal?: string;
        cwd?: string;
      },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("terminal:done", listener);
    return () => {
      ipcRenderer.removeListener("terminal:done", listener);
    };
  },
  onDiagnosticLog: (handler) => {
    const listener = (_event: IpcRendererEvent, entry: LogEntry) => {
      handler(entry);
    };
    ipcRenderer.on("diagnostics:log", listener);
    return () => {
      ipcRenderer.removeListener("diagnostics:log", listener);
    };
  },
  onAgentStream: (handler) => {
    const listener = (_event: IpcRendererEvent, payload: AgentStreamPayload) => {
      handler(payload);
    };
    ipcRenderer.on("agent:stream", listener);
    return () => {
      ipcRenderer.removeListener("agent:stream", listener);
    };
  },
  onSessionUpdated: (handler) => {
    const listener = (_event: IpcRendererEvent, summary: SessionSummary) => {
      handler(summary);
    };
    ipcRenderer.on("agent:sessionUpdated", listener);
    return () => {
      ipcRenderer.removeListener("agent:sessionUpdated", listener);
    };
  },
  onSessionDeleted: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { id: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:sessionDeleted", listener);
    return () => {
      ipcRenderer.removeListener("agent:sessionDeleted", listener);
    };
  },
  onWorkspaceChanged: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: WorkspaceChangedPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("workspace:changed", listener);
    return () => {
      ipcRenderer.removeListener("workspace:changed", listener);
    };
  },
  onToolApproval: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: ToolApprovalRequestPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:toolApproval", listener);
    return () => {
      ipcRenderer.removeListener("agent:toolApproval", listener);
    };
  },
  onVcsAuthRequest: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: VcsAuthRequestPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("vcs:authRequest", listener);
    return () => {
      ipcRenderer.removeListener("vcs:authRequest", listener);
    };
  },
  respondVcsAuth: (response: VcsAuthResponse) =>
    ipcRenderer.invoke("vcs:authRespond", response) as Promise<boolean>,
  onToolApprovalDismiss: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: ToolApprovalDismissPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:toolApprovalDismiss", listener);
    return () => {
      ipcRenderer.removeListener("agent:toolApprovalDismiss", listener);
    };
  },
  onUserAsk: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: UserAskRequestPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:userAsk", listener);
    return () => {
      ipcRenderer.removeListener("agent:userAsk", listener);
    };
  },
  onUserAskDismiss: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: UserAskDismissPayload,
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:userAskDismiss", listener);
    return () => {
      ipcRenderer.removeListener("agent:userAskDismiss", listener);
    };
  },
  onCelebration: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { source: "task" | "f12" },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("agent:celebrate", listener);
    return () => {
      ipcRenderer.removeListener("agent:celebrate", listener);
    };
  },
  onMenubarAction: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { action: "new-task" | "loop" | "settings" },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("menubar:action", listener);
    return () => {
      ipcRenderer.removeListener("menubar:action", listener);
    };
  },
  onAppNotify: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      snapshot: AppNotifySnapshot,
    ) => {
      handler(snapshot);
    };
    ipcRenderer.on("app:notify", listener);
    return () => {
      ipcRenderer.removeListener("app:notify", listener);
    };
  },
  getNotifyLedger: () =>
    ipcRenderer.invoke("appnotify:getLedger") as Promise<AppNotifySnapshot>,
  markNotifyRead: (req) =>
    ipcRenderer.invoke(
      "appnotify:markRead",
      req,
    ) as Promise<AppNotifySnapshot>,
  clearNotifyLedger: () =>
    ipcRenderer.invoke("appnotify:clear") as Promise<AppNotifySnapshot>,
  notifyPopupAction: (id, action) =>
    ipcRenderer.invoke("appnotify:popupAction", {
      id,
      action,
    }) as Promise<void>,
  onNotifyActivate: (handler) => {
    const listener = (
      _event: IpcRendererEvent,
      payload: { sessionId?: string },
    ) => {
      handler(payload);
    };
    ipcRenderer.on("appnotify:activate", listener);
    return () => {
      ipcRenderer.removeListener("appnotify:activate", listener);
    };
  },
};

contextBridge.exposeInMainWorld("jellybot", bridge);
