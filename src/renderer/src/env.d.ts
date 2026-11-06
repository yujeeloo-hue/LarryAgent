/// <reference types="vite/client" />

/** `paused`: graceful /pause stop; resumable via /resume. */
type SessionStatus =
  | "idle"
  | "running"
  | "paused"
  | "completed"
  | "error"
  | "cancelled";

/** Push-to-talk helper events streamed over the speech:event channel. */
type SpeechHelperEvent =
  | { type: "waiting"; message: string }
  | { type: "ready" }
  | { type: "partial"; text: string; lang: "ZH" | "EN" }
  | { type: "level"; value: number }
  | { type: "final"; text: string; lang: "ZH" | "EN" }
  | { type: "error"; message: string };

/** Remote relay bridge config (Settings → Remote Control). */
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
/**
 * Local update pipeline state (mirror of the main-side maintenance engine —
 * same shape the relay console renders for remote devices).
 */
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
  /** Explicit override for tool-result images (read_image direct). */
  toolRoleImages?: boolean;
}

/**
 * Composer reasoning-effort dial level (renderer mirror of
 * src/llm/reasoningEffort.ts). "off" maps onto provider thinking-disable
 * switches; "low"/"medium"/"high"/"max" ride reasoning_effort (Kimi/GLM
 * hosts clamp "medium" → "high" client-side).
 */
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
  /** Explicit watermark body field; omit = provider default (not sent). */
  watermark?: boolean;
  /** Input-image encoding for generate_image; omit = disabled. */
  imageInput?: "base64" | "url";
}

interface ResolvedWorkspaceSettings {
  providers: LlmProvider[];
  activeProviderId: string;
  visionProviderId: string | null;
  imageGenProviders: ImageGenProvider[];
  activeImageGenProviderId: string;
  objectStorage: ObjectStorageConfig | null;
  fullPermissionsDefault: boolean;
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
  /** Chat request headers-wait timeout (ms). Default 30_000. */
  llmRequestTimeoutMs: number;
  activeWorkspaceId: string | null;
  debugAdapterPath: string | null;
  environmentContext: EnvironmentContextFlags;
  userMemoryAutoExtract: boolean;
  projectMemoryAutoExtract: boolean;
  toolStatsEnabled: boolean;
  themeId: "dark" | "light";
  /** Highlight color override; null/omitted = Auto (theme default). */
  accentColor?: string | null;
  /** Interface text scale (whole-UI zoom); 1 = 100%. */
  uiFontScale: number;
  /** Conversation text scale (`--chat-fs-scale`); 1 = 100%. */
  chatFontScale: number;
}

interface EnvironmentContextFlags {
  workspace: boolean;
  timezone: boolean;
  locale: boolean;
  location: boolean;
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
}

interface SkillRecord {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  body: string;
  path: string;
  directory: string;
  files: string[];
}

interface SkillUpsertInput {
  id?: string;
  name: string;
  description: string;
  body: string;
  enabled: boolean;
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
  /** Commits on HEAD not on the upstream branch; 0 when none/no upstream. */
  aheadCount: number;
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
  /** "llm" when the draft was model-generated; "fallback" placeholder otherwise. */
  messageSource: "llm" | "fallback";
  stats: WorkingTreeStats;
}

interface CommitResult {
  ok: true;
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  /** Which VCS produced this commit — drives UI wording (commit vs revision). */
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

/** Provider setup wizard: models discovered on a gateway, or why not. */
type LlmProbeModelsResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: string };

interface ProviderBalanceResult {
  providerId: string;
  text: string | null;
}

/* ---- Tray usage popup (mirrors src/llm/usage/types.ts) ---- */

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

/** Tray usage popup footer/window actions (fire-and-forget send). */
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
  /** Provenance; "coco" rows were created by CoCo's coco_workspace tool. */
  origin: "user" | "coco";
  createdAt: number;
  updatedAt: number;
}

