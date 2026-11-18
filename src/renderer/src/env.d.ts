/// <reference types="vite/client" />

type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

type SpeechHelperEvent =
  | { type: "waiting"; message: string }
  | { type: "ready" }
  | { type: "partial"; text: string; lang: "ZH" | "EN" }
  | { type: "level"; value: number }
  | { type: "final"; text: string; lang: "ZH" | "EN" }
  | { type: "error"; message: string };

type RemoteMemorySyncConfig = {
  enabled: boolean;
  sessionArchive: boolean;
  projectDocs: boolean;
};
type RemoteRelayConfig = {
  enabled: boolean;
  serverUrl: string;
  deviceId: string;
  deviceName: string;
  mode: "readonly" | "full";
  pushActivity: "all" | "active" | "off";
  memorySync?: RemoteMemorySyncConfig;
};
type UpdateMaintenanceState = {
  phase: "idle" | "queued" | "running" | "done" | "failed";
  id?: string;
  version?: string;
  error?: string;
  step?: "download" | "verify" | "extract" | "smoke" | "install" | "switch" | "units" | "restart";
  progress?: { receivedBytes: number; totalBytes?: number; bytesPerSec?: number; pct?: number };
  ts: number;
};
type MemorySyncStatusSnapshot = {
  lastRunAt: number | null;
  lastResult: "ok" | "error" | "off" | null;
  lastError: string | null;
  pushed: number;
  inserted: number;
  updated: number;
  cursor: number;
  pendingPush: number;
};
type MemorySyncOutcomeSnapshot = {
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

interface LlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  rawEndpoint?: boolean;
  apiProtocol?: "auto" | "chat_completions" | "responses";
  responsesTools?: import("../../session/types.js").JsonObject[];
  responsesStateful?: boolean;
  supportsMultimodal?: boolean;
  imageInput?: "url" | "base64" | "file";
  toolRoleImages?: boolean;
}

type ReasoningEffort = "off" | "low" | "medium" | "high" | "max";

interface ObjectStorageConfig {
  provider: "amazon" | "tencent";
  region: string;
  bucket: string;
  accessKeyId: string;
  endpoint?: string;
  keyPrefix?: string;
  urlMode?: "presigned" | "public";
  enabled?: boolean;
}

interface ImageGenProvider {
  id: string;
  name: string;
  baseUrl: string;
  modelId: string;
  rawEndpoint?: boolean;
  watermark?: boolean;
  imageInput?: "base64" | "url";
}

interface ResolvedWorkspaceSettings {
  providers: LlmProvider[];
  activeProviderId: string;
  visionProviderId: string | null;
  inlineCompletionProviderId: string | null;
  imageGenProviders: ImageGenProvider[];
  activeImageGenProviderId: string;
  objectStorage: ObjectStorageConfig | null;
  fullPermissionsDefault: boolean;
  autoSkillSummarizeDefault: boolean;
  composerRunMode: "agent" | "ask" | "plan";
  composerInfinite: boolean;
  reasoningEffort: ReasoningEffort;
  composerVoiceMode: boolean;
  contextLimitTokens: number;
  compactTriggerRatio: number;
  iterationProtectRawIterationCount: number;
  iterationProtectTokenRatio: number;
  maxModelIterations: number;
  maxTurnTokens: number;
  llmRequestTimeoutMs: number;
  activeWorkspaceId: string | null;
  debugAdapterPath: string | null;
  environmentContext: EnvironmentContextFlags;
  userMemoryAutoExtract: boolean;
  projectMemoryAutoExtract: boolean;
  toolStatsEnabled: boolean;
  themeId: "dark" | "light";
  accentColor?: string | null;
  uiFontScale: number;
  chatFontScale: number;
}

interface EnvironmentContextFlags {
  workspace: boolean;
  timezone: boolean;
  locale: boolean;
  location: boolean;
  repository: boolean;
}

interface McpStdioTransport {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

interface McpHttpTransport {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

type McpTransport = McpStdioTransport | McpHttpTransport;

interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

interface McpDiscoveredTool {
  name: string;
  description: string;
  registryName: string;
  defaultPermissionLevel: 0 | 1 | 2;
  permissionLevel: 0 | 1 | 2;
  offered: boolean;
  offerLocked?: boolean;
  callCount?: number;
}

interface McpServerRuntime {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  status: "disconnected" | "connecting" | "connected" | "error";
  errorMessage?: string;
  tools: McpDiscoveredTool[];
}

interface McpServerUpsertInput {
  id?: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
}

interface SkillConfig {
  id: string;
  name: string;
  enabled: boolean;
  project?: string;
}

type SkillOrigin = "user" | "installed" | "agent" | "reflector" | "coco";

interface SkillRecord {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  body: string;
  path: string;
  directory: string;
  files: string[];
  origin: SkillOrigin;
  status: "active" | "deprecated";
  project?: string;
  supersededBy?: string;
  supersededByName?: string;
  createdAt?: number;
  updatedAt?: number;
  createdFrom?: { sessionId: string; userMessageId?: string };
  revision: number;
}

interface SkillUsageStatsRow {
  skillId: string;
  uses: number;
  lastUsedAt: number;
  finished: number;
  successes: number;
  corrected: number;
}

interface SkillRevisionEntry {
  revision: number;
  name: string;
  description: string;
  savedAt: number;
  replacedBy: { actor: SkillOrigin; reason?: string; sessionId?: string };
  current: boolean;
}

interface SkillRevisionContent {
  revision: number;
  name: string;
  description: string;
  body: string;
  skillMd: string;
  files: string[];
}

interface SkillProposalView {
  id: string;
  kind: "patch" | "update" | "merge" | "deprecate";
  status: "pending" | "accepted" | "rejected";
  targetIds: string[];
  reason: string;
  actor: SkillOrigin;
  sessionId?: string;
  createdAt: number;
  stale: boolean;
  changes: { skillId: string | null; name: string; before: string; after: string }[];
}

interface SkillCurationItemResult {
  kind: "cluster" | "stale" | "poor";
  skills: string[];
  decision: "merge" | "patch" | "deprecate" | "keep" | "error";
  applied: boolean;
  proposalId?: string;
  reason: string;
}

interface SkillCurationStatus {
  running: boolean;
  lastRunAt?: number;
  lastResult?: { at: number; trigger: string; items: SkillCurationItemResult[]; error?: string };
  summary?: string;
}

interface SkillUpsertInput {
  id?: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
  project?: string;
  files?: { path: string; content: string }[];
  removeFiles?: string[];
}

interface SkillInstallResult {
  installed: SkillRecord[];
  overwritten: string[];
}

interface HookListEntry {
  id: string;
  event: string;
  source: "user" | "project" | "in-process";
  command: string;
  matcher?: string;
  failClosed: boolean;
  timeoutSec?: number;
}

interface HooksSnapshot {
  entries: HookListEntry[];
  paths: { user: string; project: string };
  workspacePath: string;
}

interface UserMemorySnapshot {
  profile: string;
  updatedAt: number;
  empty: boolean;
}

interface ProjectMemorySnapshot {
  workspacePath: string;
  body: string;
  updatedAt: number;
  empty: boolean;
  filePath: string;
}

interface WorkingTreeStats {
  isRepo: boolean;
  insertions: number;
  deletions: number;
  dirtyFileCount: number;
  aheadCount: number;
  behindCount: number;
}

interface PathDiffStats {
  path: string;
  isRepo: boolean;
  insertions: number;
  deletions: number;
  hasDiff: boolean;
}

type WorkingTreeChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

interface WorkingTreeChange {
  path: string;
  oldPath?: string;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
}

interface WorkingTreeChangesResult {
  isRepo: boolean;
  files: WorkingTreeChange[];
}

interface WorkingTreePathDiff {
  path: string;
  binary: boolean;
  before: string;
  after: string;
  truncated: boolean;
}

interface PrepareCommitResult {
  draftMessage: string;
  messageSource: "llm" | "fallback";
  stats: WorkingTreeStats;
}

interface CommitResult {
  ok: true;
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs?: "git" | "svn";
}

interface PromptDefaults {
  userPrompt: string;
  projectPrompt: string;
}

interface SettingsSnapshot {
  settings: ResolvedWorkspaceSettings;
  promptDefaults: PromptDefaults;
  apiKeyConfiguredByProviderId: Record<string, boolean>;
  appVersion: string;
}

interface LlmHealthResult {
  ok: boolean;
  providerId: string;
  reason?: string;
}

type LlmProbeModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: string };

interface ProviderBalanceResult {
  providerId: string;
  text: string | null;
}


type UsageProviderKey =
  | "kimi-code"
  | "glm-code"
  | "kimi"
  | "deepseek"
  | "openrouter"
  | "qwen-code";

interface UsageBar {
  label: string;
  percent: number;
  detail?: string;
}

interface ProviderUsageSnapshot {
  key: UsageProviderKey;
  title: string;
  badge?: string;
  bars: UsageBar[];
  lines: string[];
  error?: string;
  fetchedAt: number;
}

interface ProviderUsageResult {
  snapshots: ProviderUsageSnapshot[];
  activeKey: UsageProviderKey | null;
}

type UsagePopupAction =
  | { type: "close" }
  | { type: "resize"; height: number }
  | { type: "new-task" }
  | { type: "settings" }
  | { type: "quit" };

interface Workspace {
  id: string;
  name: string;
  path: string;
  origin: "user" | "coco";
  createdAt: number;
  updatedAt: number;
}


type WorkspaceTemplateId = "web-node" | "electron" | "unreal" | "blank";
type WorkspaceTemplateIconId = "globe" | "atom" | "unreal" | "file";
type WorkspaceTemplateTreeLine = {
  text: string;
  kind: "dir" | "cfg" | "plain" | "note";
};
type WorkspaceTemplateInfo = {
  id: WorkspaceTemplateId;
  name: string;
  desc: string;
  iconId: WorkspaceTemplateIconId;
  stack: string[];
  hasDeps: boolean;
  tree: WorkspaceTemplateTreeLine[];
};

type WorkspaceInitStepId = "folders" | "files" | "git" | "install" | "register";
type WorkspaceInitStepState = "running" | "done" | "skipped" | "failed";
type WorkspaceInitProgress = {
  runId: string;
  step: WorkspaceInitStepId;
  state: WorkspaceInitStepState;
  detail?: string;
};

type WorkspaceInitPlanState = "will-run" | "skip-exists" | "n-a";
type WorkspaceTemplateInitInspection = {
  git: WorkspaceInitPlanState;
  install: WorkspaceInitPlanState;
};
type WorkspaceTemplateInitOutcome = {
  ok: boolean;
  cancelled: boolean;
  workspace: Workspace | null;
  written: string[];
  skipped: string[];
  gitInited: boolean;
  installRan: boolean;
  installFailed: boolean;
  error?: string;
};

interface SessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  status: SessionStatus;
  progressText: string;
  type: "agent";
  messageCount: number;
  workspaceId: string;
  archived: boolean;
  archivedAt: number | null;
  source?: "app" | "subagent" | "loop" | "coco";
}

interface SessionSearchHit {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  updatedAt: number;
  matchKind: "title" | "message";
  preview: string;
}

interface StartTurnRequest {
  sessionId?: string;
  workspaceId?: string;
  providerId?: string;
  title?: string;
  userText: string;
  fullPermissions: boolean;
  autoSkillSummarize?: boolean;
  runMode?: "agent" | "ask" | "plan" | "custom";
  fsmGraphId?: string;
  planMode?: boolean;
  reasoningEffort?: ReasoningEffort;
  composerInfinite?: boolean;
  attachments?: AttachmentDraft[];
  editorContext?: { activeFile?: string | null; openFiles?: string[] };
  continuation?: "retry";
}

interface AttachmentDraft {
  path: string;
  name: string;
  kind: string;
  mimeType: string;
  sizeBytes?: number;
}

interface StartTurnResponse {
  sessionId: string;
}

type LoopCadence =
  | { kind: "minute"; n: number }
  | { kind: "hour"; minute: number }
  | { kind: "day"; time: string }
  | { kind: "week"; weekdays: number[]; time: string }
  | { kind: "month"; day: number; time: string }
  | { kind: "year"; month: number; day: number; time: string };

interface LoopView {
  id: string;
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: "agent" | "plan" | "ask";
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadenceJson: string;
  cadenceSummary: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
}

interface LoopRunRecord {
  id: string;
  loopId: string;
  sessionId: string | null;
  status: "running" | "succeeded" | "failed" | "timeout" | "skipped";
  startedAt: number;
  endedAt: number | null;
  error: string | null;
}

interface LoopsDaemonView {
  loaded: boolean;
  state: string | null;
  pid: number | null;
  plistExists: boolean;
  plistStale: boolean;
  lastError: string | null;
  heartbeatAt: number | null;
  heartbeatPid: number | null;
  daemonVersion: string | null;
  heartbeatStale: boolean;
  stoppedByUser: boolean;
  appVersion: string;
  inApp?: boolean;
}

interface LoopInputPayload {
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: "agent" | "plan" | "ask";
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadence: LoopCadence;
  enabled: boolean;
}

type QueuedPromptMode = "deferred" | "interrupt";

interface QueuedPrompt {
  id: string;
  sessionId: string;
  userText: string;
  attachments: AttachmentDraft[];
  createdAt: number;
  mode: QueuedPromptMode;
  cocoWorkId?: string;
}

interface EnqueuePromptRequest {
  sessionId: string;
  userText: string;
  attachments?: AttachmentDraft[];
  mode?: QueuedPromptMode;
  cocoWorkId?: string;
}

interface EnqueuePromptResponse {
  queued: QueuedPrompt;
  items: QueuedPrompt[];
}

interface PromptQueueMutationResponse {
  ok: boolean;
  reason?: string;
  started?: boolean;
  items: QueuedPrompt[];
}

interface StreamEvent {
  type: string;
  [key: string]: unknown;
}

interface AgentStreamPayload {
  sessionId: string;
  event: StreamEvent;
}

interface ToolApprovalRequestPayload {
  requestId: string;
  sessionId: string;
  toolName: string;
  arguments: Record<string, unknown>;
  expiresAt: number;
  risk?: ToolApprovalRisk;
}

interface ToolApprovalRisk {
  fatal: boolean;
  reason: string;
  trashRewrite: boolean;
}

interface ToolApprovalDismissPayload {
  requestId: string;
  sessionId: string;
}