/* ---- New-workspace templates (mirrors src/workspace/templates.ts) ---- */

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
  /** Origin marker; only non-'app' sources are exposed. */
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
  /** Chat LLM for a new session; omitted → settings default for new tasks. */
  providerId?: string;
  /** Explicit title for a new session; omitted → heuristic from prompt. */
  title?: string;
  userText: string;
  fullPermissions: boolean;
  /** Composer: auto-summarize skills after eligible Turns. */
  autoSkillSummarize?: boolean;
  /** Composer run mode: agent | ask | plan | custom. */
  runMode?: "agent" | "ask" | "plan" | "custom";
  /** Library FSM graph id when runMode is custom. */
  fsmGraphId?: string;
  /** @deprecated Prefer runMode. */
  planMode?: boolean;
  /** Composer reasoning-effort dial level (pinned onto a new session row). */
  reasoningEffort?: ReasoningEffort;
  /** Composer Infinite for a new session (pinned onto the row). */
  composerInfinite?: boolean;
  attachments?: AttachmentDraft[];
  /**
   * Retry-click continuation: userText is a hidden "continue the task"
   * instruction — model-facing, hidden from every conversation UI. The
   * renderer must not append an optimistic user row for this turn.
   */
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

/** Loop scheduling definition (mirror of src/loops/schedule.ts Cadence). */
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
  /** User pressed Stop — auto paths (ensure/repair) must not resurrect. */
  stoppedByUser: boolean;
  appVersion: string;
  /**
   * Windows Phase 1: scheduling runs inside this app process (resident
   * tray); the launchd-specific fields are inert when true.
   */
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

/**
 * `deferred` — waits for the whole turn, then starts a new turn.
 * `interrupt` — armed by the user; aborts the in-flight stream and lands at
 * the running turn's next round boundary (armed items merge into one insert).
 */
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
  /** Promote on an idle session started a turn instead of arming. */
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
  /** Epoch ms when the auto-deny timer fires. */
  expiresAt: number;
  /** Shell Safe Mode risk context for the approval card, when present. */
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
  sceneJson?: string;
  createdAt: number;
}

interface LlmTimelineRecordBase {
  id: string;
  sessionId: string;
  kind: "llm" | "tool" | "user";
  startedAt: number;
  /** null while the call is in flight. */
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

/** Minimal Session shape used by the conversation UI. */
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

/** Subagents window list item: status snapshot + ordering timestamps. */
interface SubagentRunSummary extends SubagentStatusSnapshot {
  createdAt: number;
  updatedAt: number;
}

/** Raw Message[] transcript for one run (Subagents window rendering). */
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

/** Progressive conversation load: window info shared by tail + page loads. */
interface SessionMessageWindowInfo {
  /** First message id of the window — cursor for the next older page. */
  firstMessageId: string | null;
  /** Visible messages exist above this window (offer "load earlier"). */
  hasMore: boolean;
  /** Turn starts remaining above the window (sentinel label). */
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
  /** Latest multi-step plan (persisted). */
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
    /** Link to the docs/plans/ doc this plan belongs to (path + summary). */
    planDoc?: {
      path: string;
      summary: string;
    };
  } | null;
  /** Plan markdown doc pointer (docs/plans/). */
  planDoc?: {
    path: string;
    summary: string;
    updatedAt: number;
    /** Presentation: show Approve | Discard. */
    approvalPending?: boolean;
  } | null;
  /** Plan-mode gate: drafting | review | executing (agent resume; not UI chrome). */
  phase?: string | null;
  /** Per-session composer prefs (null = follow settings.json default). */
  composerRunMode?: "agent" | "ask" | "plan" | "custom" | null;
  composerFsmGraphId?: string | null;
  composerInfinite?: boolean | null;
  /** Reasoning-effort dial level (null = follow settings.json default). */
  reasoningEffort?: ReasoningEffort | null;
  /** Per-session Turn Handoff gate (null/false = disabled; schema v20). */
  handoffEnabled?: boolean | null;
  /** Last FSM state actually executed (DevTools FSM tab; null = never ran). */
  fsmLastGraphMode?: "react" | "ask" | "plan_execute" | "subagent" | null;
  fsmLastGraphId?: string | null;
  fsmLastNodeId?: string | null;
  fsmLastNodeAt?: number | null;
}

/** Serialized FSM topology for the DevTools FSM Graph tab (main fsmGraphView). */
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
  /** Present when mode is custom. */
  graphId?: string;
  name?: string;
}

interface FsmGraphLibraryEntry {
  id: string;
  name: string;
  updatedAt: number;
  origin: "user" | "llm";
  enabled: boolean;
  /** Identity color `#rrggbb` (absent → default violet). */
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
  /** Identity color `#rrggbb` (absent → default violet). */
  color?: string;
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
  /** Launchable from the tree (win: ext whitelist · posix: exec bit). */
  executable?: boolean;
}

type DevModeListResult =
  | { ok: true; entries: DevModeDirEntry[] }
  | { ok: false; message: string };

/** devmode:readProjectFile — project/solution file text for tree building. */
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

/** devmode:searchFiles tuning — source-first walk needs knobs per caller. */
interface DevModeSearchOptions {
  /** Result cap (server-clamped to 60000). */
  limit?: number;
  /** Hard wall for the walk (server-clamped to 30000); 0 disables it. */
  deadlineMs?: number;
  /** Return everything, ignoring the query (file-picker cache). */
  listAll?: boolean;
  /** Drop asset binaries (images, .uasset, archives) from results. */
  codeOnly?: boolean;
  /** Walk `<root>/Engine` too, when the workspace is a source-built engine. */
  includeEngine?: boolean;
  /** Walk only the engine tree, skipping the project root (disjoint pass). */
  engineOnly?: boolean;
}

/** One streamed batch of a file-index walk (`startDevModeFileIndex`). */
interface DevModeIndexChunk {
  requestId: number;
  files: Array<{ path: string; rel: string }>;
  /** Final message of the walk; `files` may be empty. */
  done: boolean;
  /** Set on the final message when the walk hit a budget. */
  truncated: boolean;
}

type EditorFileResult =
  | {
      ok: true;
      content: string;
      /** utf8 · utf8-bom (BOM stripped, re-added on save) · non-utf8 (read-only). */
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
  /** Untracked new file — highlight every line as added. */
  allAdded: boolean;
  lines: Array<{ line: number; kind: "M" | "A" }>;
  /** Deleted block anchored to the new-file line it precedes. */
  deleted: Array<{ beforeLine: number; count: number }>;
};

/** One annotated line (git blame / svn blame). */
type VcsBlameLine = {
  line: number;
  /** Full git hash (all-zero = uncommitted) or SVN revision ("M" = local). */
  rev: string;
  author: string;
  /** Epoch seconds; null when the VCS did not report a date. */
  time: number | null;
  /** Full commit message (subject + body) for Git or SVN when available. */
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
      /** Absolute posix paths — main resolves repo-root vs cwd-relative. */
      entries: Array<{ path: string; status: VcsBadge }>;
      /** Commits on HEAD not on upstream; 0 when none/no upstream. */
      aheadCount: number;
    }
  | { ok: false; message: string };

type VcsActionInput =
  | { kind: "git-stage"; paths: string[] }
  | { kind: "git-unstage"; paths: string[] }
  | { kind: "git-discard"; paths: string[] }
  | { kind: "svn-revert"; paths: string[] }
  | { kind: "svn-update"; paths: string[] };

/** Dev Mode task run lifecycle (`.larry/tasks.json` Build/Run buttons). */
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