interface ToolApprovalResponseRequest {
  requestId: string;
  approved: boolean;
}

interface UserAskRequestPayload {
  requestId: string;
  sessionId: string;
  toolCallId: string;
  question: string;
  options: string[];
  optionDetails?: import("../../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
}

interface UserAskDismissPayload {
  requestId: string;
  sessionId: string;
  toolCallId: string;
}

interface UserAskResponseRequest {
  requestId: string;
  selected?: string | null;
  selections?: string[] | null;
  custom?: boolean;
  comment?: string;
}

interface LogEntry {
  id: string;
  ts: number;
  level: "debug" | "info" | "warn" | "error";
  source: "main" | "renderer";
  message: string;
}

interface ToolInvocationSummaryRow {
  name: string;
  calls: number;
  success: number;
  failure: number;
}

interface ToolInvocationDailyRow {
  day: string;
  revision: number;
  calls: number;
  success: number;
  failure: number;
}

interface ToolInvocationRecord {
  id: string;
  sessionId: string;
  parentSessionId?: string;
  subagentId?: string;
  toolCallId: string;
  name: string;
  isMcp: boolean;
  mcpServerId?: string;
  status: string;
  reason: string;
  returnCode?: number;
  startedAt: number;
  durationMs: number;
  docRevision: number;
  sceneJson?: string;
  createdAt: number;
}

interface LlmTimelineRecordBase {
  id: string;
  sessionId: string;
  kind: "llm" | "tool" | "user";
  startedAt: number;
  endedAt: number | null;
  durationMs: number | null;
  error?: string;
}

interface LlmCallTimelineRecord extends LlmTimelineRecordBase {
  kind: "llm";
  purpose?: string;
  iteration?: number;
  model: string;
  stream: boolean;
  messageCount: number;
  toolDefCount: number;
  attempts: number;
  doneReason?: string;
  httpStatus?: number;
  textChars?: number;
  reasoningChars?: number;
  toolCallCount?: number;
  toolNames?: string[];
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  cacheWriteTokens?: number;
  firstEventAt?: number;
  reasoningStartAt?: number;
  reasoningEndAt?: number;
  contentStartAt?: number;
  contentEndAt?: number;
  reqRaw?: string;
  textRaw?: string;
  reasoningRaw?: string;
}

interface ToolTimelineRecord extends LlmTimelineRecordBase {
  kind: "tool";
  name: string;
  toolCallId?: string;
  status?: string;
  returnCode?: number;
  argsRaw?: string;
  resultRaw?: string;
}

interface UserTimelineRecord extends LlmTimelineRecordBase {
  kind: "user";
  label: string;
  promptRaw?: string;
}

type LlmTimelineRecord =
  | LlmCallTimelineRecord
  | ToolTimelineRecord
  | UserTimelineRecord;

interface LlmTimelineSnapshot {
  records: LlmTimelineRecord[];
  truncatedCount: number;
}

interface ProcessMetrics {
  cpuPercent: number;
  memoryMB: number;
}

interface SaveLogsResult {
  ok: boolean;
  canceled?: boolean;
  path?: string;
  error?: string;
}

interface MemoryDumpFile {
  role: "main" | "renderer";
  id: string;
  path: string;
  bytes: number;
}

interface MemoryDumpResult {
  ok: boolean;
  canceled?: boolean;
  files: MemoryDumpFile[];
  errors: string[];
}

interface StorageUsageCategory {
  files: number;
  bytes: number;
}

interface StorageUsage {
  logs: StorageUsageCategory;
  backup: StorageUsageCategory;
  caches: StorageUsageCategory;
  tmp: StorageUsageCategory;
  totalBytes: number;
}

interface CleanupResult {
  freedBytes: number;
  removedFiles: number;
  categories: StorageUsage;
}

type WorkspaceChangedPayload =
  | { type: "created"; workspace: Workspace }
  | { type: "updated"; workspace: Workspace }
  | { type: "deleted"; workspaceId: string }
  | { type: "active"; workspaceId: string | null };

interface SubagentDetailSnapshot {
  id: string;
  name: string;
  role: string;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  progressText: string;
  parentToolCallId: string;
  prompt: string;
  summary?: string;
  errorMessage?: string;
  messages: Array<{ role: string; text: string }>;
}

interface SubagentStatusSnapshot {
  id: string;
  batchId: string;
  name: string;
  role: string;
  priority: number;
  status: "queued" | "running" | "completed" | "error" | "cancelled";
  progressText: string;
  parentToolCallId: string;
  summary?: string;
  errorMessage?: string;
}

interface SubagentRunSummary extends SubagentStatusSnapshot {
  createdAt: number;
  updatedAt: number;
}

interface SubagentTranscript {
  run: SubagentRunSummary;
  messages: SessionMessage[];
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  parts: Array<{ type: string; text?: string; name?: string; [key: string]: unknown }>;
  createdAt: number;
  toolCallId?: string;
}

interface SessionMessageWindowInfo {
  firstMessageId: string | null;
  hasMore: boolean;
  remainingTurns: number;
}

interface SessionTailResult {
  session: Session;
  window: SessionMessageWindowInfo;
}

interface SessionMessageWindow extends SessionMessageWindowInfo {
  messages: SessionMessage[];
}

interface Session {
  id: string;
  title: string;
  status: SessionStatus;
  progressText: string;
  messages: SessionMessage[];
  updatedAt: number;
  contextUsage: {
    usedTokens: number;
    displayUsedTokens?: number;
    cachedTokens?: number;
    source?: "provider" | "estimate";
  };
  model?: string;
  providerId?: string;
  workspaceId?: string;
  workspacePath?: string;
  plan?: {
    id: string;
    title: string;
    status: "active" | "completed" | "cancelled";
    steps: Array<{
      id: string;
      title: string;
      status: "pending" | "in_progress" | "completed" | "cancelled";
    }>;
    createdAt: number;
    updatedAt: number;
    createToolCallId: string;
    summary?: string;
    planDoc?: {
      path: string;
      summary: string;
    };
  } | null;
  planDoc?: {
    path: string;
    summary: string;
    updatedAt: number;
    approvalPending?: boolean;
  } | null;
  phase?: string | null;
  composerRunMode?: "agent" | "ask" | "plan" | "custom" | null;
  composerFsmGraphId?: string | null;
  composerInfinite?: boolean | null;
  reasoningEffort?: ReasoningEffort | null;
  fsmLastGraphMode?: "react" | "ask" | "plan_execute" | "subagent" | null;
  fsmLastGraphId?: string | null;
  fsmLastNodeId?: string | null;
  fsmLastNodeAt?: number | null;
}

interface FsmGraphView {
  mode: "react" | "ask" | "plan_execute" | "subagent" | "custom";
  entryNodeId: string;
  terminalNodeId: string;
  nodes: Array<{
    id: string;
    name?: string;
    selfLoop: boolean;
    actionTypes: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
    when?: string;
  }>;
  graphId?: string;
  name?: string;
}

interface FsmGraphLibraryEntry {
  id: string;
  name: string;
  updatedAt: number;
  origin: "user" | "llm";
  enabled: boolean;
  validation?: import("../../agent/fsm/authoring/diagnostics.js").GraphValidation;
  draftContextId?: string;
  color?: string;
}

interface FsmGraphConfigJson {
  version: number;
  entryNodeId: string;
  terminalNodeId?: string;
  nodes: Array<{
    id: string;
    name?: string;
    pins?: Array<{ name: string }>;
    actions?: Array<{ type: string; params?: Record<string, unknown> }>;
    selfLoop?: boolean;
  }>;
  edges: Array<{
    id?: string;
    from: string;
    to: string;
    type: string;
    params?: Record<string, unknown>;
  }>;
}

interface FsmGraphLibraryRecord {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  config: FsmGraphConfigJson;
  origin: "user" | "llm";
  enabled: boolean;
  color?: string;
  validation?: import("../../agent/fsm/authoring/diagnostics.js").GraphValidation;
  draftContextId?: string;
  draftRevision?: number;
  nodeLayout?: Record<string, { x: number; y: number }>;
}

interface FsmBuiltinTemplate {
  mode: "react" | "react_v2" | "ask" | "plan_execute" | "subagent";
  label: string;
  description: string;
}

interface FsmActionCatalogEntry {
  type: string;
  title?: string;
  description?: string;
  paramsSchema: Record<string, unknown>;
}

interface ToolPermissionUpdate {
  name: string;
  displayName: string;
  description: string;
  displayDescription: string;
  defaultPermissionLevel: 0 | 1 | 2;
  permissionLevel: 0 | 1 | 2;
  offered: boolean;
  offerLocked?: boolean;
  visible: boolean;
  displayLocked?: boolean;
  callCount?: number;
}

interface ToolCatalogEntry {
  name: string;
  displayName: string;
  description: string;
  displayDescription: string;
  categoryId: string;
  defaultPermissionLevel: 0 | 1 | 2;
  permissionLevel: 0 | 1 | 2;
  offered: boolean;
  offerLocked?: boolean;
  visible: boolean;
  displayLocked?: boolean;
  callCount?: number;
}

interface ToolCategory {
  id: string;
  label: string;
  description: string;
}

interface ToolCatalogGroup {
  category: ToolCategory;
  tools: ToolCatalogEntry[];
}

interface ShellSafety {
  enabled: boolean;
  fatalPolicy: "ask" | "block";
}

interface DevModeDirEntry {
  name: string;
  path: string;
  kind: "dir" | "file";
  ext: string;
  executable?: boolean;
}

type DevModeListResult =
  | { ok: true; entries: DevModeDirEntry[] }
  | { ok: false; message: string };

type ProjectFileContentResult =
  | { ok: true; content: string; sizeBytes: number }
  | { ok: false; message: string };

type DevModeSearchResult =
  | {
      ok: true;
      files: Array<{ path: string; rel: string }>;
      truncated: boolean;
    }
  | { ok: false; message: string };

interface DevModeSearchOptions {
  limit?: number;
  deadlineMs?: number;
  listAll?: boolean;
  codeOnly?: boolean;
  includeEngine?: boolean;
  engineOnly?: boolean;
}

interface DevModeIndexChunk {
  requestId: number;
  files: Array<{ path: string; rel: string }>;
  done: boolean;
  truncated: boolean;
}

type EditorFileResult =
  | {
      ok: true;
      content: string;
      encoding: "utf8" | "utf8-bom" | "non-utf8";
      sizeBytes: number;
      mtimeMs: number;
    }
  | { ok: false; message: string };

type DevModeFsEvent = {
  rootPath: string;
  events: Array<{ path: string; kind: "add" | "change" | "unlink" }>;
};

type VcsBadge = "M" | "A" | "D" | "U" | "C";

type VcsFileDiff = {
  allAdded: boolean;
  lines: Array<{ line: number; kind: "M" | "A" }>;
  deleted: Array<{ beforeLine: number; count: number }>;
};

type VcsBlameLine = {
  line: number;
  rev: string;
  author: string;
  time: number | null;
  summary: string | null;
};

type VcsBlameResult =
  | { ok: true; kind: "git" | "svn"; lines: VcsBlameLine[] }
  | { ok: false; message: string };

type VcsFileBaseResult =
  | {
      ok: true;
      kind: "git" | "svn";
      content: string;
      tracked: boolean;
    }
  | { ok: false; message: string };

type VcsStatusResult =
  | {
      ok: true;
      vcs: "git" | "svn" | "none";
      entries: Array<{ path: string; status: VcsBadge }>;
      aheadCount: number;
      behindCount: number;
    }
  | { ok: false; message: string };

type VcsActionInput =
  | { kind: "git-stage"; paths: string[] }
  | { kind: "git-unstage"; paths: string[] }
  | { kind: "git-discard"; paths: string[] }
  | { kind: "svn-revert"; paths: string[] }
  | { kind: "svn-update"; paths: string[] };

type DevTaskRunStatus =
  | "running"
  | "done"
  | "failed"
  | "timeout"
  | "cancelled"
  | "spawn-error";

type DevTaskConfigQueryResult =
  | {
      ok: true;
      tasks: Array<{ id: string; command: string; origin?: "file" | "unreal" }>;
      unrealError?: string | null;
      debugSupported?: boolean;
      debugKind?: "unreal" | "electron" | "web" | null;
    }
  | { ok: false; message: string };

type DevTaskRunSnapshot = {
  runId: string;
  task: string;
  workspacePath: string;
  command: string;
  status: DevTaskRunStatus;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  buffer: string;
  bufferTruncated: boolean;
  progress: DevTaskProgressSnapshot | null;
  failureHint: string | null;
};

type DevTaskOutputEvent = {
  runId: string;
  task: string;
  workspacePath: string;
  stream: "stdout" | "stderr";
  text: string;
};

type UbtBuildPhase = "analyzing" | "generating" | "compiling" | "linking";

type DevTaskProgressSnapshot = {
  phase: UbtBuildPhase;
  totalActions: number | null;
  doneActions: number | null;
  currentAction: string | null;
  actionsPerSecond: number | null;
  etaMs: number | null;
};

type DevTaskProgressEvent = DevTaskProgressSnapshot & {
  runId: string;
  task: string;
  workspacePath: string;
  elapsedMs: number;
};

type DevTaskStateResult = {
  ok: true;
  active: DevTaskRunSnapshot[];
  last: Record<string, DevTaskRunSnapshot>;
  buildGate: { ok: true } | { ok: false; message: string };
};

type RunDevTaskResult =
  | { ok: true; runId: string; command: string }
  | { ok: false; message: string; runId?: string };

type DebugSourceBreakpoint = {
  path: string;
  line: number;
  condition?: string;
};
type DebugLineBreakpoint = { line: number; condition?: string };
type DebugStackFrame = {
  id: number;
  name: string;
  line: number;
  column: number;
  moduleId?: string | number;
  source?: {
    path?: string;
    name?: string;
    sourceReference?: number;
  };
};
type DebugThread = {
  id: number;
  name: string;
};
type DebugTarget = {
  id: string;
  kind: "lldb" | "node" | "chrome";
  label: string;
  status: "starting" | "running" | "stopped" | "ended";
  stoppedReason?: string;
  threadCount?: number;
};
type DebugVariable = {
  name: string;
  value: string;
  type?: string;
  variablesReference: number;
};
type DebugConsoleEntry = {
  timestamp: number;
  direction: "send" | "receive" | "error";
  text: string;
};
type DebugSnapshot = {
  workspacePath: string;
  status: "idle" | "building" | "starting" | "running" | "stopped" | "error";
  recipe?: "unreal" | "electron" | "web";
  adapterPath?: string;
  adapterVersion?: string;
  pdbModuleAllowlist?: string[];
  program?: string;
  stopped?: {
    reason?: string;
    description?: string;
    threadId?: number;
    allThreadsStopped?: boolean;
  };
  threads?: DebugThread[];
  selectedThreadId?: number;
  selectedFrameId?: number;
  stack: DebugStackFrame[];
  locals: DebugVariable[];
  error?: string;
  progressText?: string;
  console?: DebugConsoleEntry[];
  targets?: DebugTarget[];
  selectedTargetId?: string;
};

interface AppNotifyEntryView {
  id: number;
  title: string;
  body: string;
  sessionId?: string;
  createdAt: number;
  read: boolean;
}

interface AppNotifySnapshotView {
  entries: AppNotifyEntryView[];
  unreadCount: number;
  latestId?: number;
  latest?: AppNotifyEntryView;
  present?: "toast" | "popup";
}

interface JellyBotBridge {
  appName: string;
  platform: string;
  getWorkspaceSettings: () => Promise<ResolvedWorkspaceSettings>;
  getRemoteConfig: () => Promise<{ config: RemoteRelayConfig; hasKey: boolean }>;
  setRemoteConfig: (patch: Partial<RemoteRelayConfig>) => Promise<{ config: RemoteRelayConfig }>;
  syncMemoryNow: () => Promise<{ outcome: MemorySyncOutcomeSnapshot; status: MemorySyncStatusSnapshot }>;
  fullResyncMemory: () => Promise<{ outcome: MemorySyncOutcomeSnapshot; status: MemorySyncStatusSnapshot }>;
  getMemorySyncStatus: () => Promise<{ status: MemorySyncStatusSnapshot }>;
  regenerateRemoteDeviceId: () => Promise<{ config: RemoteRelayConfig }>;
  saveRemoteKey: (key: string) => Promise<{ ok: boolean; error?: string }>;
  getRemoteStatus: () => Promise<{ status: string }>;
  onRemoteStatus: (listener: (payload: { status: string; detail?: string }) => void) => () => void;
  onRemoteActivity: (listener: () => void) => () => void;
  getUpdateState: () => Promise<{
    currentVersion: string;
    platform: string;
    maintenance: UpdateMaintenanceState | null;
    check: { at: number; entry: { version: string; url: string; sha256?: string } | null; upToDate: boolean } | null;
  }>;
  checkForUpdate: (input?: { force?: boolean }) => Promise<{
    ok: boolean;
    error?: string;
    entry?: { version: string; url: string; sha256?: string } | null;
    checkedAt?: number;
    currentVersion?: string;
    upToDate?: boolean;
  }>;
  runUpdate: () => Promise<{ ok: boolean; error?: string }>;
  onUpdateState: (listener: (state: UpdateMaintenanceState) => void) => () => void;
  onLlmProvidersChanged: (listener: () => void) => () => void;
  getSettingsSnapshot: () => Promise<SettingsSnapshot>;
  saveWorkspaceSettings: (
    settings: {
      providers?: LlmProvider[];
      activeProviderId?: string;
      visionProviderId?: string | null;
      inlineCompletionProviderId?: string | null;
      imageGenProviders?: ImageGenProvider[];
      activeImageGenProviderId?: string;
      objectStorage?: ObjectStorageConfig | null;
      fullPermissionsDefault?: boolean;
      autoSkillSummarizeDefault?: boolean;
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
      themeId?: "dark" | "light";
      accentColor?: string | null;
      uiFontScale?: number;
      chatFontScale?: number;
    },
  ) => Promise<ResolvedWorkspaceSettings>;
  exportSettingsBackup: (passphrase: string) => Promise<{
    ok: boolean;
    canceled?: boolean;
    path?: string;
    sections?: string[];
    error?: string;
  }>;
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
  setActiveProvider: (providerId: string) => Promise<ResolvedWorkspaceSettings>;
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
  }) => Promise<{ ok: true; message: string } | { ok: false; message: string }>;
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
  onUsagePopupPresent: (
    handler: (payload: {
      theme?: string;
      accentColor?: string | null;
      visible: boolean;
    }) => void,
  ) => () => void;
  optimizeUserPrompt: (req: {
    text: string;
    sessionId?: string;
    providerId?: string;
  }) => Promise<{ text: string } | { error: string }>;
  completeInlineCode: (req: {
    requestId: string;
    sessionId?: string;
    providerId?: string;
    workspacePath?: string;
    languageId: string;
    fileName: string;
    prefix: string;
    suffix: string;
  }) => Promise<{ text: string }>;
  cancelInlineCode: (requestId: string) => void;
  listSessions: () => Promise<SessionSummary[]>;
  getSession: (sessionId: string) => Promise<Session | null>;
  getSessionTail: (
    sessionId: string,
    opts?: { turns?: number },
  ) => Promise<SessionTailResult | null>;
  getMessagesBefore: (
    sessionId: string,
    beforeMessageId: string,
    opts?: { turns?: number },
  ) => Promise<SessionMessageWindow | null>;
  fsmGraphConfig: (
    mode: "react" | "ask" | "plan_execute" | "subagent",
  ) => Promise<FsmGraphView | null>;
  fsmGraphViewById: (id: string) => Promise<FsmGraphView | null>;
  listFsmGraphs: () => Promise<FsmGraphLibraryEntry[]>;
  listComposerGraphs?: () => Promise<FsmGraphLibraryEntry[]>;
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
  analyzeFsmGraph: (config: FsmGraphLibraryRecord["config"]) => Promise<import("../../agent/fsm/authoring/diagnostics.js").GraphValidation>;
  commitFsmGraphDraft: (record: FsmGraphLibraryRecord) => Promise<FsmGraphLibraryRecord>;
  validateFsmGraph: (config: FsmGraphConfigJson) => Promise<{ ok: true }>;
  fsmActionCatalog: () => Promise<FsmActionCatalogEntry[]>;
  getSubagent: (
    sessionId: string,
    subagentId: string,
  ) => Promise<SubagentDetailSnapshot | null>;
  listRunningSubagents: (
    sessionId: string,
  ) => Promise<SubagentStatusSnapshot[]>;
  listSubagents: (sessionId: string) => Promise<SubagentRunSummary[]>;
  getSubagentTranscript: (
    sessionId: string,
    subagentId: string,
  ) => Promise<SubagentTranscript | null>;
  openSubagentsWindow: (sessionId: string) => Promise<{ ok: true }>;
  onSubagentsWindowSession: (
    handler: (payload: { sessionId: string }) => void,
  ) => () => void;
  searchSessions: (query: string) => Promise<SessionSearchHit[]>;
  startTurn: (req: StartTurnRequest) => Promise<StartTurnResponse>;
  setSessionProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<Session>;
  setComposerPrefs: (
    sessionId: string,
    patch: {
      runMode?: "agent" | "ask" | "plan" | "custom" | null;
      fsmGraphId?: string | null;
      infinite?: boolean | null;
      reasoningEffort?: ReasoningEffort | null;
    },
  ) => Promise<Session>;
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
  removeTurnError: (
    sessionId: string,
    messageId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
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
  takePromptRestore: (
    sessionId: string,
  ) => Promise<{ text: string; attachments: AttachmentDraft[] } | null>;
  pauseTurn: (sessionId: string) => Promise<{ ok: boolean; reason?: string }>;
  resumeTurn: (req: {
    sessionId: string;
    fullPermissions: boolean;
    autoSkillSummarize?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
  compactSession: (
    sessionId: string,
    options?: { protectTokenRatio?: number },
  ) => Promise<{
    ok: boolean;
    reason?: string;
    compacted?: boolean;
    estimatedTokens?: number;
  }>;
  clearSession: (
    sessionId: string,
  ) => Promise<{ ok: boolean; reason?: string }>;
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
  respondVcsAuth: (req: {
    requestId: string;
    credentials: { username: string; password: string } | null;
    remember: boolean;
  }) => Promise<boolean>;
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
  listWorkspaceTemplates: () => Promise<WorkspaceTemplateInfo[]>;
  inspectWorkspaceInit: (req: {
    path: string;
    templateId: WorkspaceTemplateId;
  }) => Promise<WorkspaceTemplateInitInspection>;
  createWorkspaceFromTemplate: (req: {
    templateId: WorkspaceTemplateId;
    name: string;
    path: string;
  }) => Promise<WorkspaceTemplateInitOutcome>;
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
  resolveAttachmentPaths: (paths: string[]) => Promise<AttachmentDraft[]>;
  attachmentPathForFile: (file: File) => string;
  listTools: () => Promise<ToolCatalogGroup[]>;
  getShellSafety: () => Promise<ShellSafety>;
  setShellSafety: (req: {
    enabled?: boolean;
    fatalPolicy?: "ask" | "block";
  }) => Promise<ShellSafety>;
  setToolPermissionLevel: (req: {
    name: string;
    level: 0 | 1 | 2;
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
  getSkillUsageStats: () => Promise<SkillUsageStatsRow[]>;
  listSkillRevisions: (skillId: string) => Promise<SkillRevisionEntry[]>;
  readSkillRevision: (req: { id: string; revision: number }) => Promise<SkillRevisionContent>;
  restoreSkillRevision: (req: { id: string; revision: number }) => Promise<SkillRecord>;
  setSkillDeprecated: (req: { id: string; deprecated: boolean }) => Promise<SkillRecord>;
  listSkillProposals: () => Promise<SkillProposalView[]>;
  resolveSkillProposal: (req: {
    id: string;
    decision: "accept" | "reject";
  }) => Promise<{ status: string; applied: number }>;
  getSkillCurationStatus: () => Promise<SkillCurationStatus>;
  curateSkillsNow: () => Promise<SkillCurationStatus & { ran: boolean }>;
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
  prepareCommit: (
    workspacePath: string,
    providerId?: string,
    paths?: string[],
  ) => Promise<PrepareCommitResult>;
  commitWorkspace: (req: {
    workspacePath: string;
    message: string;
    paths?: string[];
  }) => Promise<CommitResult>;
  openPath: (path: string) => Promise<string>;
  openExternal: (url: string) => Promise<boolean>;
  showItemInFolder: (path: string) => Promise<boolean>;
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
  cocoHistory: (ruleId: string, cursor?: { at: number; id: string }) => Promise<import("../../coco/types.js").CocoHistoryPage>;
  cocoSnapshot: () => Promise<import("../../coco/types.js").CocoSnapshot>;
  cocoWorkResults: (workId: string) => Promise<import("../../coco/types.js").CocoWorkResult[]>;
  cocoActivity: () => Promise<import("../../coco/activity.js").CocoActivity>;
  onCocoActivity: (handler: (activity: import("../../coco/activity.js").CocoActivity) => void) => () => void;
  onCocoChanged: (handler: () => void) => () => void;
  cocoCommand: (command: import("../../coco/types.js").CocoCommand) => Promise<import("../../coco/types.js").CocoSnapshot>;
  cocoHandoverSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  cocoTakeBackSession: (sessionId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  loopsList: () => Promise<LoopView[]>;
  loopsListRuns: (loopId: string, limit?: number) => Promise<LoopRunRecord[]>;
  loopsCreate: (loop: LoopInputPayload) => Promise<LoopView>;
  loopsUpdate: (loopId: string, loop: LoopInputPayload) => Promise<LoopView>;
  loopsDelete: (loopId: string) => Promise<boolean>;
  loopsSetEnabled: (loopId: string, enabled: boolean) => Promise<LoopView>;
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
  filterExistingFiles: (paths: string[]) => Promise<string[]>;
  listDevModeDir: (path: string) => Promise<DevModeListResult>;
  collaborativeBranch: (request: import("../../shared/collaborative.js").CollaborativeRequest) => Promise<import("../../shared/collaborative.js").CollaborativeResult>;
  onCollaborativeChanged: (listener: (payload: { workspacePath: string }) => void) => () => void;
  runDevModeExecutable: (
    path: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  readDevModeProjectFile: (path: string) => Promise<ProjectFileContentResult>;
  getDevModeEngineRoot: (rootPath: string) => Promise<string | null>;
  resolveDevModeSourcePath?: (
    rootPath: string,
    sourcePath: string,
  ) => Promise<string | null>;
  searchDevModeFiles: (
    rootPath: string,
    query: string,
    options?: DevModeSearchOptions,
  ) => Promise<DevModeSearchResult>;
  startDevModeFileIndex?: (
    rootPath: string,
    requestId: number,
    options?: DevModeSearchOptions,
  ) => Promise<{ ok: boolean; message?: string }>;
  cancelDevModeFileIndex?: () => Promise<void>;
  onDevModeIndexChunk?: (
    listener: (payload: DevModeIndexChunk) => void,
  ) => () => void;
  watchDevModePath: (
    rootPath: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  unwatchDevModePath: (rootPath: string) => Promise<{ ok: true }>;
  lookupCppSymbols: (
    rootPath: string,
    word: string,
  ) => Promise<
    Array<{
      name: string;
      kind:
        | "class"
        | "interface"
        | "struct"
        | "enum"
        | "type"
        | "function"
        | "variable";
      path: string;
      line: number;
      container?: string;
      containerChain?: string;
      params?: string;
      returnType?: string;
      isImpl?: boolean;
    }>
  >;
  completeCppSymbols: (
    rootPath: string,
    request: {
      prefix: string;
      container?: string;
      memberOf?: string;
      receiver?: string;
      chain?: string[];
      limit?: number;
    },
  ) => Promise<
    Array<{
      name: string;
      kind: "class" | "interface" | "struct" | "enum" | "type" | "function" | "variable";
      path: string;
      line: number;
      container?: string;
      params?: string;
      returnType?: string;
      isImpl?: boolean;
      depth?: number;
    }>
  >;
  findCppUsages: (
    rootPath: string,
    request: {
      queryId: string;
      word: string;
      overlay?: { path: string; text: string };
    },
  ) => Promise<{
    queryId: string;
    matches: Array<{
      path: string;
      line: number;
      column: number;
      lineText: string;
    }>;
    scannedFiles: number;
    truncated: boolean;
    cancelled?: boolean;
  }>;
  cancelCppUsageSearch: (queryId: string) => Promise<{ ok: true }>;
  onClangdProgress: (
    listener: (
      payload:
        | { rootPath: string; phase: "indexing_speed"; speed: "normal" | "full" }
        | { rootPath: string; phase: "indexing" | "idle"; percent?: number; message?: string }
        | {
            rootPath: string;
            phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready" | "generating";
            message?: string;
          }
        | { rootPath: string; phase: "file"; path: string; state: "preamble" | "parsing" | "idle" },
    ) => void,
  ) => () => void;
  clangdStatus: (rootPath: string) => Promise<{ ok: boolean; message?: string; indexingSpeed?: "normal" | "full" }>;
  clangdSetIndexingSpeed: (rootPath: string, speed: "normal" | "full") => Promise<
    { ok: true; speed: "normal" | "full" } | { ok: false; message: string }
  >;
  clangdWarmup: (rootPath: string) => Promise<{ ok: boolean; message?: string }>;
  clangdInstallLatest: () => Promise<
    { ok: true; path: string } | { ok: false; message: string }
  >;
  clangdReferences: (
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
    },
  ) => Promise<{
    ok: boolean;
    references?: Array<{
      path: string;
      line: number;
      column: number;
      endLine: number;
      endColumn: number;
    }>;
    message?: string;
  }>;
  clangdDefinition: (
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
    },
  ) => Promise<{
    ok: boolean;
    definitions?: Array<{ path: string; line: number; column: number }>;
    message?: string;
  }>;
  clangdHover: (
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
    },
  ) => Promise<{ ok: boolean; markdown?: string | null; message?: string }>;
  clangdCompletion: (
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
      triggerCharacter?: string;
    },
    queryId?: string,
  ) => Promise<{
    ok: boolean;
    items?: Array<{
      label: string;
      kind: number;
      detail?: string;
      documentation?: string;
      signature?: string;
      insertText?: string;
      isSnippet?: boolean;
      sortText?: string;
      filterText?: string;
    }>;
    isIncomplete?: boolean;
    message?: string;
  }>;
  clangdIndexComplete: (
    rootPath: string,
    request: { prefix: string; container?: string; memberOf?: string; receiver?: string; chain?: string[] },
  ) => Promise<
    Array<{
      name: string;
      kind: "class" | "interface" | "struct" | "enum" | "type" | "function" | "variable";
      path: string;
      line: number;
      container?: string;
      depth?: number;
    }>
  >;
  clangdSignatureHelp: (
    rootPath: string,
    request: {
      path: string;
      line: number;
      column?: number;
      symbol?: string;
      text?: string;
    },
  ) => Promise<{
    ok: boolean;
    signatures?: Array<{
      label: string;
      activeParameter: number;
      parameters: string[];
      documentation?: string;
      parameterDocumentation?: string[];
    }>;
    activeSignature?: number;
    message?: string;
  }>;
  clangdDocChanged: (
    rootPath: string,
    path: string,
    text: string,
  ) => Promise<{ ok: true }>;
  clangdDocClosed: (rootPath: string, path: string) => Promise<{ ok: true }>;
  clangdIncludeDirs: (
    rootPath: string,
    filePath: string,
  ) => Promise<{ ok: true; dirs: string[] } | { ok: false; message: string }>;
  clangdLogInclude: (entry: Record<string, unknown>) => Promise<{ ok: true }>;
  onCppSymbolProgress: (
    listener: (payload: {
      rootPath: string;
      phase: "scanning" | "idle";
      filesDone: number;
      filesTotal: number;
    }) => void,
  ) => () => void;
  getCppSymbolExtraRoots: (
    rootPath: string,
  ) => Promise<
    { ok: true; extraRoots: string[] } | { ok: false; message: string }
  >;
  addCppSymbolExtraRoot: (
    rootPath: string,
    dirPath: string,
  ) => Promise<
    | { ok: true; extraRoots: string[]; restarted: boolean; message?: string }
    | { ok: false; message: string }
  >;
  removeCppSymbolExtraRoot: (
    rootPath: string,
    dirPath: string,
  ) => Promise<
    | { ok: true; extraRoots: string[]; restarted: boolean; message?: string }
    | { ok: false; message: string }
  >;
  readFileForEditor: (path: string) => Promise<EditorFileResult>;
  writeTextFile: (
    path: string,
    content: string,
    addBom: boolean,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  onDevModeFsEvent: (
    listener: (payload: DevModeFsEvent) => void,
  ) => () => void;
  onVcsChanged: (
    listener: (payload: { rootPath: string }) => void,
  ) => () => void;
  onAppearanceChanged: (
    listener: (payload: {
      themeId: string;
      accentColor: string | null;
      uiFontScale?: number;
      chatFontScale?: number;
    }) => void,
  ) => () => void;
  setUiZoomFactor: (factor: number) => void;
  getVcsStatus: (rootPath: string) => Promise<VcsStatusResult>;
  getVcsFileDiff: (
    rootPath: string,
    absPath: string,
  ) => Promise<
    { ok: true; diff: VcsFileDiff } | { ok: false; message: string }
  >;
  getVcsFileBase: (
    rootPath: string,
    absPath: string,
  ) => Promise<VcsFileBaseResult>;
  annotateFile: (
    rootPath: string,
    absPath: string,
  ) => Promise<VcsBlameResult>;
  runVcsAction: (
    rootPath: string,
    action: VcsActionInput,
  ) => Promise<{ ok: boolean; message?: string }>;
  revealPath: (path: string) => Promise<{ ok: boolean }>;
  getDevTaskConfig: (
    workspacePath: string,
  ) => Promise<DevTaskConfigQueryResult>;
  getUnrealWorkspace: (workspacePath: string, refresh?: boolean) => Promise<import("../../unreal/workspaceTypes.js").UnrealWorkspaceResult>;
  selectUnrealBuild: (workspacePath: string, id: string) => Promise<import("../../unreal/workspaceTypes.js").UnrealWorkspaceResult>;
  runUnreal: (workspacePath: string, id: string) => Promise<RunDevTaskResult>;
  buildUnreal: (workspacePath: string, id: string, operation?: "build" | "rebuild" | "clean") => Promise<RunDevTaskResult>;
  runDevTask: (
    workspacePath: string,
    task: string,
  ) => Promise<RunDevTaskResult>;
  stopDevTask: (runId: string) => Promise<{ ok: boolean }>;
  getDevTaskState: (workspacePath: string) => Promise<DevTaskStateResult>;
  startDebug: (request: {
    buildId?: string;
    workspacePath: string;
    breakpoints: DebugSourceBreakpoint[];
    autoBuild?: boolean;
  }) => Promise<
    | { ok: true; snapshot: DebugSnapshot }
    | { ok: false; message: string; cancelled?: true }
  >;
  setDebugBreakpoints: (
    path: string,
    breakpoints: DebugLineBreakpoint[],
  ) => Promise<{ ok: boolean; message?: string }>;
  runDebugCommand: (
    command: "pause" | "continue" | "next" | "stepIn" | "stepOut" | "stop",
  ) => Promise<{ ok: boolean; message?: string }>;
  selectDebugThread: (
    threadId: number,
  ) => Promise<{ ok: boolean; message?: string }>;
  selectDebugTarget: (
    targetId: string,
  ) => Promise<{ ok: boolean; message?: string }>;
  selectDebugFrame: (
    frameId: number,
  ) => Promise<{ ok: boolean; message?: string; frame?: DebugStackFrame }>;
  evaluateDebugExpression: (
    expression: string,
    frameId: number,
  ) => Promise<
    | {
        ok: true;
        result: string;
        type?: string;
        variablesReference: number;
      }
    | { ok: false; message: string }
  >;
  getDebugVariables: (
    variablesReference: number,
  ) => Promise<
    | { ok: true; variables: DebugVariable[] }
    | { ok: false; message: string }
  >;
  getDebugState: () => Promise<DebugSnapshot>;
  onDebugState: (listener: (snapshot: DebugSnapshot) => void) => () => void;
  onDevModeRequest: (
    listener: (payload: {
      id: number;
      op: string;
      payload: Record<string, unknown>;
    }) => void,
  ) => () => void;
  replyDevModeRequest: (
    id: number,
    result: { ok: boolean; message?: string; data?: unknown },
  ) => void;
  onDebugOutput: (
    listener: (payload: {
      workspacePath: string;
      entries: DebugConsoleEntry[];
    }) => void,
  ) => () => void;
  onDevTaskOutput: (
    listener: (payload: DevTaskOutputEvent) => void,
  ) => () => void;
  onDevTaskProgress: (
    listener: (payload: DevTaskProgressEvent) => void,
  ) => () => void;
  onDevTaskExit: (
    listener: (payload: DevTaskRunSnapshot) => void,
  ) => () => void;
  pushWorkspace: (
    workspacePath: string,
  ) => Promise<{ ok: boolean; message?: string; output?: string }>;
  pullWorkspace: (
    workspacePath: string,
  ) => Promise<{
    ok: boolean;
    updated?: boolean;
    conflicts?: string[];
    message?: string;
    output?: string;
  }>;
  abortWorkspaceMerge: (
    workspacePath: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  backgroundFetchWorkspace: (
    workspacePath: string,
  ) => Promise<{ ok: boolean }>;
  getFooterVcsTargets: (
    workspacePath: string,
  ) => Promise<{ svn: boolean; gitRoot: string | null }>;
  getGitBehindCount: (
    workspacePath: string,
  ) => Promise<{ behindCount: number }>;
  svnUpdateAvailable: (
    workspacePath: string,
  ) => Promise<{ available: boolean }>;
  getProcessMetrics: () => Promise<ProcessMetrics>;
  getRecentLogs: () => Promise<LogEntry[]>;
  getToolStatsSummary: (req?: {
    sessionId?: string;
  }) => Promise<ToolInvocationSummaryRow[]>;
  getToolStatsDaily: (req?: {
    name?: string;
    sessionId?: string;
  }) => Promise<ToolInvocationDailyRow[]>;
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
  getFullRequestLog: () => Promise<boolean>;
  setFullRequestLog: (enabled: boolean) => Promise<boolean>;
  openLogsFolder: () => Promise<{
    ok: boolean;
    path?: string;
    error?: string;
  }>;
  saveLogsToFile: (content: string) => Promise<SaveLogsResult>;
  dumpMemory: () => Promise<MemoryDumpResult>;
  getStorageUsage: () => Promise<StorageUsage>;
  cleanupStorage: () => Promise<CleanupResult>;
  terminalRun: (req: {
    command: string;
    cwd: string;
  }) => Promise<{ runId: string }>;
  terminalCancel: (runId: string) => Promise<{ ok: boolean }>;
  windowControls: {
    minimize: () => Promise<{ ok: boolean }>;
    toggleMaximize: () => Promise<{ ok: boolean; maximized: boolean }>;
    close: () => Promise<{ ok: boolean }>;
  };
  onWindowMaximizeChanged: (
    handler: (payload: { maximized: boolean }) => void,
  ) => () => void;
  onWindowCloseRequest: (handler: () => void) => () => void;
  onEditorGoToDefinition: (handler: () => void) => () => void;
  onEditorFindUsages: (handler: () => void) => () => void;
  speechStart: () => Promise<void>;
  speechStop: () => Promise<{
    text: string;
    lang: "ZH" | "EN" | null;
  }>;
  onSpeechEvent: (
    handler: (event: SpeechHelperEvent) => void,
  ) => () => void;
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
  onDiagnosticLog: (handler: (entry: LogEntry) => void) => () => void;
  onAgentStream: (handler: (payload: AgentStreamPayload) => void) => () => void;
  onSessionUpdated: (handler: (summary: SessionSummary) => void) => () => void;
  llmTimelineList: (sessionId: string) => Promise<LlmTimelineSnapshot>;
  onLlmTimelineUpdated: (
    handler: (payload: { sessionId: string }) => void,
  ) => () => void;
  onNotificationCenterEvent: (
    handler: (payload: { eventName: string; params: unknown }) => void,
  ) => () => void;
  onSessionDeleted: (handler: (payload: { id: string }) => void) => () => void;
  onWorkspaceChanged: (
    handler: (payload: WorkspaceChangedPayload) => void,
  ) => () => void;
  onToolApproval: (
    handler: (payload: ToolApprovalRequestPayload) => void,
  ) => () => void;
  onVcsAuthRequest: (
    handler: (payload: {
      requestId: string;
      vcs: "git" | "svn";
      context: string;
      operation: string;
      detail?: string;
      defaultUsername?: string;
    }) => void,
  ) => () => void;
  onToolApprovalDismiss: (
    handler: (payload: ToolApprovalDismissPayload) => void,
  ) => () => void;
  onUserAsk: (handler: (payload: UserAskRequestPayload) => void) => () => void;
  onUserAskDismiss: (
    handler: (payload: UserAskDismissPayload) => void,
  ) => () => void;
  onCelebration: (
    handler: (payload: { source: "task" | "f12" }) => void,
  ) => () => void;
  onMenubarAction: (
    handler: (payload: {
      action: "new-task" | "loop" | "settings";
    }) => void,
  ) => () => void;
  onAppNotify: (
    handler: (snapshot: AppNotifySnapshotView) => void,
  ) => () => void;
  getNotifyLedger: () => Promise<AppNotifySnapshotView>;
  markNotifyRead: (req: {
    id?: number;
    all?: boolean;
  }) => Promise<AppNotifySnapshotView>;
  clearNotifyLedger: () => Promise<AppNotifySnapshotView>;
  notifyPopupAction: (
    id: number,
    action: "activate" | "dismiss",
  ) => Promise<void>;
  onNotifyActivate: (
    handler: (payload: { sessionId?: string }) => void,
  ) => () => void;
}

interface Window {
  jellybot?: JellyBotBridge;
}

declare module "monaco-editor/languages/definitions/cpp/cpp.js" {
  export const conf: {
    comments: unknown;
    brackets: unknown[];
    autoClosingPairs: unknown[];
    surroundingPairs: unknown[];
    [key: string]: unknown;
  };
  export const language: {
    defaultToken: string;
    tokenPostfix: string;
    brackets: Array<{ open: string; close: string; token: string }>;
    keywords: string[];
    operators: string[];
    symbols: string;
    escapes: string;
    integersuffix: string;
    floatsuffix: string;
    tokenizer: {
      root: unknown[];
      [state: string]: unknown[];
    };
    [key: string]: unknown;
  };
}