/** UBT build phase parsed from stdout ([n/m] action lines etc.). */
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
    /** Set when the adapter returns disassembly instead of a source file. */
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
  /** Stack frame whose locals are in `locals` (defaults to the top frame). */
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
  /**
   * Full content of the `latestId` entry — transient notifications are not
   * in `entries`, so the toast reads its card from here.
   */
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
  /** Settings → Update card: snapshot for the initial render (main-side TTL cache). */
  getUpdateState: () => Promise<{
    currentVersion: string;
    platform: string;
    maintenance: UpdateMaintenanceState | null;
    check: { at: number; entry: { version: string; url: string; sha256?: string } | null; upToDate: boolean } | null;
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
  getSettingsSnapshot: () => Promise<SettingsSnapshot>;
  saveWorkspaceSettings: (
    settings: {
      /** Omit to leave disk providers unchanged (Agent / other card autosaves). */
      providers?: LlmProvider[];
      activeProviderId?: string;
      visionProviderId?: string | null;
      imageGenProviders?: ImageGenProvider[];
      activeImageGenProviderId?: string;
      objectStorage?: ObjectStorageConfig | null;
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
      themeId?: "dark" | "light";
      /** null/"auto" clears the override (Auto). */
      accentColor?: string | null;
      /** Interface text scale (whole-UI zoom); 1 = 100%. */
      uiFontScale?: number;
      /** Conversation text scale (`--chat-fs-scale`); 1 = 100%. */
      chatFontScale?: number;
    },
  ) => Promise<ResolvedWorkspaceSettings>;
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
  /** Resident panel reveal/hide from main (theme + refresh on reveal). */
  onUsagePopupPresent: (
    handler: (payload: {
      theme?: string;
      accentColor?: string | null;
      visible: boolean;
    }) => void,
  ) => () => void;
  /** Composer `/opt`: one-shot LLM polish of the prompt text before sending. */
  optimizeUserPrompt: (req: {
    text: string;
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
  fsmGraphViewById: (id: string) => Promise<FsmGraphView | null>;
  listFsmGraphs: () => Promise<FsmGraphLibraryEntry[]>;
  /** Composer graph picker: read-only built-ins (Auto V2) + enabled library graphs. */
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
  validateFsmGraph: (config: FsmGraphConfigJson) => Promise<{ ok: true }>;
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
  /** New-workspace template flow (menu → scaffold → progress → register). */
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
  /** Drag-and-drop support: validate dropped absolute paths into drafts. */
  resolveAttachmentPaths: (paths: string[]) => Promise<AttachmentDraft[]>;
  /** Electron-safe replacement for the removed File.path (drag-and-drop). */
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
  /** Keep only the paths that exist and are regular files. */
  filterExistingFiles: (paths: string[]) => Promise<string[]>;
  // Dev Mode (plan: dev-mode-v1)
  listDevModeDir: (path: string) => Promise<DevModeListResult>;
  /** Launch a tree executable the way the OS shell would on double-click. */
  runDevModeExecutable: (
    path: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  /** Read a .vcxproj/.csproj/.sln (12MB cap) for outline project parsing. */
  readDevModeProjectFile: (path: string) => Promise<ProjectFileContentResult>;
  /** Unreal engine source root for a workspace, or null when there is none. */
  getDevModeEngineRoot: (rootPath: string) => Promise<string | null>;
  /** Map a DAP/build-machine source path to a local project or Engine file. */
  resolveDevModeSourcePath?: (
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
  startDevModeFileIndex?: (
    rootPath: string,
    requestId: number,
    options?: DevModeSearchOptions,
  ) => Promise<{ ok: boolean; message?: string }>;
  /** Supersede this window's in-flight index walk. */
  cancelDevModeFileIndex?: () => Promise<void>;
  onDevModeIndexChunk?: (
    listener: (payload: DevModeIndexChunk) => void,
  ) => () => void;
  watchDevModePath: (
    rootPath: string,
  ) => Promise<{ ok: true } | { ok: false; message: string }>;
  unwatchDevModePath: (rootPath: string) => Promise<{ ok: true }>;
  /** Definitions for one identifier from the workspace C++ symbol database. */
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
  /** Text-index completion (own class → bases → globals). */
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
  /** clangd start / per-file build / background-index progress. Returns an unsubscribe function. */
  onClangdProgress: (
    listener: (
      payload:
        | { rootPath: string; phase: "indexing" | "idle"; percent?: number; message?: string }
        | {
            rootPath: string;
            phase: "starting" | "ready" | "failed" | "index_loading" | "index_ready";
            message?: string;
          }
        | { rootPath: string; phase: "file"; path: string; state: "preamble" | "parsing" | "idle" },
    ) => void,
  ) => () => void;
  /** clangd semantic engine (Unreal workspaces with compile_commands.json). */
  clangdStatus: (rootPath: string) => Promise<{ ok: boolean; message?: string }>;
  clangdWarmup: (rootPath: string) => Promise<{ ok: boolean; message?: string }>;
  clangdDownload: () => Promise<
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
  /** Members from clangd's persistent index (works while the preamble builds). */
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
  /** Background C++ symbol scan progress. Returns an unsubscribe function. */
  onCppSymbolProgress: (
    listener: (payload: {
      rootPath: string;
      phase: "scanning" | "idle";
      filesDone: number;
      filesTotal: number;
    }) => void,
  ) => () => void;
  /** User-added C++ symbol-index scan roots (engine dirs, …). */
  getCppSymbolExtraRoots: (
    rootPath: string,
  ) => Promise<
    { ok: true; extraRoots: string[] } | { ok: false; message: string }
  >;
  /** Add a directory (e.g. engine sources) to the symbol-index scan. */
  addCppSymbolExtraRoot: (
    rootPath: string,
    dirPath: string,
  ) => Promise<
    | { ok: true; extraRoots: string[]; restarted: boolean; message?: string }
    | { ok: false; message: string }
  >;
  /** Remove the scan root covering a directory; symbols prune on rescan. */
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
  /** VCS badge status (git/svn status only — no diff, no content reads). */
  getVcsStatus: (rootPath: string) => Promise<VcsStatusResult>;
  /** Per-file line marks for the editor gutter (clean files: no spawn). */
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
  /** Annotate (blame) a versioned file — gutter labels next to line numbers. */
  annotateFile: (
    rootPath: string,
    absPath: string,
  ) => Promise<VcsBlameResult>;
  /** Stage/unstage/discard/revert/update — destructive ones need a confirm first. */
  runVcsAction: (
    rootPath: string,
    action: VcsActionInput,
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
  startDebug: (request: {
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
  /** Open one call-stack frame: locals follow the picked frame. */
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
  onDebugOutput: (
    listener: (payload: {
      workspacePath: string;
      entries: DebugConsoleEntry[];
    }) => void,
  ) => () => void;
  onDevTaskOutput: (
    listener: (payload: DevTaskOutputEvent) => void,
  ) => () => void;
  /** UBT build progress frames (throttled; phase changes flush). */
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
  getFullRequestLog: () => Promise<boolean>;
  setFullRequestLog: (enabled: boolean) => Promise<boolean>;
  openLogsFolder: () => Promise<{
    ok: boolean;
    path?: string;
    error?: string;
  }>;
  saveLogsToFile: (content: string) => Promise<SaveLogsResult>;
  getStorageUsage: () => Promise<StorageUsage>;
  cleanupStorage: () => Promise<CleanupResult>;
  terminalRun: (req: {
    command: string;
    cwd: string;
  }) => Promise<{ runId: string }>;
  terminalCancel: (runId: string) => Promise<{ ok: boolean }>;
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
  onEditorFindUsages: (handler: () => void) => () => void;
  /** Push-to-talk transcription (macOS speech helper). */
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
  /** VCS credential prompt (annotate/push auth failure → ask + retry). */
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
    handler: (snapshot: AppNotifySnapshotView) => void,
  ) => () => void;
  getNotifyLedger: () => Promise<AppNotifySnapshotView>;
  markNotifyRead: (req: {
    id?: number;
    all?: boolean;
  }) => Promise<AppNotifySnapshotView>;
  /** Clear every ledger entry (inbox "Clear all" chip). */
  clearNotifyLedger: () => Promise<AppNotifySnapshotView>;
  /** Background popup card actions (activate = click, dismiss = X). */
  notifyPopupAction: (
    id: number,
    action: "activate" | "dismiss",
  ) => Promise<void>;
  /** Notification click → open its session (main → renderer). */
  onNotifyActivate: (
    handler: (payload: { sessionId?: string }) => void,
  ) => () => void;
}

interface Window {
  jellybot?: JellyBotBridge;
}

/**
 * Stock Monarch cpp definition used by the Unreal C++ language pack. The
 * package exports map resolves `monaco-editor/*` → `esm/vs/*`, and this
 * module ships no type declarations (only register.d.ts in that folder).
 */
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
