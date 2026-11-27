import { SessionTurnLifecycles, unfinishedTurnEffects, type SessionTurnStopReason, type SessionTurnLifecycle } from "../session/turnLifecycle.js";
import { cocoRetentionSlice, retainedCocoMessages, type CocoRetentionSlice } from "../session/cocoRetention.js";
import { execShellProcess } from "../tools/shellExec.js";
import { mcpManager } from "../mcp/manager.js";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HandoffLoginStore } from "./handoffLoginStore.js";
import type { HandoffPasswordStatus, HandoffPasswordSubmission } from "../shared/askUser.js";
import { cocoSourceForAccess, getCocoExecution } from "../coco/executionAccess.js";
import { hostAdapter } from "../host/adapter.js";
import {
  detectInitPlan,
  isTemplateInitRequest,
  runWorkspaceTemplateInit,
  type TemplateInitInspection,
  type TemplateInitOutcome,
  type WorkspaceInitProgress,
} from "./workspaceInit.js";
import {
  listWorkspaceTemplateInfos,
  isWorkspaceTemplateId,
  type WorkspaceTemplateId,
  type WorkspaceTemplateInfo,
} from "../workspace/templates.js";
import { ensureDevTasksConfig } from "../workspace/taskConfigSuggest.js";
import { emitWorkspaceLifecycle } from "../workspace/events.js";
import {
  rollbackCancelledTurnPrompt,
  type PromptRestorePayload,
} from "./cancelRollback.js";
import { consumeTurnErrorMessage } from "./turnErrorConsume.js";
import { runAgentTurn, createRoleLlmBinding, createUniformRoleLlmBundle } from "../agent/index.js";
import { sealOrphanToolCallsInSession } from "../agent/sealOrphanToolCalls.js";
import {
  composerRunModeFromRequest,
} from "../agent/turnOptionsResolver.js";
import { workflowModeFromComposerRunMode } from "../agent/workflow/resolveWorkflowMode.js";
import { getSubagentManager } from "../agent/subagents/index.js";
import type {
  SubagentRunSummary,
  SubagentTranscript,
} from "../agent/subagents/types.js";
import {
  appendAskUserToolResult,
  cancelAskUserToolCall,
  type SessionPendingUserAsk,
} from "../session/pendingUserAsk.js";
import { resolveAskAwait } from "../session/headlessAsk.js";
import type {
  EnvironmentLocaleSnapshot,
} from "../agent/environmentContext.js";
import { buildRepoSnapshot } from "../agent/repoSnapshot.js";
import {
  toSessionSummary,
  type CreateWorkspaceRequest,
  type SessionSummary,
  type StartTurnRequest,
  type StartTurnResponse,
  type ComposerRunMode,
  type CocoChatPrompt,
  type EnqueuePromptRequest,
  type EnqueuePromptResponse,
  type PromptQueueMutationResponse,
  type QueuedPrompt,
  type QueuedPromptMode,
  type ToolApprovalRequestPayload,
  type ToolApprovalResponseRequest,
  type UpdateWorkspaceRequest,
  type UserAskRequestPayload,
  type UserAskResponseRequest,
} from "../agent/ipcTypes.js";
import {
  demoteArmedOnTurnEnd,
  enqueuePrompt as enqueueIntoQueue,
  hasArmedInterrupt,
  moveQueuedToFront,
  normalizeQueuedPromptMode,
  promptQueueDrainDecision,
  removeQueued,
  setQueuedMode,
  takeArmedInterrupts,
  updateQueuedText,
} from "./promptQueue.js";
import {
  searchSessionsInMemory,
  type SessionSearchHit,
} from "../agent/searchSessions.js";
import { readApiKeyFromStore } from "../llm/credentials.js";
import { createMemorySync, type MemorySync } from "../memorySync/memorySyncEngine.js";
import { ensureDeviceId } from "../remote/remoteBridge.js";
import {
  chatProviderAcceptsImageUrls,
  chatProviderUsesBase64Images,
  chatProviderUsesProviderFiles,
  embedImageAttachmentsBase64,
  uploadImageAttachments,
} from "../objectStorage/uploadAttachments.js";
import { resolveToolRoleImageSupport } from "../settings/toolRoleImageDefaults.js";
import { buildObjectKey, putObject } from "../objectStorage/s3Client.js";
import { uploadImageAttachmentsToProviderFiles } from "../llm/providerFileUpload.js";
import type { OpenAiCompatibleClientConfig } from "../llm/types.js";
import { reasoningScopeForClient } from "../llm/contextScope.js";
import { normalizeLlmProviderOptions } from "../llm/apiProtocol.js";
import { chatCompletionOnce } from "../llm/openaiCompatibleClient.js";
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
} from "../logging/agentLog.js";
function isLocalLlmBaseUrl(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "localhost" || host === "127.0.0.1" || host === "::1";
  } catch {
    return false;
  }
}
import {
  scheduleUserMemoryExtract,
} from "../memory/index.js";
import { runFsmShellScript } from "../tools/fsmRunShell.js";
import {
  invalidateProjectMemoryCache,
  scheduleProjectMemoryExtract,
  syncUserMemoryProjectsIndex,
} from "../projectMemory/index.js";
import {
  configureToolStats,
  setToolStatsEnabled,
  backfillToolInvocationsFromHistory,
} from "../toolStats/index.js";
import { configureSkillUsage } from "../skills/usage.js";
import { buildSkillCatalogNote } from "../skills/catalogNote.js";
import { buildKnowledgeCatalogNote } from "../knowledge/catalogNote.js";
import { loadCollaborativeNote } from "../collaborative/promptNote.js";
import {
  filterCatalogForProject,
  skillProjectKey,
} from "../skills/projectScope.js";
import { skillManager } from "../skills/manager.js";
import {
  scheduleSessionTitle,
} from "../session/generateTitle.js";
import {
  OBJECT_STORAGE_CREDENTIAL_ID,
  readWorkspaceSettings,
  resolveActiveProvider,
  resolveContextLimitTokens,
  resolveCompactTriggerRatio,
  resolveIterationProtectRawIterationCount,
  resolveIterationProtectTokenRatio,
  resolveEnvironmentContextFlags,
  resolveMaxModelIterations,
  resolveMaxTurnTokens,
  resolveLlmRequestTimeoutMs,
  resolveVisionProvider,
  resolveImageGenProvider,
  resolveActiveObjectStorage,
  withSettingsDefaults,
  resolvedToWorkspaceSettings,
  writeWorkspaceSettings,
  disableResponsesStateful,
  type WorkspaceSettings,
} from "../settings/index.js";
import {
  ensureDefaultWorkspaceAndAttachSessions,
  moveSessionToHistory,
  snapshotSessionToHistory,
  getLatestHistoryBySessionId,
  historyRowCoversSession,
  loadAllSessions,
  loadSummarizedHistory,
  loadSessionMessages,
  loadSessionRows,
  loadSubagentDetailFromDb,
  loadSubagentTranscriptFromDb,
  listSubagentRunsForSession,
  runRecordToSummary,
  openSessionDb,
  seedActiveWorkspaceInSettings,
  sessionDbPath,
  setAllSessionsArchivedForWorkspace,
  setSessionArchived as setSessionArchivedRow,
  deleteSession as deleteSessionRowOnly,
  updateComposerPrefs,
  updateFsmBlackboard,
  upsertSession,
  upsertSessionRow,
  FSM_BLACKBOARD_MAX_BYTES,
  validateComposerPrefsPatch,
  type ComposerPrefsPatch,
  type SessionDatabase,
} from "../session/db/index.js";
import { createArchiveWorker } from "../session/archive/worker.js";
import { readSessionDeviceSnapshot } from "../session/deviceSnapshot.js";
import type { JsonObject, Session } from "../session/types.js";
import {
  sliceSessionTailWindow,
  sliceSessionWindowBefore,
  type SessionMessageWindow,
  type SessionTailResult,
} from "../session/messageWindow.js";
import {
  loadSessionTailWindowFromDb,
  loadMessagesBeforeFromDb,
} from "../session/db/index.js";
import { getLoopsToolPort } from "./loops/toolAccess.js";
import { getNotifyToolPort } from "./notifyToolAccess.js";
import {
  planFsmGraphDetach,
  type FsmGraphDetachInputSession,
} from "../session/fsmGraphDetach.js";
import { LEVEL2_CONFIRMATION_TIMEOUT_MS } from "../tools/permissions.js";
import { registerBuiltins } from "../tools/index.js";
import { computerUseWindows } from "../tools/computerUse/windowAvoidance.js";
import { cursorOverlay } from "../tools/computerUse/cursorOverlay.js";
import type { UserAskAnswer, UserAskRequestInput, VisionClientConfig, ImageGenClientConfig, ToolApprovalRisk, ToolConfirmationSource } from "../tools/types.js";
import { isVisionImageRef } from "../tools/fileMeta.js";
import { toolAskProgressText } from "../tools/displayMeta.js";
import { createTurnHookRunner } from "../hooks/index.js";
import type { Workspace } from "../workspace/types.js";
import {
  COCO_HOME_WORKSPACE_ID,
  deleteWorkspaceRow,
  getWorkspace,
  listSessionIdsForWorkspace,
  loadAllWorkspaces,
  syncSessionWorkspacePaths,
  upsertWorkspace,
} from "../workspace/index.js";
import { executeGraphAuthoring } from "../agent/fsm/authoring/contexts.js";
import { getFsmGraph, resolveCustomFsmGraphForTurn } from "../agent/fsm/graphLibrary/manager.js";
import type { FSMGraphConfig } from "../agent/fsm/types.js";
import { getCompactionStrategy } from "../agent/contextCompaction/registry.js";
import { isValidProtectTokenRatio } from "../shared/protectTokenRatio.js";

function resolveCocoCompaction(coco: ReturnType<typeof getCocoExecution>): { compactTriggerRatio?: number | undefined; iterationProtectTokenRatio?: number | undefined } {
  return coco?.role === "commander" && coco.compaction ? coco.compaction() : {};
}

type LiveSession = {
  session: Session;
  hydrated: boolean;
  abort: AbortController | null;
  interruptPort: { fire: (() => boolean) | null };
  promptQueue: QueuedPrompt[];
  promptQueueDraining?: boolean;
  pauseRequested: boolean;
  compacting?: boolean;
  planApproveQueued?: boolean;
  pendingRunModeRequest?: "agent" | "ask" | "plan" | null;
  activeTurnContext?: {
    runMode: ComposerRunMode;
    fullPermissions: boolean;
    autoSkillSummarize: boolean;
    reasoningEffort?: ReasoningEffort;
    headless?: boolean;
  } | null;
  pendingPromptRestore?: PromptRestorePayload | null;
};

function loadEnvApiKey(projectPath: string): string | null {
  try {
    const raw = readFileSync(join(projectPath, ".env"), "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq < 0) continue;
      if (trimmed.slice(0, eq) === "JELLYBOT_API_KEY") {
        const value = trimmed.slice(eq + 1).trim();
        return value.length > 0 ? value : null;
      }
    }
  } catch {
  }
  return process.env.JELLYBOT_API_KEY?.trim() || null;
}

function clampTitle(line: string): string {
  return line.length > 60 ? `${line.slice(0, 57)}…` : line;
}

function titleFromPrompt(text: string, attachments?: { name: string }[]): string {
  const line = text.trim().split(/\r?\n/)[0] ?? "";
  if (line) {
    return clampTitle(line);
  }
  const firstName = attachments?.[0]?.name?.trim();
  if (firstName) {
    return clampTitle(firstName);
  }
  return "New task";
}

function collectLocaleSnapshot(): EnvironmentLocaleSnapshot {
  const host = hostAdapter();
  let preferredLanguages: string[] = [];
  let systemLocale = "";
  let appLocale = "";
  try {
    preferredLanguages = host.getPreferredSystemLanguages() ?? [];
  } catch {
    preferredLanguages = [];
  }
  try {
    systemLocale = host.getSystemLocale() ?? "";
  } catch {
    systemLocale = "";
  }
  try {
    appLocale = host.getLocale() ?? "";
  } catch {
    appLocale = "";
  }
  if (!systemLocale) systemLocale = appLocale || "en-US";
  if (!appLocale) appLocale = systemLocale;
  return { preferredLanguages, systemLocale, appLocale };
}

function normalizeAttachments(
  raw: import("../agent/ipcTypes.js").AttachmentDraft[] | undefined,
): import("../agent/ipcTypes.js").AttachmentDraft[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out: import("../agent/ipcTypes.js").AttachmentDraft[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    if (typeof item.path !== "string" || !item.path.trim()) continue;
    if (typeof item.name !== "string" || !item.name.trim()) continue;
    if (typeof item.kind !== "string" || !item.kind.trim()) continue;
    if (typeof item.mimeType !== "string" || !item.mimeType.trim()) continue;
    const draft: import("../agent/ipcTypes.js").AttachmentDraft = {
      path: item.path.trim(),
      name: item.name.trim(),
      kind: item.kind as import("../session/types.js").AttachmentKind,
      mimeType: item.mimeType.trim(),
    };
    if (
      typeof item.sizeBytes === "number" &&
      Number.isFinite(item.sizeBytes) &&
      item.sizeBytes >= 0
    ) {
      draft.sizeBytes = Math.floor(item.sizeBytes);
    }
    out.push(draft);
  }
  return out;
}

type AgentStreamSink = (payload: { sessionId: string; event: unknown }) => void;
const agentStreamSinks = new Set<AgentStreamSink>();

export function addAgentStreamSink(sink: AgentStreamSink): void {
  agentStreamSinks.add(sink);
}

export function removeAgentStreamSink(sink: AgentStreamSink): void {
  agentStreamSinks.delete(sink);
}

function broadcast(channel: string, payload: unknown): void {
  hostAdapter().broadcastToUiWindows(channel, payload);
  if (agentStreamSinks.size === 0) return;
  let event: { sessionId: string; event: unknown } | null = null;
  if (channel === "agent:stream") {
    event = payload as { sessionId: string; event: unknown };
  } else if (channel === "agent:userAsk") {
    const { passwordDestination: _desktopOnly, ...ask } = payload as UserAskRequestPayload;
    event = { sessionId: ask.sessionId, event: { type: "user_ask", ask } };
  } else if (channel === "agent:userAskDismiss") {
    const dismiss = payload as { sessionId: string };
    event = { sessionId: dismiss.sessionId, event: { type: "user_ask_dismiss", ...dismiss } };
  } else if (channel === "agent:sessionDeleted") {
    const del = payload as { id?: unknown };
    if (typeof del.id === "string") {
      event = { sessionId: del.id, event: { type: "session_deleted", sessionId: del.id } };
    }
  }
  if (!event) return;
  for (const sink of agentStreamSinks) {
    try {
      sink(event);
    } catch {
    }
  }
}

const sessionUpdatedListeners = new Set<(session: Session) => void>();
const turnActivityListeners = new Set<(sessionId: string) => void>();
const settleListeners = new Set<() => void>();

function emitSessionUpdated(session: Session): void {
  broadcast("agent:sessionUpdated", toSessionSummary(session));
  for (const listener of sessionUpdatedListeners) {
    try { listener(session); } catch { }
  }
}

function notifyTurnActivity(sessionId: string): void {
  for (const listener of turnActivityListeners) {
    try { listener(sessionId); } catch { }
  }
}

function notifySettle(): void {
  for (const listener of settleListeners) {
    try { listener(); } catch { }
  }
}

function shouldEmitSessionUpdated(event: {
  type: string;
}): boolean {
  switch (event.type) {
    case "text_delta":
    case "reasoning_delta":
    case "tool_call_delta":
    case "usage":
    case "context_display":
    case "progress":
    case "subagent":
    case "subagent_live":
    case "fsm_node":
    case "tool_live":
    case "round_interrupted":
      return false;
    default:
      return true;
  }
}

function persistSession(db: SessionDatabase, session: Session): void {
  try {
    upsertSession(db, session);
    console.log(
      `[session-db] saved session=${session.id} messages=${session.messages.length} status=${session.status}`,
    );
  } catch (err) {
    console.error("[session-db] failed to persist session", session.id, err);
  }
}

export async function resolveClient(
  appDataRoot: string,
  projectPath: string,
  providerId?: string,
  options: { fallbackIfMissing?: boolean } = {},
): Promise<OpenAiCompatibleClientConfig & { providerId: string }> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(appDataRoot),
  );
  const trimmed =
    typeof providerId === "string" && providerId.trim()
      ? providerId.trim()
      : "";
  let provider: (typeof settings.providers)[number];
  if (trimmed) {
    const found = settings.providers.find((p) => p.id === trimmed);
    if (!found && !options.fallbackIfMissing) {
      throw new Error(
        `Unknown LLM provider "${trimmed}". Pick another provider in the composer.`,
      );
    }
    provider = found ?? resolveActiveProvider(settings);
  } else {
    provider = resolveActiveProvider(settings);
  }
  const apiKey =
    (await readApiKeyFromStore(provider.id)) ??
    loadEnvApiKey(projectPath) ??
    (isLocalLlmBaseUrl(provider.baseUrl) ? "local" : "");
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider "${provider.name}". Add it in Setting or .env JELLYBOT_API_KEY.`,
    );
  }
  return {
    baseUrl: provider.baseUrl,
    apiKey,
    model: provider.modelId,
    ...normalizeLlmProviderOptions(provider),
    ...(provider.rawEndpoint === true ? { rawEndpoint: true } : {}),
    requestTimeoutMs: resolveLlmRequestTimeoutMs(settings),
    providerId: provider.id,
    onResponsesStatefulDisabled: async () => {
      provider.responsesStateful = false;
      const changed = await disableResponsesStateful(appDataRoot, provider.id);
      if (changed) broadcast("llm:providersChanged", {});
    },
  };
}

async function tryResolveClient(
  appDataRoot: string,
  projectPath: string,
  providerId: string,
): Promise<(OpenAiCompatibleClientConfig & { providerId: string }) | null> {
  const trimmed = providerId.trim();
  if (!trimmed) return null;
  try {
    return await resolveClient(appDataRoot, projectPath, trimmed);
  } catch {
    return null;
  }
}

async function resolveVisionClient(
  appDataRoot: string,
  projectPath: string,
  chatProviderId?: string,
): Promise<VisionClientConfig | null> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(appDataRoot),
  );
  const chatProvider =
    (chatProviderId
      ? settings.providers.find((p) => p.id === chatProviderId)
      : undefined) ?? resolveActiveProvider(settings);

  if (chatProvider.supportsMultimodal === true) {
    const apiKey =
      (await readApiKeyFromStore(chatProvider.id)) ??
      loadEnvApiKey(projectPath) ??
      "";
    if (apiKey) {
      return {
        baseUrl: chatProvider.baseUrl,
        apiKey,
        model: chatProvider.modelId,
        ...normalizeLlmProviderOptions(chatProvider),
        ...(chatProvider.rawEndpoint === true ? { rawEndpoint: true } : {}),
      };
    }
  }

  const vision = resolveVisionProvider(settings);
  if (!vision) return null;
  const apiKey =
    (await readApiKeyFromStore(vision.id)) ??
    loadEnvApiKey(projectPath) ??
    "local";
  return {
    baseUrl: vision.baseUrl,
    apiKey,
    model: vision.modelId,
    ...normalizeLlmProviderOptions(vision),
    ...(vision.rawEndpoint === true ? { rawEndpoint: true } : {}),
  };
}

async function resolveImageGenClient(
  appDataRoot: string,
  projectPath: string,
): Promise<ImageGenClientConfig | null> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(appDataRoot),
  );
  const imageGen = resolveImageGenProvider(settings);
  if (!imageGen) return null;
  const apiKey =
    (await readApiKeyFromStore(imageGen.id)) ??
    loadEnvApiKey(projectPath) ??
    "local";
  return {
    baseUrl: imageGen.baseUrl,
    apiKey,
    model: imageGen.modelId,
    ...(imageGen.rawEndpoint === true ? { rawEndpoint: true } : {}),
    ...(typeof imageGen.watermark === "boolean"
      ? { watermark: imageGen.watermark }
      : {}),
    ...(imageGen.imageInput === "base64" || imageGen.imageInput === "url"
      ? { imageInput: imageGen.imageInput }
      : {}),
  };
}

async function resolveImageGenInputUploader(
  appDataRoot: string,
): Promise<
  (bytes: Uint8Array, mimeType: string, ext: string) => Promise<string>
> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(appDataRoot),
  );
  const config = resolveActiveObjectStorage(settings);
  if (!config) {
    throw new Error(
      "Object storage (S3/COS) is not configured — required for Cloud " +
        "Storage URL image input. Configure it in Setting or switch the " +
        "ImageGen profile to Base64.",
    );
  }
  const secretAccessKey = await readApiKeyFromStore(
    OBJECT_STORAGE_CREDENTIAL_ID,
  );
  if (!secretAccessKey) {
    throw new Error(
      "Object storage secret key is missing — set it in Setting.",
    );
  }
  return async (bytes, mimeType, ext) => {
    const key = buildObjectKey(config, ext);
    const result = await putObject(
      { config, secretAccessKey },
      key,
      Buffer.from(bytes),
      mimeType,
    );
    return result.url;
  };
}

export type SessionStore = {
  readonly database: SessionDatabase;
  prepareCocoTool(sessionId: string, executionId: string, name: string, args: import("../session/types.js").JsonObject): { assistantMessageId: string; toolCallIds: string[] };
  superviseCocoSession(sessionId: string, executionId: string): () => void;
  enqueueCocoPrompt(req: EnqueuePromptRequest, executionId: string): EnqueuePromptResponse;
  clearCocoPrompts(executionId: string): void;
  hasCocoPrompts(executionId: string): boolean;
  isCocoTurnActive(sessionId: string, executionId: string): boolean;
  isTurnActive: (id: string) => boolean;
  onSessionUpdated(listener: (session: Session) => void): () => void;
  onTurnActivity(listener: (sessionId: string) => void): () => void;
  listSessions: (includeCoco?: boolean) => SessionSummary[];
  getSessionSummary: (sessionId: string) => SessionSummary | null;
  getSession: (sessionId: string) => Session | null;
  getSessionTail: (
    sessionId: string,
    opts?: { turns?: number },
  ) => import("../session/messageWindow.js").SessionTailResult | null;
  getMessagesBefore: (
    sessionId: string,
    beforeMessageId: string,
    opts?: { turns?: number },
  ) => import("../session/messageWindow.js").SessionMessageWindow | null;
  getSubagent: (
    sessionId: string,
    subagentId: string,
  ) => import("../agent/subagents/types.js").SubagentDetailSnapshot | null;
  listRunningSubagents: (
    sessionId: string,
  ) => import("../agent/subagents/types.js").SubagentStatusSnapshot[];
  listSubagents: (sessionId: string) => SubagentRunSummary[];
  getSubagentTranscript: (
    sessionId: string,
    subagentId: string,
  ) => SubagentTranscript | null;
  searchSessions: (query: string) => SessionSearchHit[];
  startTurn: (req: StartTurnRequest, options?: { desktopInitiated?: boolean }) => Promise<StartTurnResponse>;
  enqueuePrompt: (req: EnqueuePromptRequest) => EnqueuePromptResponse;
  listPromptQueue: (sessionId: string) => QueuedPrompt[];
  setCocoChatPromptHandler(handler: {
    start(sessionId: string, prompt: CocoChatPrompt): boolean;
    canInsert(sessionId: string): boolean;
    stop(sessionId: string): boolean;
  }): () => void;
  createCocoChatSession(input: { providerId?: string; seedMessages?: import("../session/types.js").Message[] }): Promise<string>;
  restoreCocoChatPrompt(sessionId: string, text: string): void;
  setCocoSessionSupervisionHandler(handler: {
    decide(sessionId: string, payload: UserAskRequestPayload): Promise<UserAskAnswer | "needs-user" | null>;
    approve(sessionId: string, payload: ToolApprovalRequestPayload): Promise<boolean | "needs-user" | null>;
    supervises(sessionId: string): boolean;
  }): () => void;
  listCocoParkedRequests(): { kind: "ask" | "approval"; requestId: string; sessionId: string }[];
  reclaimCocoSession(sessionId: string): { ok: true } | { ok: false; error: string };
  removeQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  updateQueuedPromptText: (
    sessionId: string,
    promptId: string,
    text: string,
  ) => PromptQueueMutationResponse;
  removeTurnError: (
    sessionId: string,
    messageId: string,
  ) => { ok: true } | { ok: false; error: string };
  promoteQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  deferQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  moveQueuedPromptToFront: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  appendCocoChatNotice(sessionId: string, noticeId: string, text: string): boolean;
  deleteCocoInternalSession(sessionId: string): boolean;
  cocoRetentionCandidates(cutoff:number):CocoRetentionSlice[];
  pruneCocoHistory(slice:CocoRetentionSlice,summary:string):boolean;
  getTurnLifecycle(sessionId: string): SessionTurnLifecycle | undefined;
  normalizeInterruptedTurn(sessionId: string): boolean;
  cancelTurn: (sessionId: string, reason?: SessionTurnStopReason) => boolean;
  takePromptRestore: (sessionId: string) => PromptRestorePayload | null;
  persistRunningSessionsOnQuit: () => void;
  pauseTurn: (sessionId: string, reason?: import("../session/turnLifecycle.js").SessionTurnStopReason) => { ok: boolean; reason?: string };
  resumeTurn: (req: {
    sessionId: string;
    fullPermissions: boolean;
    autoSkillSummarize?: boolean;
    note?: string;
    startContinuation?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
  compactSession: (
    sessionId: string,
    cocoExecutionId?: string,
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
  deleteSession: (sessionId: string) => boolean;
  retryArchiveQueue: () => void;
  respondToolApproval: (req: ToolApprovalResponseRequest) => boolean;
  respondUserAsk: (req: UserAskResponseRequest) => boolean;
  respondHandoffPassword: (requestId: string, submission: HandoffPasswordSubmission) => Promise<HandoffPasswordStatus>;
  listPendingToolApprovals: (sessionId: string) => ToolApprovalRequestPayload[];
  listPendingUserAsks: (sessionId: string) => UserAskRequestPayload[];
  approvePlan: (
    sessionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  discardPlan: (
    sessionId: string,
  ) => { ok: true } | { ok: false; error: string };
  listWorkspaces: () => Workspace[];
  listArchivedWorkspaces: () => Workspace[];
  createWorkspace: (req: CreateWorkspaceRequest) => Promise<Workspace>;
  listWorkspaceTemplates: () => WorkspaceTemplateInfo[];
  inspectWorkspaceInit: (req: {
    path: string;
    templateId: WorkspaceTemplateId;
  }) => TemplateInitInspection;
  createWorkspaceFromTemplate: (
    req: unknown,
    emit: (progress: WorkspaceInitProgress) => void,
  ) => Promise<TemplateInitOutcome>;
  updateWorkspace: (req: UpdateWorkspaceRequest) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  setWorkspaceArchived: (
    workspaceId: string,
    archived: boolean,
  ) => Promise<Workspace>;
  setSessionArchived: (
    sessionId: string,
    archived: boolean,
  ) => SessionSummary;
  getActiveWorkspaceId: () => Promise<string | null>;
  setActiveWorkspaceId: (workspaceId: string) => Promise<string>;
  setSessionProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<Session>;
  setSessionSource: (
    sessionId: string,
    source: import("../session/types.js").SessionSource,
  ) => boolean;
  reassignSessionsUsingProvider: (removedProviderId: string) => Promise<void>;
  setComposerPrefs: (
    sessionId: string,
    patch: {
      runMode?: "agent" | "ask" | "plan" | "custom" | null;
      fsmGraphId?: string | null;
      infinite?: boolean | null;
      reasoningEffort?: ReasoningEffort | null;
    },
  ) => Promise<Session>;
  detachFsmGraphFromSessions: (sessionId: string) => string[];
  memorySync: MemorySync;
};

export type SessionStoreDependencies = {
  handoffLogins?: Pick<HandoffLoginStore, "available" | "accounts" | "remember" | "use">;
  resolveClient?: typeof resolveClient;
  readSettings?: () => Promise<WorkspaceSettings | null>;
  runAgentTurn?: typeof runAgentTurn;
  buildRepoSnapshot?: typeof buildRepoSnapshot | false;
  startBackgroundServices?: boolean;
};

export function createSessionStore(
  appDataRoot: string,
  dependencies: SessionStoreDependencies = {},
): SessionStore {
  const resolveStoreClient = dependencies.resolveClient ?? resolveClient;
  const runStoreTurn = dependencies.runAgentTurn ?? runAgentTurn;
  const buildStoreRepoSnapshot =
    dependencies.buildRepoSnapshot ??
    (dependencies.runAgentTurn ? false : buildRepoSnapshot);
  const pendingApprovals = new Map<
    string,
    {
      sessionId: string;
      payload: ToolApprovalRequestPayload;
      timer: ReturnType<typeof setTimeout> | undefined;
      resolve: (approved: boolean) => void;
    }
  >();

  const pendingUserAsks = new Map<
    string,
    {
      sessionId: string;
      toolCallId: string;
      payload: UserAskRequestPayload;
      abortListener: (() => void) | null;
      signal: AbortSignal | null;
      resolve: (answer: UserAskAnswer | null) => void;
      passwordTarget?: NonNullable<UserAskRequestInput["desktopPassword"]>;
      fillingPassword?: boolean;
    }
  >();

  const cocoParkedRequests = new Map<
    string,
    { kind: "ask" | "approval"; sessionId: string }
  >();

  function settleApproval(requestId: string, approved: boolean): boolean {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    pendingApprovals.delete(requestId);
    cocoParkedRequests.delete(requestId);
    clearTimeout(pending.timer);
    broadcast("agent:toolApprovalDismiss", {
      requestId,
      sessionId: pending.sessionId,
    });
    pending.resolve(approved);
    return true;
  }

  function settleUserAsk(
    requestId: string,
    answer: UserAskAnswer | null,
  ): boolean {
    const pending = pendingUserAsks.get(requestId);
    if (!pending) return false;
    pendingUserAsks.delete(requestId);
    cocoParkedRequests.delete(requestId);
    if (pending.signal && pending.abortListener) {
      pending.signal.removeEventListener("abort", pending.abortListener);
    }
    const live = sessions.get(pending.sessionId);
    if (live?.session.pendingUserAsk?.requestId === requestId) {
      live.session.pendingUserAsk = null;
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
    }
    broadcast("agent:userAskDismiss", {
      requestId,
      sessionId: pending.sessionId,
      toolCallId: pending.toolCallId,
    });
    pending.resolve(answer);
    return true;
  }

  function requestToolConfirmation(
    sessionId: string,
    input: { toolName: string; arguments: JsonObject; risk?: ToolApprovalRisk; source?: ToolConfirmationSource },
  ): Promise<boolean> {
    const requestId = randomUUID();
    const payload: ToolApprovalRequestPayload = {
      requestId,
      sessionId,
      toolName: input.toolName,
      arguments: input.arguments,
      expiresAt: Date.now() + LEVEL2_CONFIRMATION_TIMEOUT_MS,
      ...(input.risk ? { risk: input.risk } : {}),
      ...(input.source ? { source: input.source } : {}),
    };

    return new Promise<boolean>((resolve) => {
      pendingApprovals.set(requestId, { sessionId, payload, timer: undefined, resolve });
      const deliverToUser = (): void => {
        const pending = pendingApprovals.get(requestId);
        if (pending && !pending.timer) {
          pending.timer = setTimeout(() => {
            settleApproval(requestId, false);
          }, LEVEL2_CONFIRMATION_TIMEOUT_MS);
        }
        broadcast("agent:toolApproval", payload);
      };
      const supervision = cocoSessionSupervisionHandler;
      if (supervision && sessions.get(sessionId)?.session.source === "coco") {
        void supervision.approve(sessionId, payload).then((outcome) => {
          if (!pendingApprovals.has(requestId)) return;
          if (sessions.get(sessionId)?.session.source !== "coco") {
            deliverToUser();
            return;
          }
          if (outcome === null) {
            deliverToUser();
            return;
          }
          if (outcome === "needs-user") {
            cocoParkedRequests.set(requestId, { kind: "approval", sessionId });
            return;
          }
          settleApproval(requestId, outcome);
        });
        return;
      }
      deliverToUser();
    });
  }

  async function requestUserAsk(
    sessionId: string,
    input: UserAskRequestInput & { toolCallId: string },
    turnSignal?: AbortSignal,
  ): Promise<UserAskAnswer | null> {
    const signals = [turnSignal, input.signal].filter((item): item is AbortSignal => item !== undefined);
    const signal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
    if (signal?.aborted) {
      return Promise.resolve(null);
    }

    const target = input.desktopPassword;
    const login = target?.login;
    const vault = dependencies.handoffLogins;
    let destination = target?.destination;
    if (destination && login && vault && await vault.available()) {
      const accounts = await vault.accounts(login.origin);
      destination = {
        ...destination,
        login: {
          accounts: login.account ? accounts.filter(account => account === login.account) : accounts,
          ...(login.account ? { account: login.account } : {}),
        },
      };
    }
    if (signal?.aborted) return null;
    const requestId = randomUUID();
    const detail = input.detail?.trim();
    const payload: UserAskRequestPayload = {
      requestId,
      sessionId,
      toolCallId: input.toolCallId,
      question: input.question,
      ...(detail ? { detail } : {}),
      options: input.options,
      ...(input.optionDetails ? { optionDetails: input.optionDetails } : {}),
      allowCustom: input.allowCustom,
      allowMultiple: input.allowMultiple === true,
      ...(input.suppressChime ? { suppressChime: true } : {}),
      ...(destination ? { passwordDestination: destination } : {}),
      ...(input.handoffQrPng ? { handoffQrPng: input.handoffQrPng } : {}),
    };

    const live = sessions.get(sessionId);
    if (live) {
      const ctx = live.activeTurnContext;
      live.session.pendingUserAsk = {
        requestId,
        toolCallId: input.toolCallId,
        question: input.question,
        ...(detail ? { detail } : {}),
        options: input.options,
        ...(input.optionDetails ? { optionDetails: input.optionDetails } : {}),
        allowCustom: input.allowCustom,
        allowMultiple: input.allowMultiple === true,
        assistantMessageId: input.assistantMessageId?.trim() ?? "",
        remainingToolCallIds: [...(input.remainingToolCallIds ?? [])],
        runMode: ctx?.runMode ?? "agent",
        fullPermissions: ctx?.fullPermissions ?? false,
        autoSkillSummarize: ctx?.autoSkillSummarize ?? false,
        ...(ctx?.reasoningEffort ? { reasoningEffort: ctx.reasoningEffort } : {}),
        createdAt: Date.now(),
      };
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
    }

    return new Promise<UserAskAnswer | null>((resolve) => {
      const abortListener = () => {
        settleUserAsk(requestId, null);
      };
      if (signal) {
        signal.addEventListener("abort", abortListener, { once: true });
      }
      pendingUserAsks.set(requestId, {
        sessionId,
        toolCallId: input.toolCallId,
        payload,
        abortListener: signal ? abortListener : null,
        signal: signal ?? null,
        resolve,
        ...(target ? { passwordTarget: target } : {}),
      });
      const deliverToUser = (): void => {
        broadcast("agent:userAsk", payload);
        const awaitDecision = resolveAskAwait({
          headless: live?.activeTurnContext?.headless === true,
        });
        if (!input.desktopPassword && !input.handoffQrPng && awaitDecision.kind === "auto-settle") {
          agentLogInfo("ask_user.headless_auto_settle", {
            sessionId,
            requestId,
          });
          settleUserAsk(requestId, awaitDecision.answer);
        }
      };
      const supervision = cocoSessionSupervisionHandler;
      if (!input.desktopPassword && !input.handoffQrPng && supervision && live?.session.source === "coco") {
        void supervision.decide(sessionId, payload).then((outcome) => {
          if (!pendingUserAsks.has(requestId)) return;
          if (sessions.get(sessionId)?.session.source !== "coco") {
            deliverToUser();
            return;
          }
          if (outcome === "needs-user") {
            cocoParkedRequests.set(requestId, { kind: "ask", sessionId });
            return;
          }
          if (outcome !== null) {
            settleUserAsk(requestId, outcome);
            return;
          }
          deliverToUser();
        });
        return;
      }
      deliverToUser();
    });
  }

  function respondToolApproval(req: ToolApprovalResponseRequest): boolean {
    return settleApproval(req.requestId, req.approved);
  }

  function parseUserAskAnswer(
    req: UserAskResponseRequest,
  ): UserAskAnswer | null {
    const comment = typeof req.comment === "string" ? req.comment.trim() : "";
    if (Array.isArray(req.selections)) {
      const selections = req.selections
        .map((item) => (typeof item === "string" ? item.trim() : ""))
        .filter((item) => item.length > 0);
      if (selections.length === 0) return null;
      return {
        selected: selections.join(", "),
        selections,
        custom: false,
        ...(comment ? { comment } : {}),
      };
    }
    const selected =
      typeof req.selected === "string" ? req.selected.trim() : "";
    if (!selected) return null;
    return {
      selected,
      custom: Boolean(req.custom),
      ...(!req.custom && comment ? { comment } : {}),
    };
  }

  function pendingAskPayload(
    sessionId: string,
    pending: SessionPendingUserAsk,
  ): UserAskRequestPayload {
    return {
      requestId: pending.requestId,
      sessionId,
      toolCallId: pending.toolCallId,
      question: pending.question,
      ...(pending.detail ? { detail: pending.detail } : {}),
      options: pending.options,
      ...(pending.optionDetails ? { optionDetails: pending.optionDetails } : {}),
      allowCustom: pending.allowCustom,
      allowMultiple: pending.allowMultiple,
    };
  }

  function findLiveSessionByPendingAskRequestId(
    requestId: string,
  ): LiveSession | null {
    for (const live of sessions.values()) {
      if (live.session.pendingUserAsk?.requestId === requestId) {
        return live;
      }
    }
    return null;
  }

  function dismissPersistedUserAsk(
    live: LiveSession,
    pending: SessionPendingUserAsk,
  ): void {
    const sessionId = live.session.id;
    cancelAskUserToolCall(live.session, pending, () => randomUUID());
    live.session.pendingUserAsk = null;
    live.session.progressText = "";
    live.session.updatedAt = Date.now();
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    broadcast("agent:userAskDismiss", {
      requestId: pending.requestId,
      sessionId,
      toolCallId: pending.toolCallId,
    });
    broadcast("agent:stream", {
      sessionId,
      event: { type: "status", status: live.session.status },
    });
  }

  function resumeTurnAfterPersistedUserAsk(
    live: LiveSession,
    pending: SessionPendingUserAsk,
  ): void {
    const sessionId = live.session.id;
    const resumeToolBatch =
      pending.remainingToolCallIds.length > 0
        ? {
            assistantMessageId: pending.assistantMessageId,
            toolCallIds: pending.remainingToolCallIds,
          }
        : undefined;
    void startTurn({
      sessionId,
      userText: "",
      suppressUserMessage: true,
      resumeAfterUserAsk: true,
      fullPermissions: pending.fullPermissions,
      autoSkillSummarize: pending.autoSkillSummarize,
      runMode: pending.runMode,
      ...(pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {}),
      ...(resumeToolBatch ? { resumeToolBatch } : {}),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      agentLogError("ask_user.resume_failed", { sessionId, message });
      broadcast("agent:stream", {
        sessionId,
        event: { type: "error", message },
      });
    });
  }

  function respondUserAsk(req: UserAskResponseRequest): boolean {
    const answer = parseUserAskAnswer(req);
    const active = pendingUserAsks.get(req.requestId);
    if (active?.passwordTarget && (
      active.fillingPassword || !answer || answer.custom || answer.comment ||
      !active.payload.options.includes(answer.selected)
    )) return false;
    if (settleUserAsk(req.requestId, answer)) {
      return true;
    }

    const live = findLiveSessionByPendingAskRequestId(req.requestId);
    if (!live?.session.pendingUserAsk) return false;
    const pending = live.session.pendingUserAsk;
    if (pending.requestId !== req.requestId) return false;

    const sessionId = live.session.id;
    if (!answer) {
      dismissPersistedUserAsk(live, pending);
      return true;
    }

    if (!appendAskUserToolResult(live.session, pending, answer, () => randomUUID())) {
      return false;
    }
    live.session.pendingUserAsk = null;
    live.session.updatedAt = Date.now();
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    broadcast("agent:userAskDismiss", {
      requestId: pending.requestId,
      sessionId,
      toolCallId: pending.toolCallId,
    });

    resumeTurnAfterPersistedUserAsk(live, pending);
    return true;
  }

  async function respondHandoffPassword(
    requestId: string,
    submission: HandoffPasswordSubmission,
  ): Promise<HandoffPasswordStatus> {
    const pending = pendingUserAsks.get(requestId);
    const completeLabel = pending?.payload.options[0];
    const target = pending?.passwordTarget;
    if (!pending || !target || !completeLabel || pending.signal?.aborted) return "expired";
    if (pending.fillingPassword) return "busy";
    const vault = dependencies.handoffLogins;
    const login = target.login;
    const choices = pending.payload.passwordDestination?.login;
    const account = submission.kind === "saved" ? submission.account : submission.rememberAccount;
    if (account !== undefined && (!account || account.length > 512 || !login || !choices || !vault)) return "unavailable";
    if (submission.kind === "manual" && (!submission.password || submission.password.length > 4096)) return "unavailable";
    pending.fillingPassword = true;
    try {
      const fill = (password: string) => pending.signal?.aborted
        ? Promise.resolve(false)
        : target.fill(password, pending.signal ?? undefined, account ? { account } : undefined);
      const filled = submission.kind === "saved"
        ? Boolean(choices?.accounts.includes(submission.account) && login && vault &&
            await vault.use(login.origin, submission.account, fill))
        : await fill(submission.password);
      if (pendingUserAsks.get(requestId) !== pending || pending.signal?.aborted) return "expired";
      if (!filled) return "unavailable";
      const saved = submission.kind !== "manual" || !account ||
        Boolean(login && vault && await vault.remember(login.origin, account, submission.password));
      settleUserAsk(requestId, { selected: completeLabel, custom: false });
      return saved ? "filled" : "filled_not_saved";
    } catch {
      return "unavailable";
    } finally {
      pending.fillingPassword = false;
    }
  }

  function listPendingToolApprovals(
    sessionId: string,
  ): ToolApprovalRequestPayload[] {
    const out: ToolApprovalRequestPayload[] = [];
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) out.push(pending.payload);
    }
    return out;
  }

  function listPendingUserAsks(sessionId: string): UserAskRequestPayload[] {
    const out: UserAskRequestPayload[] = [];
    for (const pending of pendingUserAsks.values()) {
      if (pending.sessionId === sessionId) out.push(pending.payload);
    }
    const live = sessions.get(sessionId);
    const persisted = live?.session.pendingUserAsk;
    if (
      persisted &&
      !out.some((item) => item.requestId === persisted.requestId)
    ) {
      out.push(pendingAskPayload(sessionId, persisted));
    }
    return out;
  }

  registerBuiltins();

  const db = openSessionDb(appDataRoot);
  const turnLifecycles = new SessionTurnLifecycles(db);
  configureToolStats({ db, enabled: true });
  configureSkillUsage({ db });
  try {
    const backfill = backfillToolInvocationsFromHistory(db);
    if (
      backfill.inserted > 0 ||
      backfill.scannedCalls > 0 ||
      backfill.skippedExisting > 0
    ) {
      console.log(
        `[tool-stats] backfill scanned=${backfill.scannedCalls} inserted=${backfill.inserted} skippedExisting=${backfill.skippedExisting} skippedIncomplete=${backfill.skippedIncomplete}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[tool-stats] backfill failed: ${message}`);
  }
  const { workspaceId: bootWorkspaceId } =
    ensureDefaultWorkspaceAndAttachSessions(db, process.cwd());
  seedActiveWorkspaceInSettings(appDataRoot, bootWorkspaceId);

  void readWorkspaceSettings(appDataRoot).then((settings) => {
    setToolStatsEnabled(withSettingsDefaults(settings).toolStatsEnabled);
  });

  const sessions = new Map<string, LiveSession>();
  const cocoPromptAccess = new Map<string, string>();
  const cocoTurns = new Map<string, string>();
  const cocoSupervisors = new Map<string, string>();
  let cocoChatPromptHandler: Parameters<SessionStore["setCocoChatPromptHandler"]>[0] | undefined;
  function setCocoChatPromptHandler(handler: NonNullable<typeof cocoChatPromptHandler>): () => void {
    cocoChatPromptHandler = handler;
    return () => { if (cocoChatPromptHandler === handler) cocoChatPromptHandler = undefined; };
  }
  let cocoSessionSupervisionHandler: Parameters<SessionStore["setCocoSessionSupervisionHandler"]>[0] | undefined;
  function cocoSupervisesSession(sessionId: string): boolean {
    return sessions.get(sessionId)?.session.source === "coco" && cocoSessionSupervisionHandler?.supervises(sessionId) === true;
  }
  function setCocoSessionSupervisionHandler(handler: NonNullable<typeof cocoSessionSupervisionHandler>): () => void {
    cocoSessionSupervisionHandler = handler;
    return () => { if (cocoSessionSupervisionHandler === handler) cocoSessionSupervisionHandler = undefined; };
  }
  function listCocoParkedRequests(): { kind: "ask" | "approval"; requestId: string; sessionId: string }[] {
    return [...cocoParkedRequests].map(([requestId, entry]) => ({ kind: entry.kind, requestId, sessionId: entry.sessionId }));
  }

  function reclaimCocoSession(sessionId: string): { ok: true } | { ok: false; error: string } {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, error: "Unknown session." };
    if (live.session.archived) return { ok: false, error: "This session is archived." };
    if (live.session.source === "coco") {
      if (!setSessionSource(sessionId, "app")) return { ok: false, error: "Unknown session." };
      for (const [requestId, parked] of cocoParkedRequests) {
        if (parked.sessionId !== sessionId) continue;
        cocoParkedRequests.delete(requestId);
        if (parked.kind === "ask") {
          const pending = pendingUserAsks.get(requestId);
          if (pending) broadcast("agent:userAsk", pending.payload);
        } else {
          const pending = pendingApprovals.get(requestId);
          if (!pending) continue;
          if (!pending.timer) pending.timer = setTimeout(() => settleApproval(requestId, false), LEVEL2_CONFIRMATION_TIMEOUT_MS);
          broadcast("agent:toolApproval", pending.payload);
        }
      }
    }
    return { ok: true };
  }
  const supervisor = (sessionId: string) => getCocoExecution(cocoSupervisors.get(sessionId));
  function superviseCocoSession(sessionId: string, executionId: string): () => void {
    const access = getCocoExecution(executionId), live = sessions.get(sessionId);
    if (!access || access.signal.aborted || !live || access.workspaceId !== live.session.workspaceId) throw new Error("Coco cannot supervise this session");
    cocoSupervisors.set(sessionId, executionId);
    if (!access.role && !live.session.source) { live.session.source = "coco"; persistSession(db, live.session); }
    return () => { if (cocoSupervisors.get(sessionId) === executionId) cocoSupervisors.delete(sessionId); };
  }
  function clearCocoPrompts(executionId: string): void {
    for (const live of sessions.values()) {
      const removed = live.promptQueue.filter(p => cocoPromptAccess.get(p.id) === executionId);
      if (!removed.length) continue;
      live.promptQueue = live.promptQueue.filter(p => cocoPromptAccess.get(p.id) !== executionId);
      removed.forEach(p => cocoPromptAccess.delete(p.id));
      emitPromptQueue(live);
    }
    for (const [promptId, id] of cocoPromptAccess) if (id === executionId) cocoPromptAccess.delete(promptId);
  }
  function enqueueCocoPrompt(req: EnqueuePromptRequest, executionId: string): EnqueuePromptResponse {
    const access = getCocoExecution(executionId), live = sessions.get(req.sessionId);
    if (!access || access.signal.aborted || !live || live.session.workspaceId !== access.workspaceId) throw new Error("Coco session scope changed");
    const result = enqueuePrompt(req);
    cocoPromptAccess.set(result.queued.id, executionId);
    if (!live.abort && live.session.status === "idle") drainPromptQueue(live, false, null);
    return result;
  }

  function persistSession(db: SessionDatabase, session: Session): void {
    try {
      const live = sessions.get(session.id);
      if (live && !live.hydrated) {
        upsertSessionRow(db, session);
        console.log(
          `[session-db] saved session=${session.id} messages=(lazy) status=${session.status}`,
        );
      } else {
        upsertSession(db, session);
        console.log(
          `[session-db] saved session=${session.id} messages=${session.messages.length} status=${session.status}`,
        );
      }
    } catch (err) {
      console.error("[session-db] failed to persist session", session.id, err);
    }
  }

  function ensureSessionHydrated(sessionId: string): LiveSession | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    if (!live.hydrated) {
      live.session.messages = loadSessionMessages(db, sessionId);
      live.hydrated = true;
    }
    return live;
  }

  const loaded = loadSessionRows(db);
  console.log(
    `[session-db] opened ${sessionDbPath(appDataRoot)} loaded=${loaded.length} (messages lazy)`,
  );

  for (const session of loaded) {
    let hydrated = false;
    if (session.status === "running") {
      session.messages = loadSessionMessages(db, session.id);
      hydrated = true;
      if (session.pendingUserAsk) {
        session.status = "idle";
        session.progressText = toolAskProgressText("ask_user");
      } else {
        const prior=turnLifecycles.get(session.id);
        const started=prior?.startedAt ?? session.updatedAt;
        let fromIndex=session.messages.findIndex(m=>m.createdAt>=started);if(fromIndex<0)fromIndex=session.messages.length;
        turnLifecycles.put({sessionId:session.id,turnId:prior?.turnId??randomUUID(),owner:prior?.owner??(session.source==="coco"?"coco":session.source==="coco_chat"?"coco_chat":"user"),startedAt:started,endedAt:Date.now(),state:prior?.requestedStop??"interrupted",...(prior?.requestedStop?{requestedStop:prior.requestedStop}:{}),pendingEffects:unfinishedTurnEffects(session,fromIndex),error:"Application restarted during the turn"});
        session.status = "cancelled";
        session.progressText = "Interrupted by app restart";
        const sealed = sealOrphanToolCallsInSession(
          session,
          () => randomUUID(),
        );
        if (sealed > 0) {
          agentLogWarn("boot.sealed_orphan_tool_calls", {
            sessionId: session.id,
            sealed,
          });
        }
      }
      session.updatedAt = Date.now();
      persistSession(db, session);
    }
    sessions.set(session.id, {
      session,
      hydrated,
      abort: null,
      interruptPort: { fire: null },
      promptQueue: [],
      pauseRequested: false,
    });
  }

  const REMOTE_RELAY_CREDENTIAL_ID = "remote-relay";
  const memorySync = createMemorySync({
    db,
    getSyncConfig: async () => {
      const settings = await readWorkspaceSettings(appDataRoot);
      const remote = settings?.remote;
      if (!remote?.enabled || !remote.serverUrl.trim()) return null;
      const ms = remote.memorySync;
      if (!ms?.enabled || !ms.sessionArchive) return null;
      return {
        serverUrl: remote.serverUrl,
        deviceId: ensureDeviceId(remote.deviceId),
        deviceName: remote.deviceName ?? "",
      };
    },
    getApiKey: () => readApiKeyFromStore(REMOTE_RELAY_CREDENTIAL_ID),
    appVersion: () => hostAdapter().appVersion(),
    log: (level, event, data) => {
      const line = `[memorySync] ${event} ${JSON.stringify(data ?? {})}`;
      if (level === "warn") console.warn(line);
      else console.log(line);
    },
  });
  if (dependencies.startBackgroundServices !== false) memorySync.start();
  else memorySync.stop();
  const archiveWorker = createArchiveWorker({
    db,
    resolveClient: (workspacePath) =>
      resolveClient(appDataRoot, workspacePath, ""),
    getContextLimitTokens: async () =>
      resolveContextLimitTokens(withSettingsDefaults(await readSettings())),
    onTaskDone: () => memorySync.kick("archive-done"),
  });
  if (dependencies.startBackgroundServices !== false) archiveWorker.start();
  else archiveWorker.stop();

  if (dependencies.startBackgroundServices !== false) {
    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[user-memory] projects index sync failed: ${message}`);
    });
  }

  function listSessions(includeCoco = false): SessionSummary[] {
    return [...sessions.values()].filter(live => {
      const source = live.session.source ?? "";
      if (source === "coco_internal") return false;
      if (!includeCoco && source === "coco_chat") return false;
      return true;
    })
     .map((live) => toSessionSummary(live.session))
     .sort((a, b) => b.updatedAt - a.updatedAt);
 }

  function getSession(sessionId: string): Session | null {
    return ensureSessionHydrated(sessionId)?.session ?? null;
  }

  function getSessionTail(
    sessionId: string,
    opts?: { turns?: number },
  ): SessionTailResult | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    if (!live.hydrated) {
      const slice = loadSessionTailWindowFromDb(db, sessionId, opts?.turns);
      return {
        session: { ...live.session, messages: slice.messages },
        window: {
          firstMessageId: slice.firstMessageId,
          hasMore: slice.hasMore,
          remainingTurns: slice.remainingTurns,
        },
      };
    }
    const slice = sliceSessionTailWindow(live.session.messages, opts?.turns);
    return {
      session: { ...live.session, messages: slice.messages },
      window: {
        firstMessageId: slice.firstMessageId,
        hasMore: slice.hasMore,
        remainingTurns: slice.remainingTurns,
      },
    };
  }

  function getMessagesBefore(
    sessionId: string,
    beforeMessageId: string,
    opts?: { turns?: number },
  ): SessionMessageWindow | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    if (live.hydrated) {
      return sliceSessionWindowBefore(
        live.session.messages,
        beforeMessageId,
        opts?.turns,
      );
    }
    return loadMessagesBeforeFromDb(
      db,
      sessionId,
      beforeMessageId,
      opts?.turns,
    );
  }

  function getSubagent(sessionId: string, subagentId: string) {
    const live = getSubagentManager(sessionId)?.getDetail(subagentId);
    if (live) return live;
    try {
      return loadSubagentDetailFromDb(db, sessionId, subagentId);
    } catch (err) {
      console.error("[session-db] getSubagent failed", sessionId, subagentId, err);
      return null;
    }
  }

  function listRunningSubagents(sessionId: string) {
    return getSubagentManager(sessionId)?.list() ?? [];
  }

  function listSubagents(sessionId: string): SubagentRunSummary[] {
    const merged = new Map<string, SubagentRunSummary>();
    try {
      for (const run of listSubagentRunsForSession(db, sessionId)) {
        merged.set(run.id, runRecordToSummary(run));
      }
    } catch (err) {
      console.error("[session-db] listSubagents failed", sessionId, err);
    }
    for (const snap of getSubagentManager(sessionId)?.listSummaries() ?? []) {
      merged.set(snap.id, snap);
    }
    return [...merged.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  function getSubagentTranscript(
    sessionId: string,
    subagentId: string,
  ): SubagentTranscript | null {
    const live = getSubagentManager(sessionId)?.getTranscript(subagentId);
    if (live) return live;
    try {
      return loadSubagentTranscriptFromDb(db, sessionId, subagentId);
    } catch (err) {
      console.error(
        "[session-db] getSubagentTranscript failed",
        sessionId,
        subagentId,
        err,
      );
      return null;
    }
  }

  function searchSessions(query: string): SessionSearchHit[] {
    const trimmed = query.trim();
    if (!trimmed) return [];
    const likePattern = `%${trimmed.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const candidateRows = db
      .prepare(
        `SELECT m.session_id AS sid, MAX(s.updated_at) AS recent
         FROM messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE s.type = 'agent' AND m.parts LIKE ? ESCAPE '\\'
         GROUP BY m.session_id
         ORDER BY recent DESC
         LIMIT 500`,
      )
      .all(likePattern) as Array<{ sid: string }>;
    const messageCandidateIds = new Set(candidateRows.map((row) => row.sid));
    const lowered = trimmed.toLowerCase();
    const candidates = [...sessions.values()]
      .filter(
        (live) =>
          live.session.type === "agent" &&
          (live.hydrated ||
            messageCandidateIds.has(live.session.id) ||
            live.session.title.toLowerCase().includes(lowered)),
      )
      .map((live) => ensureSessionHydrated(live.session.id)!.session);
    return searchSessionsInMemory(
      candidates,
      loadAllWorkspaces(db),
      query,
    );
  }

  function emitPromptQueue(live: LiveSession): void {
    broadcast("agent:stream", {
      sessionId: live.session.id,
      event: { type: "prompt_queue", items: live.promptQueue },
    });
    if (live.promptQueue.length === 0) notifySettle();
  }

  function queueResult(
    live: LiveSession,
    ok: boolean,
    extra?: { reason?: string; started?: boolean },
  ): PromptQueueMutationResponse {
    return {
      ok,
      items: live.promptQueue,
      ...(extra?.reason !== undefined ? { reason: extra.reason } : {}),
      ...(extra?.started !== undefined ? { started: extra.started } : {}),
    };
  }

  function enqueuePrompt(req: EnqueuePromptRequest): EnqueuePromptResponse {
    const live = sessions.get(req.sessionId);
    if (!live) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }
    if (live.session.type !== "agent") {
      throw new Error("Only agent sessions can queue prompts");
    }
    const running = live.session.status === "running" && live.abort !== null;
    const mode: QueuedPromptMode =
      normalizeQueuedPromptMode(req.mode) === "interrupt" && running
        ? "interrupt"
        : "deferred";
    const result = enqueueIntoQueue(live.promptQueue, {
      sessionId: live.session.id,
      userText: req.userText,
      attachments: normalizeAttachments(req.attachments),
      mode,
      id: randomUUID(),
      createdAt: Date.now(),
      ...(live.session.source === "coco_chat" && typeof req.cocoWorkId === "string" && req.cocoWorkId ? { cocoWorkId: req.cocoWorkId } : {}),
    });
    if (!result.ok) {
      throw new Error(
        result.reason === "cap"
          ? "Prompt queue is full — send or remove a queued message first"
          : "Prompt is empty",
      );
    }
    live.promptQueue = result.items;
    agentLogInfo("turn.prompt_queued", {
      sessionId: live.session.id,
      promptId: result.queued.id,
      mode,
      queueLength: live.promptQueue.length,
      attachmentCount: result.queued.attachments.length,
    });
    emitPromptQueue(live);
    return { queued: result.queued, items: live.promptQueue };
  }

  function listPromptQueue(sessionId: string): QueuedPrompt[] {
    return sessions.get(sessionId)?.promptQueue ?? [];
  }

  function removeQueuedPrompt(
    sessionId: string,
    promptId: string,
  ): PromptQueueMutationResponse {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session", items: [] };
    const result = removeQueued(live.promptQueue, promptId);
    if (!result.ok) return queueResult(live, false, { reason: "not_found" });
    live.promptQueue = result.items;
    cocoPromptAccess.delete(promptId);
    agentLogInfo("turn.prompt_dequeued", { sessionId, promptId });
    emitPromptQueue(live);
    return queueResult(live, true);
  }

  function updateQueuedPromptText(
    sessionId: string,
    promptId: string,
    text: string,
  ): PromptQueueMutationResponse {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session", items: [] };
    const result = updateQueuedText(live.promptQueue, promptId, text);
    if (!result.ok) return queueResult(live, false, { reason: "not_found" });
    live.promptQueue = result.items;
    emitPromptQueue(live);
    return queueResult(live, true, result.removed ? { reason: "removed" } : undefined);
  }

  function removeTurnError(
    sessionId: string,
    messageId: string,
  ): { ok: true } | { ok: false; error: string } {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, error: "Session not found." };
    if (live.abort || live.session.status === "running") {
      return { ok: false, error: "Session has a running turn." };
    }
    if (live.compacting) {
      return { ok: false, error: "Session is compacting context." };
    }
    ensureSessionHydrated(sessionId);
    const result = consumeTurnErrorMessage(live.session, messageId);
    if (!result.removed) return { ok: true };
    live.session.updatedAt = Date.now();
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    agentLogInfo("turn.error_consumed", {
      sessionId,
      messageId,
    });
    return { ok: true };
  }

  function promoteQueuedPrompt(
    sessionId: string,
    promptId: string,
  ): PromptQueueMutationResponse {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session", items: [] };
    const target = live.promptQueue.find((item) => item.id === promptId);
    if (!target) return queueResult(live, false, { reason: "not_found" });

    const running = live.session.status === "running" && live.abort !== null;
    if (!running || (live.session.source === "coco_chat" && !cocoChatPromptHandler?.canInsert(sessionId))) {
      if (live.compacting) {
        return queueResult(live, false, { reason: "compacting" });
      }
      const result = removeQueued(live.promptQueue, promptId);
      live.promptQueue = result.items;
      emitPromptQueue(live);
      agentLogInfo("turn.prompt_queue_send_now", { sessionId, promptId });
      const started = startQueuedPromptTurn(live, target, "manual");
      return queueResult(live, started, { started, ...(!started ? { reason: "coco_unavailable" } : {}) });
    }

    const armed = setQueuedMode(live.promptQueue, promptId, "interrupt");
    live.promptQueue = armed.items;
    agentLogInfo("turn.prompt_armed", { sessionId, promptId });
    emitPromptQueue(live);
    return queueResult(live, true);
  }

  function deferQueuedPrompt(
    sessionId: string,
    promptId: string,
  ): PromptQueueMutationResponse {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session", items: [] };
    const result = setQueuedMode(live.promptQueue, promptId, "deferred");
    if (!result.ok) return queueResult(live, false, { reason: "not_found" });
    live.promptQueue = result.items;
    agentLogInfo("turn.prompt_disarmed", { sessionId, promptId });
    emitPromptQueue(live);
    return queueResult(live, true);
  }

  function moveQueuedPromptToFront(
    sessionId: string,
    promptId: string,
  ): PromptQueueMutationResponse {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session", items: [] };
    const result = moveQueuedToFront(live.promptQueue, promptId);
    if (!result.ok) return queueResult(live, false, { reason: "not_found" });
    live.promptQueue = result.items;
    emitPromptQueue(live);
    return queueResult(live, true);
  }

  function forceEndUnendedTurn(live: LiveSession): boolean {
    if (live.session.status !== "running") return false;
    const sessionId = live.session.id;
    ensureSessionHydrated(sessionId);
    live.planApproveQueued = false;
    live.session.status = "cancelled";
    live.session.progressText = "Stopped";
    live.session.updatedAt = Date.now();
    const sealed = sealOrphanToolCallsInSession(live.session, () => randomUUID());
    agentLogWarn("turn.force_cancelled", { sessionId, sealed });
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    broadcast("agent:stream", {
      sessionId,
      event: { type: "status", status: "cancelled" },
    });
    broadcast("agent:stream", {
      sessionId,
      event: { type: "done", reason: "cancelled" },
    });
    return true;
  }

  function cancelTurn(sessionId: string, reason: SessionTurnStopReason = "user_stopped"): boolean {
    const live = sessions.get(sessionId);
    if (!live) return false;
    if (!live.abort && live.session.source === "coco_chat" && reason === "user_stopped" && cocoChatPromptHandler?.stop(sessionId)) return true;
    turnLifecycles.requestStop(sessionId,reason);
    if (!live.abort) return forceEndUnendedTurn(live);
    const demoted = demoteArmedOnTurnEnd(live.promptQueue);
    if (demoted.changed) {
      live.promptQueue = demoted.items;
      emitPromptQueue(live);
    }
    live.planApproveQueued = false;
    live.abort.abort();
    return true;
  }

  function takePromptRestore(sessionId: string): PromptRestorePayload | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    const payload = live.pendingPromptRestore ?? null;
    live.pendingPromptRestore = null;
    return payload;
  }

  function pauseTurn(
    sessionId: string,
    reason: import("../session/turnLifecycle.js").SessionTurnStopReason = "user_paused",
  ): {
    ok: boolean;
    reason?: string;
  } {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session" };
    if (!live.abort) return { ok: false, reason: "not_running" };
    if (live.session.pendingUserAsk) {
      return { ok: false, reason: "waiting_input" };
    }
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) {
        return { ok: false, reason: "waiting_input" };
      }
    }
    if (live.pauseRequested) return { ok: true };
    live.pauseRequested = true;
    turnLifecycles.requestStop(sessionId, reason);
    agentLogInfo("turn.pause_requested", { sessionId, reason });
    return { ok: true };
  }

  async function resumeTurn(req: {
    sessionId: string;
    fullPermissions: boolean;
    autoSkillSummarize?: boolean;
    note?: string;
    startContinuation?: boolean;
  }): Promise<{ ok: boolean; reason?: string }> {
    const live = sessions.get(req.sessionId);
    if (!live) return { ok: false, reason: "unknown_session" };
    if (live.abort || live.session.status === "running") {
      return { ok: false, reason: "running" };
    }
    if (live.compacting) return { ok: false, reason: "compacting" };
    if (live.session.status !== "paused") {
      return { ok: false, reason: "not_paused" };
    }
    ensureSessionHydrated(req.sessionId);
    const note = (req.note?.trim() || "Continuing after user pause.").slice(0, 4000);
    live.session.messages.push({
      id: randomUUID(),
      role: "system",
      createdAt: Date.now(),
      parts: [{ type: "text", text: note }],
    });
    live.session.updatedAt = Date.now();
    if (req.startContinuation === false) {
      live.session.status = "idle";
      live.session.progressText = "";
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
      return { ok: true };
    }
    persistSession(db, live.session);
    try {
      await startTurn({
        sessionId: req.sessionId,
        userText: "",
        fullPermissions: req.fullPermissions,
        ...(req.autoSkillSummarize === true
          ? { autoSkillSummarize: true }
          : {}),
        suppressUserMessage: true,
      });
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }
    return { ok: true };
  }

  async function compactSession(
    sessionId: string,
    cocoExecutionId?: string,
    options?: { protectTokenRatio?: number },
  ): Promise<{
    ok: boolean;
    reason?: string;
    compacted?: boolean;
    estimatedTokens?: number;
  }> {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session" };
    const coco=getCocoExecution(cocoExecutionId);
    if(live.session.source==="coco_internal" && (coco?.role!=="background" || coco.signal.aborted || !coco.canStartTurn()))return {ok:false,reason:"background_capability_required"};
    if (live.abort || live.session.status === "running") {
      return { ok: false, reason: "running" };
    }
    if (live.session.status === "paused") {
      return { ok: false, reason: "paused" };
    }
    if (live.compacting) return { ok: false, reason: "compacting" };
    if (live.session.pendingUserAsk) {
      return { ok: false, reason: "waiting_input" };
    }
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) {
        return { ok: false, reason: "waiting_input" };
      }
    }

    ensureSessionHydrated(sessionId);

    live.compacting = true;
    try {
      const settings = withSettingsDefaults(await readSettings());
      const client = await resolveStoreClient(
        appDataRoot,
        live.session.workspacePath,
        live.session.providerId,
        { fallbackIfMissing: true },
      );
      const strategy = getCompactionStrategy();
      const contextLimitTokens = resolveContextLimitTokens(settings);
      const cocoCompaction = resolveCocoCompaction(coco);
      const buildConfig = {
        reasoningScope: reasoningScopeForClient(client),
        contextLimitTokens,
        iterationProtectRawIterationCount:
          resolveIterationProtectRawIterationCount(settings),
        iterationProtectTokenRatio:
          cocoCompaction.iterationProtectTokenRatio ??
          resolveIterationProtectTokenRatio(settings),
      };
      const protectTokenRatioOverride = isValidProtectTokenRatio(
        options?.protectTokenRatio,
      )
        ? options.protectTokenRatio
        : undefined;
      agentLogInfo("compact.manual_start", {
        sessionId,
        ...(protectTokenRatioOverride !== undefined
          ? { protectTokenRatio: protectTokenRatioOverride }
          : {}),
      });
      const result = await strategy.maybeCompactBeforeIteration({
        session: live.session,
        client: { ...client },
        createId: () => randomUUID(),
        contextLimitTokens,
        compactTriggerRatio:
          cocoCompaction.compactTriggerRatio ??
          resolveCompactTriggerRatio(settings),
        iterationProtectRawIterationCount:
          buildConfig.iterationProtectRawIterationCount,
        iterationProtectTokenRatio:
          protectTokenRatioOverride ??
          buildConfig.iterationProtectTokenRatio,
        force: true,
        ...(coco ? {signal:coco.signal,summarize:coco.summarize} : {}),
        onEvent: (event) => broadcast("agent:stream", { sessionId, event }),
      });
      strategy.refreshSessionCompactionState(live.session, buildConfig);
      if (result.compacted && typeof result.estimatedTokens === "number") {
        live.session.contextUsage = {
          usedTokens: result.estimatedTokens,
          source: "estimate",
        };
      }
      live.session.progressText = result.compacted
        ? "Context compacted"
        : "";
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
      broadcast("agent:stream", {
        sessionId,
        event: { type: "status", status: live.session.status },
      });
      if ("error" in result && result.error) {
        return {
          ok: false,
          reason: result.error,
          estimatedTokens: result.estimatedTokens,
        };
      }
      agentLogInfo("compact.manual_done", {
        sessionId,
        compacted: result.compacted,
        estimatedTokens: result.estimatedTokens,
      });
      return {
        ok: true,
        compacted: result.compacted,
        estimatedTokens: result.estimatedTokens,
      };
    } finally {
      live.compacting = false;
      notifySettle();
    }
  }

  async function clearSession(sessionId: string): Promise<{
    ok: boolean;
    reason?: string;
  }> {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session" };
    if (live.abort || live.session.status === "running") {
      return { ok: false, reason: "running" };
    }
    if (live.session.status === "paused") {
      return { ok: false, reason: "paused" };
    }
    if (live.compacting) return { ok: false, reason: "compacting" };
    if (live.session.pendingUserAsk) {
      return { ok: false, reason: "waiting_input" };
    }
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) {
        return { ok: false, reason: "waiting_input" };
      }
    }

    ensureSessionHydrated(sessionId);

    const session = live.session;
    const clearedMessageCount = session.messages.length;
    session.messages.push({
      id: randomUUID(),
      role: "system" as const,
      createdAt: Date.now(),
      parts: [
        {
          type: "context_clear" as const,
          id: randomUUID(),
          clearedMessageCount,
        },
      ],
    });
    if (live.promptQueue.length > 0) {
      live.promptQueue = [];
      emitPromptQueue(live);
    }
    session.contextBuckets = {
      hotTurnCount: 0,
      warmTurnCount: 0,
      hot: 0,
      warm: 0,
      cold: 0,
      updatedAt: Date.now(),
    };
    session.fsmBlackboard = null;
    session.contextUsage = {
      usedTokens: 0,
      displayUsedTokens: 0,
      source: "estimate",
    };
    session.progressText = "";
    session.updatedAt = Date.now();
    persistSession(db, session);
    emitSessionUpdated(session);
    broadcast("agent:stream", {
      sessionId,
      event: { type: "status", status: session.status },
    });
    agentLogInfo("session.clear", { sessionId, clearedMessageCount });
    return { ok: true };
  }

  async function endSession(sessionId: string): Promise<{
    ok: boolean;
    reason?: string;
    compacted?: boolean;
    estimatedTokens?: number;
  }> {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, reason: "unknown_session" };
    if (live.abort || live.session.status === "running") {
      return { ok: false, reason: "running" };
    }
    if (live.session.status === "paused") {
      return { ok: false, reason: "paused" };
    }
    if (live.compacting) return { ok: false, reason: "compacting" };
    if (live.session.pendingUserAsk) {
      return { ok: false, reason: "waiting_input" };
    }
    for (const pending of pendingApprovals.values()) {
      if (pending.sessionId === sessionId) {
        return { ok: false, reason: "waiting_input" };
      }
    }

    ensureSessionHydrated(sessionId);

    live.compacting = true;
    try {
      const settings = withSettingsDefaults(await readSettings());
      const client = await resolveStoreClient(
        appDataRoot,
        live.session.workspacePath,
        live.session.providerId,
        { fallbackIfMissing: true },
      );
      const strategy = getCompactionStrategy();
      const contextLimitTokens = resolveContextLimitTokens(settings);
      const buildConfig = {
        reasoningScope: reasoningScopeForClient(client),
        contextLimitTokens,
        iterationProtectRawIterationCount: 0,
        iterationProtectTokenRatio: 0,
      };
      agentLogInfo("compact.end_start", { sessionId });
      const result = await strategy.maybeCompactBeforeIteration({
        session: live.session,
        client: { ...client },
        createId: () => randomUUID(),
        contextLimitTokens,
        compactTriggerRatio: resolveCompactTriggerRatio(settings),
        iterationProtectRawIterationCount: 0,
        iterationProtectTokenRatio: 0,
        force: true,
        onEvent: (event) => broadcast("agent:stream", { sessionId, event }),
      });
      strategy.refreshSessionCompactionState(live.session, buildConfig);
      if (result.compacted && typeof result.estimatedTokens === "number") {
        live.session.contextUsage = {
          usedTokens: result.estimatedTokens,
          source: "estimate",
        };
      }
      live.session.progressText = result.compacted
        ? "Conversation summarised"
        : "";
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
      broadcast("agent:stream", {
        sessionId,
        event: { type: "status", status: live.session.status },
      });
      if ("error" in result && result.error) {
        return {
          ok: false,
          reason: result.error,
          estimatedTokens: result.estimatedTokens,
        };
      }
      agentLogInfo("compact.end_done", {
        sessionId,
        compacted: result.compacted,
        estimatedTokens: result.estimatedTokens,
      });
      return {
        ok: true,
        compacted: result.compacted,
        estimatedTokens: result.estimatedTokens,
      };
    } finally {
      live.compacting = false;
      notifySettle();
    }
  }

  function snapshotArchivedSessionToHistory(
    live: LiveSession,
    archivedAt: number,
  ): boolean {
   const existing = getLatestHistoryBySessionId(db, live.session.id);
    if (existing && historyRowCoversSession(existing, live.session)) {
      agentLogInfo("archive.snapshot.skipped_covered", {
        sessionId: live.session.id,
        historyStatus: existing.status,
      });
      return false;
    }
    let appVersion = "";
    try {
      appVersion = hostAdapter().appVersion();
    } catch {
    }
    snapshotSessionToHistory(db, live.session, {
      historyId: randomUUID(),
      archivedAt,
      device: readSessionDeviceSnapshot(appDataRoot, appVersion),
    });
    agentLogInfo("archive.snapshot.queued", {
      sessionId: live.session.id,
      messageCount: live.session.messages.length,
    });
    return true;
  }

  function deleteSession(sessionId: string): boolean {
    const live = sessions.get(sessionId);
    if (!live) return false;

    if (live.abort) return false;

    if (live.compacting) return false;

    ensureSessionHydrated(sessionId);

    const covered = getLatestHistoryBySessionId(db, sessionId);
    if (covered && historyRowCoversSession(covered, live.session)) {
      try {
        const removed = deleteSessionRowOnly(db, sessionId);
        if (!removed) {
          console.warn(
            "[session-db] deleteSession: session row already gone",
            sessionId,
          );
        }
        agentLogInfo("archive.delete.skipped_covered", {
          sessionId,
          historyStatus: covered.status,
        });
      } catch (err) {
        console.error(
          "[session-db] failed to delete covered session",
          sessionId,
          err,
        );
        return false;
      }
      live.promptQueue = [];
      settleSessionApprovals(sessionId);
      sessions.delete(sessionId);
      broadcast("agent:sessionDeleted", { id: sessionId });
      notifySettle();
      return true;
    }

    let appVersion = "";
    try {
      appVersion = hostAdapter().appVersion();
    } catch {
    }
    const device = readSessionDeviceSnapshot(appDataRoot, appVersion);

    try {
      const moved = moveSessionToHistory(db, live.session, {
        historyId: randomUUID(),
        deletedAt: Date.now(),
        device,
      });
      if (!moved) {
        console.warn(
          "[session-db] deleteSession: session row already gone, nothing archived",
          sessionId,
        );
      }
      archiveWorker.kick();
    } catch (err) {
      console.error(
        "[session-db] failed to archive-move session",
        sessionId,
        err,
      );
      return false;
    }

    live.promptQueue = [];
    settleSessionApprovals(sessionId);
    sessions.delete(sessionId);
    notifySettle();

    broadcast("agent:sessionDeleted", { id: sessionId });
    return true;
  }

  function settleSessionApprovals(sessionId: string): void {
    for (const [requestId, pending] of [...pendingApprovals.entries()]) {
      if (pending.sessionId === sessionId) {
        settleApproval(requestId, false);
      }
    }

    for (const [requestId, pending] of [...pendingUserAsks.entries()]) {
      if (pending.sessionId === sessionId) {
        settleUserAsk(requestId, null);
      }
    }
  }

  function deriveWorkspaceArchiveIds(): {
    active: Set<string>;
    archived: Set<string>;
  } {
    const active = new Set<string>();
    const archived = new Set<string>();
    for (const live of sessions.values()) {
      const id = live.session.workspaceId;
      if (!id || live.session.type !== "agent") continue;
      if (live.session.archived) {
        archived.add(id);
      } else {
        active.add(id);
      }
    }
    return { active, archived };
  }

  function hasAnySession(workspaceId: string): boolean {
    return listSessionIdsForWorkspace(db, workspaceId).length > 0;
  }

  function listWorkspaces(): Workspace[] {
    const { active } = deriveWorkspaceArchiveIds();
    return loadAllWorkspaces(db).filter(
      (w) => active.has(w.id) || !hasAnySession(w.id),
    );
  }

  function listArchivedWorkspaces(): Workspace[] {
    const { archived } = deriveWorkspaceArchiveIds();
    return loadAllWorkspaces(db).filter((w) => archived.has(w.id));
  }

  async function setWorkspaceArchived(
    workspaceId: string,
    archived: boolean,
  ): Promise<Workspace> {
    const existing = getWorkspace(db, workspaceId);
    if (!existing || workspaceId === COCO_HOME_WORKSPACE_ID) throw new Error(`Unknown workspace: ${workspaceId}`);

    if (archived) {
      for (const live of sessions.values()) {
        if (
          live.session.workspaceId === workspaceId &&
          !live.session.archived &&
          live.session.status === "running"
        ) {
          throw new Error(
            "Cannot archive a workspace with a running session. Cancel the turn or wait for it to finish first.",
          );
        }
      }
    }

    const transitioning = archived
      ? [...sessions.values()].filter(
          (live) =>
            live.session.workspaceId === workspaceId &&
            !live.session.archived,
        )
      : [];

    const ts = Date.now();
    const changed = setAllSessionsArchivedForWorkspace(
      db,
      workspaceId,
      archived,
      ts,
    );
    if (changed > 0) {
      let queuedSnapshots = 0;
      for (const live of sessions.values()) {
        if (live.session.workspaceId !== workspaceId) continue;
        live.session.archived = archived;
        live.session.archivedAt = archived ? ts : null;
        emitSessionUpdated(live.session);
      }
      for (const live of transitioning) {
        ensureSessionHydrated(live.session.id);
        if (snapshotArchivedSessionToHistory(live, ts)) {
          queuedSnapshots += 1;
        }
      }
      if (queuedSnapshots > 0) {
        archiveWorker.kick();
        agentLogInfo("archive.snapshot.workspace_queued", {
          workspaceId,
          count: queuedSnapshots,
        });
      }
      void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[user-memory] projects index sync failed: ${message}`);
      });
    }
    broadcast("workspace:changed", { type: "updated", workspace: existing });
    return existing;
  }

  function setSessionArchived(
    sessionId: string,
    archived: boolean,
  ): SessionSummary {
    const live = sessions.get(sessionId);
    if (!live) throw new Error(`Unknown session: ${sessionId}`);
    if (live.session.archived === archived) {
      return toSessionSummary(live.session);
    }
    if (archived && live.session.status === "running") {
      throw new Error(
        "Cannot archive a running session. Cancel the turn or wait for it to finish first.",
      );
    }

    const ts = Date.now();
    const changed = setSessionArchivedRow(db, sessionId, archived, ts);
    if (!changed) throw new Error(`Unknown session: ${sessionId}`);

    live.session.archived = archived;
    live.session.archivedAt = archived ? ts : null;

    if (archived) {
      ensureSessionHydrated(sessionId);
      if (snapshotArchivedSessionToHistory(live, ts)) {
        archiveWorker.kick();
      }
    }

    emitSessionUpdated(live.session);

    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[user-memory] projects index sync failed: ${message}`);
    });
    broadcast("workspace:changed", {
      type: "active",
      workspaceId: live.session.workspaceId,
    });
    return toSessionSummary(live.session);
  }

  async function readSettings(): Promise<WorkspaceSettings | null> {
    return dependencies.readSettings
      ? dependencies.readSettings()
      : readWorkspaceSettings(appDataRoot);
  }

  async function getActiveWorkspaceId(): Promise<string | null> {
    const settings = withSettingsDefaults(await readSettings());
    if (
      settings.activeWorkspaceId &&
      getWorkspace(db, settings.activeWorkspaceId)
    ) {
      return settings.activeWorkspaceId;
    }
    const first = listWorkspaces()[0];
    return first?.id ?? null;
  }

  async function setActiveWorkspaceId(workspaceId: string): Promise<string> {
    if (workspaceId === COCO_HOME_WORKSPACE_ID || !getWorkspace(db, workspaceId)) {
      throw new Error(`Unknown workspace: ${workspaceId}`);
    }
    const current = withSettingsDefaults(await readSettings());
    await writeWorkspaceSettings(
      appDataRoot,
      resolvedToWorkspaceSettings(current, {
        activeWorkspaceId: workspaceId,
      }),
    );
    broadcast("workspace:changed", {
      type: "active",
      workspaceId,
    });
    return workspaceId;
  }

  async function createWorkspace(
    req: CreateWorkspaceRequest,
  ): Promise<Workspace> {
    const name = req.name.trim();
    const path = req.path.trim();
    if (!name) throw new Error("Workspace name is required");
    if (!path) throw new Error("Workspace path is required");

    const now = Date.now();
    const workspace: Workspace = {
      id: randomUUID(),
      name,
      path,
      origin: req.origin === "coco" ? "coco" : "user",
      createdAt: now,
      updatedAt: now,
    };
    upsertWorkspace(db, workspace);
    const taskCfg = await ensureDevTasksConfig(path);
    if (taskCfg === "created") {
      console.log(`[devtasks] generated .larry/tasks.json for ${path}`);
    }
    await setActiveWorkspaceId(workspace.id);
    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[user-memory] projects index sync failed: ${message}`);
  });
    broadcast("workspace:changed", { type: "created", workspace });
    emitWorkspaceLifecycle({ type: "created", workspace });
    return workspace;
  }

  function listWorkspaceTemplates(): WorkspaceTemplateInfo[] {
    return listWorkspaceTemplateInfos();
  }

  function inspectWorkspaceInit(req: {
    path: string;
    templateId: WorkspaceTemplateId;
  }): TemplateInitInspection {
    if (!isWorkspaceTemplateId(req.templateId)) {
      throw new Error("Unknown workspace template");
    }
    return detectInitPlan({
      path: req.path.trim(),
      templateId: req.templateId,
    });
  }

  async function createWorkspaceFromTemplate(
    req: unknown,
    emit: (progress: WorkspaceInitProgress) => void,
  ): Promise<TemplateInitOutcome> {
    if (!isTemplateInitRequest(req)) {
      throw new Error(
        "workspace:createFromTemplate requires {templateId, name, path}",
      );
    }
    return runWorkspaceTemplateInit(req, { createWorkspace, emit });
  }

  async function updateWorkspace(
    req: UpdateWorkspaceRequest,
  ): Promise<Workspace> {
    const existing = getWorkspace(db, req.id);
    if (!existing || req.id === COCO_HOME_WORKSPACE_ID) throw new Error(`Unknown workspace: ${req.id}`);

    const name =
      typeof req.name === "string" && req.name.trim()
        ? req.name.trim()
        : existing.name;
    const path =
      typeof req.path === "string" && req.path.trim()
        ? req.path.trim()
        : existing.path;

    const workspace: Workspace = {
      ...existing,
      name,
      path,
      updatedAt: Date.now(),
    };
    upsertWorkspace(db, workspace);

    if (path !== existing.path) {
      invalidateProjectMemoryCache(existing.path);
      if ((await ensureDevTasksConfig(path)) === "created") {
        console.log(`[devtasks] generated .larry/tasks.json for ${path}`);
      }
      syncSessionWorkspacePaths(db, workspace.id, path);
      for (const live of sessions.values()) {
        if (live.session.workspaceId === workspace.id) {
          live.session.workspacePath = path;
          live.session.updatedAt = Date.now();
          emitSessionUpdated(live.session);
        }
      }
    }

    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[user-memory] projects index sync failed: ${message}`);
  });
    broadcast("workspace:changed", { type: "updated", workspace });
    return workspace;
  }

  async function clearActiveWorkspaceId(): Promise<void> {
    const current = withSettingsDefaults(await readSettings());
    await writeWorkspaceSettings(
      appDataRoot,
      resolvedToWorkspaceSettings(current, {
        activeWorkspaceId: null,
      }),
    );
    broadcast("workspace:changed", {
      type: "active",
      workspaceId: null,
    });
  }

  function hardDeleteInternalSession(sessionId: string): boolean {
    const live = sessions.get(sessionId);
    if (!live || live.session.source !== "coco_internal" || live.abort || live.compacting || live.session.pendingUserAsk || live.promptQueue.length || turnLifecycles.get(sessionId)?.pendingEffects.length) return false;
    try { deleteSessionRowOnly(db, sessionId); } catch (err) {
      console.error("[session-db] failed to delete coco background session", sessionId, err);
      return false;
    }
    settleSessionApprovals(sessionId);
    sessions.delete(sessionId);
    turnLifecycles.delete(sessionId);
    broadcast("agent:sessionDeleted", { id: sessionId });
    notifySettle();
    return true;
  }

  async function waitInternalSessionsSettled(
    sessionIds: string[],
    timeoutMs = 5000,
  ): Promise<void> {
    const busy = (): boolean => sessionIds.some((sessionId) => {
      const live = sessions.get(sessionId);
      if (!live) return false;
      return !!live.abort || !!live.compacting || live.promptQueue.length > 0 ||
        (turnLifecycles.get(sessionId)?.pendingEffects.length ?? 0) > 0;
    });
    if (!busy()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      const onSettle = (): void => { if (!busy()) finish(); };
      function finish(): void {
        clearTimeout(timer);
        settleListeners.delete(onSettle);
        resolve();
      }
      settleListeners.add(onSettle);
      if (!busy()) finish();
    });
  }

  async function deleteWorkspace(workspaceId: string): Promise<boolean> {
    const existing = getWorkspace(db, workspaceId);
    if (!existing || workspaceId === COCO_HOME_WORKSPACE_ID) return false;

    const sessionIds = listSessionIdsForWorkspace(db, workspaceId);
    const archivedIds: string[] = [];
    const internalIds: string[] = [];
    let hasUnarchivedAgent = false;
    for (const sessionId of sessionIds) {
      const live = sessions.get(sessionId);
      if (!live) continue;
      if (live.session.source === "coco_internal") {
        internalIds.push(sessionId);
        continue;
      }
      if (live.session.archived) {
        archivedIds.push(sessionId);
      } else {
        hasUnarchivedAgent = true;
      }
    }

    if (internalIds.length > 0) {
      for (const sessionId of internalIds) {
        const live = sessions.get(sessionId);
        if (live && (live.abort || live.compacting)) cancelTurn(sessionId);
      }
      await waitInternalSessionsSettled(internalIds);
      for (const sessionId of internalIds) {
        if (!hardDeleteInternalSession(sessionId)) {
          throw new Error(
            "A CoCo background session under this workspace could not be stopped. Try again in a moment.",
          );
        }
      }
    }

    if (hasUnarchivedAgent) {
      for (const sessionId of archivedIds) {
        deleteSession(sessionId);
      }
      broadcast("workspace:changed", { type: "updated", workspace: existing });
      return true;
    }

    for (const sessionId of sessionIds) {
      deleteSession(sessionId);
    }

    deleteWorkspaceRow(db, workspaceId);
    invalidateProjectMemoryCache(existing.path);
    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[user-memory] projects index sync failed: ${message}`);
  });
    broadcast("workspace:changed", { type: "deleted", workspaceId });
    emitWorkspaceLifecycle({ type: "deleted", workspace: existing });

    const remaining = listWorkspaces();
    const settings = withSettingsDefaults(await readSettings());
    const wasActive = settings.activeWorkspaceId === workspaceId;
    if (remaining.length === 0) {
      await clearActiveWorkspaceId();
    } else if (wasActive || !settings.activeWorkspaceId) {
      await setActiveWorkspaceId(remaining[0]!.id);
    }
    return true;
  }

  async function setSessionProvider(
    sessionId: string,
    providerId: string,
  ): Promise<Session> {
    const trimmed = typeof providerId === "string" ? providerId.trim() : "";
    if (!trimmed) {
      throw new Error("providerId is required");
    }
    const live = sessions.get(sessionId);
    if (!live) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    const assertCanChangeProvider = (): void => {
      if (sessions.get(sessionId) !== live) throw new Error(`Unknown session: ${sessionId}`);
      if (live.session.status === "running" || live.abort) {
        throw new Error("Cannot change LLM provider while a turn is running");
      }
      if (live.compacting) throw new Error("Cannot change LLM provider while context is compacting");
    };
    assertCanChangeProvider();
    const settings = withSettingsDefaults(await readSettings());
    const provider = settings.providers.find((p) => p.id === trimmed);
    if (!provider) {
      throw new Error(`Unknown provider: ${trimmed}`);
    }
    assertCanChangeProvider();
    live.session.providerId = provider.id;
    live.session.model = provider.modelId;
    live.session.updatedAt = Date.now();
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    return live.session;
  }

  function setSessionSource(
    sessionId: string,
    source: import("../session/types.js").SessionSource,
  ): boolean {
    const live = sessions.get(sessionId);
    if (!live) return false;
    if (live.session.source === source) return true;
    live.session.source = source;
    persistSession(db, live.session);
    emitSessionUpdated(live.session);
    return true;
  }

  async function reassignSessionsUsingProvider(
    removedProviderId: string,
  ): Promise<void> {
    const removedId = removedProviderId.trim();
    if (!removedId) return;
    const settings = withSettingsDefaults(await readSettings());
    if (settings.providers.some((provider) => provider.id === removedId)) {
      return;
    }
    const replacement = resolveActiveProvider(settings);
    if (!replacement || replacement.id === removedId) return;
    for (const live of sessions.values()) {
      if (live.session.providerId !== removedId) continue;
      if (live.abort || live.session.status === "running" || live.compacting) continue;
      live.session.providerId = replacement.id;
      live.session.model = replacement.modelId;
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
    }
  }

  async function setComposerPrefs(
    sessionId: string,
    patch: ComposerPrefsPatch,
  ): Promise<Session> {
    validateComposerPrefsPatch(patch);
    const live = sessions.get(sessionId);
    if (!live) {
      throw new Error(`Unknown session: ${sessionId}`);
    }
    if (live.session.status === "running" || live.abort) {
      throw new Error("Cannot change composer prefs while a turn is running");
    }
    const effective: ComposerPrefsPatch = { ...patch };
    if (
      patch.runMode !== undefined &&
      patch.runMode !== "custom" &&
      patch.fsmGraphId === undefined
    ) {
      effective.fsmGraphId = null;
    }
    if (typeof effective.fsmGraphId === "string" && effective.fsmGraphId.trim()) {
      await resolveCustomFsmGraphForTurn(effective.fsmGraphId);
    }
    const changed = updateComposerPrefs(db, sessionId, effective);
    if (effective.runMode !== undefined) {
      live.session.composerRunMode = effective.runMode ?? null;
    }
    if (effective.fsmGraphId !== undefined) {
      live.session.composerFsmGraphId = effective.fsmGraphId ?? null;
    }
    if (effective.infinite !== undefined) {
      live.session.composerInfinite = effective.infinite ?? null;
    }
    if (effective.reasoningEffort !== undefined) {
      live.session.reasoningEffort = effective.reasoningEffort ?? null;
    }
    if (changed) {
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
    }
    return live.session;
  }

  function detachFsmGraphFromSessions(graphId: string): string[] {
    const views: FsmGraphDetachInputSession[] = [...sessions.values()].map(
      (live) => ({
        id: live.session.id,
        title: live.session.title,
        running: live.session.status === "running" || live.abort !== null,
        composerRunMode: live.session.composerRunMode ?? null,
        composerFsmGraphId: live.session.composerFsmGraphId ?? null,
      }),
    );
    const plan = planFsmGraphDetach(views, graphId);
    if (plan.blocked.length > 0) {
      const titles = plan.blocked.map((s) => `"${s.title}"`).join(", ");
      throw new Error(
        plan.blocked.length === 1
          ? `Session ${titles} is running with this graph. Stop it before deleting.`
          : `Sessions ${titles} are running with this graph. Stop them before deleting.`,
      );
    }
    for (const target of plan.flip) {
      void setComposerPrefs(target.id, { runMode: "agent" });
    }
    return plan.flip.map((s) => s.id);
  }

  async function startTurn(req: StartTurnRequest, { desktopInitiated = false } = {}): Promise<StartTurnResponse> {
    const coco = getCocoExecution(req.cocoExecutionId);
    const cocoSource = cocoSourceForAccess(coco);
    const existing = req.sessionId ? sessions.get(req.sessionId)?.session : undefined;
    const executionAccess = () => coco ?? supervisor(sessionId);
    let turnFullPermissions = req.fullPermissions;
    if (existing?.source === "coco_chat" && !coco && !req.suppressUserMessage && !req.resumeAfterUserAsk) {
      const prompt: CocoChatPrompt = {
        userText: req.userText,
        attachments: normalizeAttachments(req.attachments),
        ...(typeof req.cocoWorkId === "string" && req.cocoWorkId ? { cocoWorkId: req.cocoWorkId } : {}),
        ...(req.continuation ? { continuation: req.continuation } : {}),
      };
      if (!prompt.userText.trim() && !prompt.attachments.length) throw new Error("Prompt is empty");
      if (sessions.get(existing.id)?.abort || existing.status === "running") throw new Error("Session already has a running turn");
      if (!cocoChatPromptHandler?.start(existing.id, prompt)) throw new Error("CoCo is not ready yet. Try again in a moment.");
      return { sessionId: existing.id };
    }
    if ((req.source === "coco_chat" || existing?.source === "coco_chat") && coco?.role !== "commander") throw new Error("Coco Chat requires the commander capability");
    if ((req.source === "coco_internal" || existing?.source === "coco_internal") && coco?.role !== "background") throw new Error("CoCo background sessions require the background capability");
    if ((req.source === "coco" || req.source === "coco_chat" || req.source === "coco_internal") && !coco) throw new Error("Coco-owned turns require a trusted execution capability");
    if (coco && (coco.signal.aborted || (existing ? existing.workspaceId : req.workspaceId) !== coco.workspaceId)) throw new Error("Coco scope or lifecycle changed");
    const text = req.userText.trim();
    const attachments = normalizeAttachments(req.attachments);
    if (
      !req.resumeAfterUserAsk &&
      !req.suppressUserMessage &&
      !text &&
      attachments.length === 0
    ) {
      throw new Error("Prompt is empty");
    }

    let live = req.sessionId ? sessions.get(req.sessionId) : undefined;
    if (req.sessionId && !live) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }
    if (live) ensureSessionHydrated(live.session.id);
    if (live && cocoSource === "coco" && !live.session.source) {
      live.session.source = "coco";
      persistSession(db, live.session);
    }

    if (!live) {
      const workspaceId =
        (typeof req.workspaceId === "string" && req.workspaceId.trim()
          ? req.workspaceId.trim()
          : null) ?? (await getActiveWorkspaceId());
      if (!workspaceId) {
        throw new Error("No workspace available. Create a workspace first.");
      }
      const workspace = getWorkspace(db, workspaceId);
      if (!workspace || (workspaceId === COCO_HOME_WORKSPACE_ID && coco?.role !== "commander")) {
        throw new Error(`Unknown workspace: ${workspaceId}`);
      }

      const now = Date.now();
      const settings = withSettingsDefaults(await readSettings());
      const requestedProviderId =
        typeof req.providerId === "string" && req.providerId.trim()
          ? req.providerId.trim()
          : "";
      let provider = resolveActiveProvider(settings);
      if (requestedProviderId) {
        const found = settings.providers.find(
          (p) => p.id === requestedProviderId,
        );
        if (!found) {
          throw new Error(`Unknown provider: ${requestedProviderId}`);
        }
        provider = found;
      }
      const explicitTitle = req.title?.trim() ?? "";
      const session: Session = {
        id: randomUUID(),
        type: "agent",
        title: explicitTitle ? clampTitle(explicitTitle) : titleFromPrompt(text, attachments),
        createdAt: now,
        updatedAt: now,
        status: "idle",
        progressText: "",
        messages: coco?.role === "commander" ? structuredClone(coco.seedMessages ?? []) : [],
        model: provider.modelId,
        providerId: provider.id,
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        pinned: false,
        archived: false,
        archivedAt: null,
        contextUsage: { usedTokens: 0 },
        plan: null,
        ...(req.runMode ? { composerRunMode: req.runMode } : {}),
        ...(req.runMode === "custom" &&
        typeof req.fsmGraphId === "string" &&
        req.fsmGraphId.trim()
          ? { composerFsmGraphId: req.fsmGraphId.trim() }
          : {}),
        ...(typeof req.composerInfinite === "boolean"
          ? { composerInfinite: req.composerInfinite }
          : {}),
        ...(req.reasoningEffort
          ? { reasoningEffort: req.reasoningEffort }
          : {}),
        ...(req.source ? { source: req.source } : cocoSource ? { source: cocoSource } : {}),
      };
      live = {
        session,
        hydrated: true,
        abort: null,
        interruptPort: { fire: null },
        promptQueue: [],
        pauseRequested: false,
      };
      sessions.set(session.id, live);
      persistSession(db, session);
    }

    const continuesRunningTurn =
      req.suppressUserMessage === true || req.resumeAfterUserAsk === true;
    if (
      live.abort ||
      (live.session.status === "running" && !continuesRunningTurn)
    ) {
      throw new Error("Session already has a running turn");
    }

    if (live.compacting) {
      throw new Error("Session is compacting context; try again shortly");
    }

    const current = live;
    const sessionId = current.session.id;
    const abort = new AbortController();
    current.abort = abort;
    notifyTurnActivity(sessionId);
    const lifecycleTurnId=randomUUID();
    turnLifecycles.put({sessionId,turnId:lifecycleTurnId,owner:coco?.role==="commander"?"coco_chat":coco?"coco":"user",startedAt:Date.now(),state:"running",pendingEffects:[]});
    if (coco && req.cocoExecutionId) cocoTurns.set(sessionId, req.cocoExecutionId);
    else cocoTurns.delete(sessionId);
    const cancelCoco = (): void => abort.abort();
    coco?.signal.addEventListener("abort", cancelCoco, { once: true });
    if (coco?.signal.aborted) abort.abort();
    const ownsTurn = (): boolean => sessions.get(sessionId) === current && current.abort === abort;
    const ensureTurnActive = (): void => {
      if (!ownsTurn()) throw new Error("Session turn was superseded");
      abort.signal.throwIfAborted();
    };
    const interruptPort: { fire: (() => boolean) | null } = { fire: null };
    current.interruptPort = interruptPort;
    const projectPath = current.session.workspacePath;
    let client: Awaited<ReturnType<typeof resolveClient>>;
    let prefSettings: ReturnType<typeof withSettingsDefaults>;
    let autoSkillSummarize = req.autoSkillSummarize === true;
    let runMode: ComposerRunMode;
    let reasoningEffort: ReasoningEffort;
    let fsmGraphConfig: FSMGraphConfig | undefined;
    let fsmGraphId: string | undefined;
    try {
      coco?.onSessionClaim?.(sessionId);
      current.pendingPromptRestore = null;
      if (current.session.pendingUserAsk && !req.resumeAfterUserAsk) {
        dismissPersistedUserAsk(current, current.session.pendingUserAsk);
      }
      client = await resolveStoreClient(
        appDataRoot, projectPath, current.session.providerId,
        { fallbackIfMissing: true },
      );
      ensureTurnActive();
      prefSettings = withSettingsDefaults(await readSettings());
      ensureTurnActive();
      if (req.autoSkillSummarize === undefined && current.session.source === "coco") {
        autoSkillSummarize = prefSettings.autoSkillSummarizeDefault;
      }
      runMode = coco ? (req.runMode === "ask" || req.runMode === "plan" ? req.runMode : "agent") : current.session.composerRunMode ?? prefSettings.composerRunMode;
      reasoningEffort = normalizeReasoningEffort(
        current.session.reasoningEffort ?? prefSettings.reasoningEffort,
      );
      if (runMode === "custom") {
        const resolved = await resolveCustomFsmGraphForTurn(
          current.session.composerFsmGraphId,
        );
        ensureTurnActive();
        fsmGraphConfig = resolved.config;
        fsmGraphId = resolved.id;
      }
      current.session.providerId = client.providerId;
      current.session.model = client.model;
      current.session.status = "running";
      current.session.progressText = "Waiting for model…";
      current.session.updatedAt = Date.now();
      current.activeTurnContext = {
        runMode,
        fullPermissions: req.fullPermissions,
        autoSkillSummarize,
        reasoningEffort,
        headless: req.headless === true,
      };
      emitSessionUpdated(current.session);
    } catch (error) {
      coco?.signal.removeEventListener("abort", cancelCoco);
      if (ownsTurn()) {
        if(!abort.signal.aborted){current.session.status="error";current.session.progressText=error instanceof Error?error.message:String(error);persistSession(db,current.session);}
        turnLifecycles.finish(current.session,lifecycleTurnId,[],error instanceof Error?error.message:String(error));
        current.abort = null;
        notifyTurnActivity(sessionId);
        notifySettle();
        current.interruptPort = { fire: null };
        current.activeTurnContext = null;
        current.pauseRequested = false;
        if (abort.signal.aborted) {
          current.session.status = "cancelled";
          current.session.progressText = "Cancelled";
          current.session.updatedAt = Date.now();
          if (
            !req.suppressUserMessage &&
            !req.resumeAfterUserAsk &&
            !req.continuation
          ) {
            current.pendingPromptRestore = { text, attachments };
          }
          persistSession(db, current.session);
          emitSessionUpdated(current.session);
          broadcast("agent:stream", { sessionId, event: { type: "done", reason: "cancelled" } });
          if (current.pendingPromptRestore) {
            broadcast("agent:stream", { sessionId, event: { type: "prompt_restored", text, attachments } });
          }
        }
      }
      if (abort.signal.aborted) return { sessionId };
      throw error;
    }

    void (async () => {
      const turnStartIndex = current.session.messages.length;
      let powerGuardAcquired = false;
      try {
        ensureTurnActive();
        hostAdapter().powerGuard.acquire(sessionId);
        powerGuardAcquired = true;
        const settings = await readSettings();
        ensureTurnActive();
        const hooks = coco ? undefined : await createTurnHookRunner({
          userDataRoot: appDataRoot,
          workspacePath: current.session.workspacePath,
          signal: abort.signal,
        });
        ensureTurnActive();
        const resolvedSettings = withSettingsDefaults(settings);
        const turnReasoningEffort = normalizeReasoningEffort(
          current.session.reasoningEffort ??
            resolvedSettings.reasoningEffort,
        );
        const turnClient = { ...client, reasoningEffort: turnReasoningEffort };
        const repoSnapshotPromise =
          buildStoreRepoSnapshot &&
          current.session.type === "agent" &&
          current.session.workspacePath &&
          (!coco || coco.role === undefined) &&
          resolveEnvironmentContextFlags(settings).repository
            ? buildStoreRepoSnapshot({
                workspacePath: current.session.workspacePath,
                editor: req.editorContext ?? null,
              })
            : Promise.resolve(null);
        const collaborativeNotePromise =
          current.session.type === "agent" &&
          current.session.workspacePath &&
          (!coco || coco.role === undefined)
            ? loadCollaborativeNote(current.session.workspacePath)
            : Promise.resolve(null);

        let turnAttachments = attachments;
        let imageUrls = false;
        const hasImageDrafts = attachments.some(
          (a) =>
            a.kind === "image" && isVisionImageRef(a.path, a.mimeType),
        );
        const markUploadingImages = (): void => {
          if (!hasImageDrafts) return;
          current.session.status = "running";
          current.session.progressText = "Uploading image…";
          current.session.updatedAt = Date.now();
          emitSessionUpdated(current.session);
        };
        if (attachments.length > 0) {
          const providerAcceptsImageUrls = chatProviderAcceptsImageUrls(
            resolvedSettings,
            current.session.providerId,
          );
          if (
            chatProviderUsesProviderFiles(
              resolvedSettings,
              current.session.providerId,
            )
          ) {
            const provider = resolvedSettings.providers.find(
              (p) => p.id === current.session.providerId,
            );
            if (provider?.rawEndpoint === true) {
              agentLogWarn("llm.files.raw_endpoint", {
                sessionId,
                degraded: attachments.filter(
                  (a) =>
                    a.kind === "image" &&
                    isVisionImageRef(a.path, a.mimeType),
                ).length,
              });
            } else {
              markUploadingImages();
              const upload = await uploadImageAttachmentsToProviderFiles({
                baseUrl: client.baseUrl,
                apiKey: client.apiKey,
                attachments,
              });
              turnAttachments = upload.attachments;
              if (upload.uploaded > 0 || upload.failed > 0) {
                agentLogInfo("llm.files.turn", {
                  sessionId,
                  uploaded: upload.uploaded,
                  failed: upload.failed,
                });
              }
              imageUrls = upload.uploaded > 0;
            }
          } else if (
            chatProviderUsesBase64Images(
              resolvedSettings,
              current.session.providerId,
            )
          ) {
            const embed = await embedImageAttachmentsBase64(attachments);
            turnAttachments = embed.attachments;
            if (embed.embedded > 0 || embed.failed > 0) {
              agentLogInfo("img.base64.turn", {
                sessionId,
                embedded: embed.embedded,
                failed: embed.failed,
              });
            }
            imageUrls = embed.embedded > 0;
          } else if (providerAcceptsImageUrls) {
            markUploadingImages();
            const upload = await uploadImageAttachments(
              resolvedSettings,
              attachments,
            );
            turnAttachments = upload.attachments;
            if (upload.uploaded > 0 || upload.failed > 0) {
              agentLogInfo("s3.upload.turn", {
                sessionId,
                uploaded: upload.uploaded,
                failed: upload.failed,
              });
            }
            imageUrls = upload.uploaded > 0;
          }
        }

        const toolRoleImageSupport = resolveToolRoleImageSupport(
          resolvedSettings.providers.find(
            (p) => p.id === current.session.providerId,
          ),
        );
        let uploadReadImage:
          | ((input: {
              imagePath: string;
              mimeType: string;
            }) => Promise<{ url: string; key: string } | null>)
          | undefined;
        if (toolRoleImageSupport.enabled) {
          const transport = toolRoleImageSupport.transport;
          uploadReadImage = async ({ imagePath, mimeType }) => {
            try {
              const draft: import("../agent/ipcTypes.js").AttachmentDraft = {
                kind: "image",
                path: imagePath,
                mimeType,
                name: basename(imagePath),
              };
              if (transport === "url") {
                await uploadImageAttachments(resolvedSettings, [draft]);
              } else {
                await embedImageAttachmentsBase64([draft]);
              }
              return draft.s3?.url
                ? { url: draft.s3.url, key: draft.s3.key ?? "" }
                : null;
            } catch {
              return null;
            }
          };
        }

        const loopsToolPort = getLoopsToolPort();
        const notifyToolPort = getNotifyToolPort();
        const llmBundle = createUniformRoleLlmBundle({ providerId: client.providerId, client: turnClient, ...(coco ? { stream: coco.stream } : {}) });
        if (coco) {
          llmBundle.sessionDefault.complete = async (opts) => (await coco.summarize(turnClient, { messages: opts.messages, signal: abort.signal })).content;
          llmBundle.sessionDefault.hostedTools = () => [];
        }
        await Promise.all(resolvedSettings.providers.filter((provider) => !coco && provider.id !== client.providerId).map(async (provider) => {
          const resolved = await tryResolveClient(appDataRoot, projectPath, provider.id);
          if (resolved) llmBundle.byProviderId[provider.id] = createRoleLlmBinding({ providerId: provider.id,
            client: { ...resolved, reasoningEffort: turnReasoningEffort } });
        }));
        const repoSnapshot = await repoSnapshotPromise;
        const collaborativeNote = await collaborativeNotePromise;
        const skillCatalogNote =
          current.session.type === "agent" &&
          coco?.role !== "background" &&
          !coco?.wireTrailingNote
            ? buildSkillCatalogNote(
                filterCatalogForProject(
                  skillManager.listEnabledCatalog(),
                  skillProjectKey(projectPath),
                ),
              )
            : null;
        const knowledgeCatalogNote =
          current.session.type === "agent" &&
          coco?.role !== "background" &&
          !coco?.wireTrailingNote
            ? buildKnowledgeCatalogNote()
            : null;
        ensureTurnActive();
        await runStoreTurn({
          session: current.session,
          userText: text,
          attachments: turnAttachments,
          ...(prefSettings.topicBoundaryEnabled
            ? {
                topicBoundaryComplete: (config, options) =>
                  coco
                    ? coco.summarize(config, {
                        messages: options.messages,
                        ...(options.signal ? { signal: options.signal } : {}),
                      })
                    : chatCompletionOnce(config, options),
              }
            : {}),
          ...(skillCatalogNote ? { skillCatalogPrompt: skillCatalogNote } : {}),
          ...(knowledgeCatalogNote ? { knowledgeCatalogPrompt: knowledgeCatalogNote } : {}),
          ...(collaborativeNote ? { collaborativePrompt: collaborativeNote } : {}),
          ...(repoSnapshot ? { turnContext: repoSnapshot } : {}),
          ...(imageUrls ? { imageUrls: true } : {}),
          ...(toolRoleImageSupport.enabled ? { toolRoleImages: true } : {}),
          ...(uploadReadImage ? { uploadReadImage } : {}),
          ...(req.suppressUserMessage ? { suppressUserMessage: true } : {}),
          ...(req.continuation ? { continuation: req.continuation } : {}),
          ...(req.resumeAfterUserAsk ? { resumeAfterUserAsk: true } : {}),
          ...(req.resumeToolBatch ? { resumeToolBatch: req.resumeToolBatch } : {}),
          interruptPort,
          hasPendingSteer: () => hasArmedInterrupt(current.promptQueue),
          takePendingSteer: () => {
            current.promptQueue = current.promptQueue.filter(p => {
              const id = cocoPromptAccess.get(p.id);
              if (!id) return true;
              const access = getCocoExecution(id);
              if (access && !access.signal.aborted) return true;
              cocoPromptAccess.delete(p.id); return false;
            });
            const result = takeArmedInterrupts(current.promptQueue);
            if (result.taken.length === 0) return [];
            coco?.onPromptInsert?.(result.taken);
            result.taken.forEach(p => cocoPromptAccess.delete(p.id));
            current.promptQueue = result.items;
            emitPromptQueue(current);
            return result.taken;
          },
          takePauseRequested: () => {
            if (!current.pauseRequested) return false;
            current.pauseRequested = false;
            return true;
          },
          client: { ...turnClient },
          llmBundle,
          ...(coco?.role === "background" ? { toolPredicate: (name: string) => (coco.additionalTools ?? []).some(tool => tool.definition.name === name) } : coco?.toolPredicate ? { toolPredicate: coco.toolPredicate } : {}),
          ...(coco ? {
            streamChat: coco.stream, summarize: coco.summarize, ...(prefSettings.topicBoundaryEnabled ? { topicBoundaryComplete: coco.summarize } : {}), additionalTools: coco.additionalTools ?? [],
            ...(coco.role === "background" ? { agentSystemPrompt: coco.extraSystemPrompt ?? "" }
              : coco.role === "commander" ? { extraSystemPrompt: coco.extraSystemPrompt ?? "", ...(coco.persona ? { resolvePersona: coco.persona } : {}), ...(coco.wireTrailingNote ? { wireTrailingNote: coco.wireTrailingNote } : {}), ...(coco.conversationTurnLimit ? { conversationTurnLimit: coco.conversationTurnLimit } : {}), ...(coco.conversationTurnStartIds ? { conversationTurnStartIds: () => coco.conversationTurnStartIds!() } : {}) }
              : {
                agentSystemPrompt: "You are a Larry Agent execution agent working in a project session. Coco is the commander that assigned the saved objective and acceptance criteria. Use normal Larry Agent capabilities with Full permissions and its configured Shell, MCP and tool approvals. Respect excluded projects. Coco may send revised requirements through steer or queued prompts; preserve the existing context and incorporate those requirements. Ask Coco when a technical decision is needed; it will escalate to the user when necessary. Do not claim completion without concrete evidence. Work only while Larry Agent is running.",
                extraSystemPrompt: coco.extraSystemPrompt ?? "",
              }),
          } : {}),
          checkpoint: () => {
            if (!ownsTurn()) throw new Error("Cannot persist a superseded turn");
            upsertSession(db, current.session);
          },
          gate: {
            authorizeTool: (name, args) => executionAccess()?.assertTool(name, args),
            assertPath: path => executionAccess()?.assertPath(path),
            beforeToolExecute: (name, args) => executionAccess()?.beforeToolExecute(name, args),
            cocoShell: input => executionAccess()?.cocoShell?.(input) ?? execShellProcess(input),
            cocoMcpCall: (serverId, name, args, signal) => executionAccess()?.cocoMcpCall?.(serverId, name, args, signal) ?? mcpManager.callTool(serverId, name, args, signal),
            cocoProjectPath: workspaceId => {
              const resolveProject = executionAccess()?.cocoProjectPath;
              if (!resolveProject) throw new Error("workspace_id is only available to CoCo; omit it to use this session's workspace.");
              return resolveProject(workspaceId);
            },
            get fullPermissionsEnabled() {
              return turnFullPermissions || cocoSupervisesSession(sessionId);
            },
            get reviewHighRisk() {
              const access = executionAccess();
              return access ? access.role === undefined : cocoSupervisesSession(sessionId);
            },
            enableFullPermissions() {
              turnFullPermissions = true;
            },
            requestConfirmation: (input) => {
              const access = executionAccess();
              if (access && access.role !== "commander") return access.confirm?.(input) ?? Promise.resolve(false);
              computerUseWindows().restore({ focus: true });
              cursorOverlay().pause();
              return requestToolConfirmation(sessionId, input).finally(() => cursorOverlay().resume());
            },
            requestUserAsk: (input) => {
              const access = executionAccess();
              if (access && access.role !== "commander") {
                const { desktopPassword: _desktopOnly, handoffQrPng: _qr, ...ask } = input;
                return access.ask?.(ask) ?? Promise.resolve(null);
              }
              if (input.keepDesktop) {
                const target = input.desktopPassword;
                const localInput = target && !desktopInitiated
                  ? { ...input, desktopPassword: { destination: target.destination, fill: target.fill } }
                  : input;
                return computerUseWindows().keepDesktop(() => requestUserAsk(sessionId, localInput, abort.signal), sessionId);
              }
              computerUseWindows().restore({ focus: true });
              cursorOverlay().pause();
              return requestUserAsk(sessionId, input, abort.signal).finally(() => cursorOverlay().resume());
            },
            ...(desktopInitiated && dependencies.handoffLogins && req.headless !== true ? {
              trySavedHandoffPassword: async (target, signal) => {
                const vault = dependencies.handoffLogins;
                const login = target.login;
                if (!vault || !login || login.account === undefined || executionAccess() || signal?.aborted) return "not-found";
                const accounts = login.account ? [login.account] : await vault.accounts(login.origin);
                const account = accounts.length === 1 ? accounts[0] : undefined;
                if (!account || signal?.aborted) return "not-found";
                let attempted = false;
                const filled = await computerUseWindows().keepDesktop(() => vault.use(login.origin, account, password => {
                  if (signal?.aborted) return Promise.resolve(false);
                  attempted = true;
                  return target.fill(password, signal, { account, requireAccountField: true });
                }), sessionId);
                return filled ? "filled" : attempted ? "failed" : "not-found";
              },
            } : {}),
            headless: req.headless === true,
          },
          autoSkillSummarize,
          createId: () => randomUUID(),
          signal: abort.signal,
          maxModelIterations: resolveMaxModelIterations(settings),
          maxTurnTokens: resolveMaxTurnTokens(settings),
          unlimitedTurnBudgets: coco ? false :
            current.session.composerInfinite ??
            resolvedSettings.composerInfinite,
          contextLimitTokens: resolveContextLimitTokens(settings),
          compactTriggerRatio: resolveCocoCompaction(coco).compactTriggerRatio ?? resolveCompactTriggerRatio(settings),
          iterationProtectRawIterationCount: resolveIterationProtectRawIterationCount(settings),
          iterationProtectTokenRatio: resolveCocoCompaction(coco).iterationProtectTokenRatio ?? resolveIterationProtectTokenRatio(settings),
          environmentContext: {
            flags: resolveEnvironmentContextFlags(settings),
            workspace: {
              id: current.session.workspaceId,
              name:
                getWorkspace(db, current.session.workspaceId)?.name ??
                current.session.workspaceId,
              path: current.session.workspacePath,
            },
            locale: collectLocaleSnapshot(),
          },
          getVisionClient: () =>
            resolveVisionClient(
              appDataRoot,
              projectPath,
              current.session.providerId,
            ),
          getImageGenClient: () =>
            resolveImageGenClient(appDataRoot, projectPath),
          uploadImageGenInput: async (bytes, mimeType, ext) => {
            const upload = await resolveImageGenInputUploader(appDataRoot);
            return upload(bytes, mimeType, ext);
          },
          ...(hooks ? { hooks } : {}),
          sessionDb: db,
          runMode,
          ...(fsmGraphConfig ? { fsmGraphConfig } : {}),
          ...(fsmGraphId ? { fsmGraphId } : {}),
          ...(req.controlIntent ? { controlIntent: req.controlIntent } : {}),
          listAgentSessions: () =>
            [...sessions.values()]
              .filter(live => !["coco_chat","coco_internal"].includes(live.session.source??"") && (!executionAccess() || executionAccess()?.allowWorkspace?.(live.session.workspaceId) !== false))
              .map((live) => ensureSessionHydrated(live.session.id)!.session)
              .filter((s) => s.type === "agent"),
          listSessionHistory: () => loadSummarizedHistory(db).filter(record => !executionAccess() || executionAccess()?.allowWorkspace?.(record.workspaceId) !== false),
          fsmGraphLibrary: {
            execute: async (family, input, owner) => {
              const result = await executeGraphAuthoring(family, input, owner);
              if (result.ok && result.deleted && typeof result.deleted === "string") detachFsmGraphFromSessions(result.deleted);
              return result;
            },
          },
          ...(loopsToolPort ? { loops: loopsToolPort } : {}),
          ...(notifyToolPort ? { notify: notifyToolPort } : {}),
          listWorkspaces: () =>
            loadAllWorkspaces(db).filter(w => !executionAccess() || executionAccess()?.allowWorkspace?.(w.id) !== false).map((w) => ({ id: w.id, name: w.name })),
          onEvent: (event) => {
            if (!ownsTurn()) return;
            broadcast("agent:stream", { sessionId, event });
            if (event.type === "fsm_node" && event.phase === "enter") {
              if (fsmGraphId) {
                current.session.fsmLastGraphId = fsmGraphId;
                current.session.fsmLastGraphMode = null;
              } else {
                current.session.fsmLastGraphId = null;
                current.session.fsmLastGraphMode =
                  workflowModeFromComposerRunMode(runMode);
              }
              current.session.fsmLastNodeId = event.nodeId;
              current.session.fsmLastNodeAt = Date.now();
            }
            if (shouldEmitSessionUpdated(event)) {
              emitSessionUpdated(current.session);
            }
          },
          desktopNotify: (input) =>
            hostAdapter().notifyTaskDone({ ...input, sessionId: current.session.id }),
          requestComposerRunMode: (mode) => {
            current.pendingRunModeRequest = mode;
            agentLogInfo("turn.run_mode_requested", {
              sessionId,
              mode,
            });
          },
          runShell: (input) => {
            if (coco) throw new Error("Custom FSM shell execution is unavailable to Coco");
            return runFsmShellScript(input, current.session.workspacePath);
          },
          blackboardGet: (key) => current.session.fsmBlackboard?.[key],
          blackboardSet: (key, value) => {
            const next: Record<string, unknown> = {
              ...(current.session.fsmBlackboard ?? {}),
            };
            if (value === null || value === undefined) {
              delete next[key];
            } else {
              next[key] = value;
            }
            if (
              Buffer.byteLength(JSON.stringify(next), "utf8") >
              FSM_BLACKBOARD_MAX_BYTES
            ) {
              return {
                ok: false as const,
                error: `blackboard write rejected: serialized size exceeds the ${FSM_BLACKBOARD_MAX_BYTES}-byte cap`,
              };
            }
            current.session.fsmBlackboard =
              Object.keys(next).length > 0 ? next : null;
            if (key === "phase") {
              current.session.phase =
                typeof value === "string" && value.trim()
                  ? value.trim()
                  : null;
            }
            try {
              updateFsmBlackboard(db, sessionId, current.session.fsmBlackboard);
            } catch (err) {
              return {
                ok: false as const,
                error: `blackboard write failed to persist: ${String(err)}`,
              };
            }
            return { ok: true as const };
          },
        });

        if (!ownsTurn()) return;
        if (abort.signal.aborted) {
          if (current.session.status !== "cancelled") {
            current.session.status = "cancelled";
            current.session.progressText = "Cancelled";
            broadcast("agent:stream", { sessionId, event: { type: "done", reason: "cancelled" } });
          }
          return;
        }

        const turnMessages = current.session.messages.slice(turnStartIndex);
        const isFirstTurn = turnStartIndex === 0;

        if (
          !coco && current.session.type === "agent" &&
          current.session.status === "idle"
        ) {
          const hasUserText = turnMessages.some(
            (m) =>
              m.role === "user" &&
              m.parts.some(
                (p) => p.type === "text" && p.text.trim().length > 0,
              ),
          );
          if (isFirstTurn && hasUserText) {
            scheduleSessionTitle({
              sessionId,
              turnMessages,
              client: { ...turnClient },
              applyTitle: (title) => {
                const liveSession = sessions.get(sessionId);
                if (!liveSession || liveSession !== current) return;
                if (liveSession.session.title === title) return;
                liveSession.session.title = title;
                liveSession.session.updatedAt = Date.now();
                persistSession(db, liveSession.session);
                emitSessionUpdated(liveSession.session);
              },
            });
          }
          if (hasUserText) {
            const extractClient = { ...turnClient };
            if (resolvedSettings.userMemoryAutoExtract !== false) {
              scheduleUserMemoryExtract({
                sessionId,
                turnMessages,
                client: extractClient,
              });
            }
            const workspacePath = current.session.workspacePath?.trim() ?? "";
            if (
              workspacePath &&
              resolvedSettings.projectMemoryAutoExtract !== false
            ) {
              scheduleProjectMemoryExtract({
                sessionId,
                workspacePath,
                turnMessages,
                client: extractClient,
              });
            }
          }
        }
      } catch (err) {
        if (!ownsTurn()) return;
        const message = err instanceof Error ? err.message : String(err);
        agentLogError("turn.exception", {
          sessionId,
          message,
          ...(err instanceof Error && err.stack
            ? { stack: err.stack.slice(0, 4000) }
            : {}),
        });
        current.session.status = "error";
        current.session.progressText = message;
        current.session.updatedAt = Date.now();
        const last = current.session.messages[current.session.messages.length - 1];
        const lastText =
          last?.role === "system" &&
          last.parts.length === 1 &&
          last.parts[0]?.type === "text"
            ? last.parts[0].text.trim()
            : "";
        if (lastText !== message.trim()) {
          current.session.messages.push({
            id: randomUUID(),
            role: "system",
            createdAt: Date.now(),
            parts: [{ type: "text", text: message, error: true }],
          });
        }
        broadcast("agent:stream", {
          sessionId,
          event: { type: "error", message },
        });
        broadcast("agent:stream", {
          sessionId,
          event: { type: "done", reason: "error" },
        });
      } finally {
        if (ownsTurn()) {
          computerUseWindows().restoreForSession(sessionId, {
            focus: req.headless !== true && !executionAccess() && current.session.source !== "coco",
          });
        }
        cursorOverlay().release();
        if (!ownsTurn()) return;
        if (powerGuardAcquired) hostAdapter().powerGuard.release(sessionId);
        const restored = rollbackCancelledTurnPrompt({
          session: current.session,
          turnStartIndex,
          aborted: abort.signal.aborted,
          fallback: req.continuation
            ? null
            : { text, attachments },
        });
        if (restored) {
          if (current.session.status === "error") {
            current.session.status = "cancelled";
            current.session.progressText = "Cancelled";
          }
          current.session.updatedAt = Date.now();
          current.pendingPromptRestore = restored;
          agentLogInfo("turn.prompt_restored", {
            sessionId,
            textChars: restored.text.length,
            attachments: restored.attachments.length,
          });
        }
        const demoted = demoteArmedOnTurnEnd(current.promptQueue);
        if (demoted.changed) {
          current.promptQueue = demoted.items;
          emitPromptQueue(current);
        }
        turnLifecycles.finish(current.session,lifecycleTurnId,unfinishedTurnEffects(current.session,turnStartIndex),current.session.status==="error"?current.session.progressText:undefined);
        current.pauseRequested = false;
        current.abort = null;
        notifyTurnActivity(sessionId);
        notifySettle();
        current.interruptPort = { fire: null };
        const planApprovalQueued = current.planApproveQueued === true;
        const turnContext = current.activeTurnContext;
        current.activeTurnContext = null;
        persistSession(db, current.session);
        emitSessionUpdated(current.session);
        if (current.pendingRunModeRequest) {
          const target = current.pendingRunModeRequest;
          current.pendingRunModeRequest = null;
          const effectiveRunMode =
            current.session.composerRunMode ?? prefSettings.composerRunMode;
          const declineReason =
            current.promptQueue.length > 0
              ? "prompt_queue"
              : planApprovalQueued
                ? "plan_approval_queued"
                : effectiveRunMode === target
                  ? "already_on_mode"
                  : null;
          if (declineReason) {
            agentLogInfo("turn.run_mode_declined", {
              sessionId,
              mode: target,
              reason: declineReason,
            });
          } else {
            try {
              void setComposerPrefs(sessionId, { runMode: target });
              agentLogInfo("turn.run_mode_applied", {
                sessionId,
                mode: target,
              });
            } catch (err) {
              agentLogError("turn.run_mode_apply_failed", {
                sessionId,
                mode: target,
                message: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }
        if (restored) {
          broadcast("agent:stream", {
            sessionId,
            event: {
              type: "prompt_restored",
              text: restored.text,
              attachments: restored.attachments.map((draft) => ({
                path: draft.path,
                name: draft.name,
                kind: draft.kind,
                mimeType: draft.mimeType,
                ...(draft.sizeBytes !== undefined
                  ? { sizeBytes: draft.sizeBytes }
                  : {}),
              })),
            },
          });
        }
        coco?.signal.removeEventListener("abort", cancelCoco);
        if (cocoTurns.get(sessionId) === req.cocoExecutionId) cocoTurns.delete(sessionId);
        if (coco) { drainPromptQueue(current, false, turnContext ?? null); return; }
        drainQueuedPlanApproval(sessionId, current);
        drainPromptQueue(
          current,
          planApprovalQueued,
          turnContext ?? null,
        );
      }
    })();

    return { sessionId };
  }

  function drainQueuedPlanApproval(
    sessionId: string,
    current: LiveSession,
  ): void {
    if (!current.planApproveQueued) return;
    current.planApproveQueued = false;
    startApprovedPlan(sessionId, current);
  }

  function drainPromptQueue(
    current: LiveSession,
    planApprovalTookPrecedence: boolean,
    turnContext: LiveSession["activeTurnContext"],
  ): boolean {
    const sessionId = current.session.id;
    const decision = promptQueueDrainDecision({
      queueLength: current.promptQueue.length,
      status: current.session.status,
      hasAbort: current.abort !== null,
      compacting: current.compacting === true,
      waitingInput:
        Boolean(current.session.pendingUserAsk) ||
        [...pendingApprovals.values()].some(
          (pending) => pending.sessionId === sessionId,
        ),
      planApprovalTookPrecedence,
      draining: current.promptQueueDraining === true,
    });
    if (!decision.drain) {
      if (current.promptQueue.length > 0) {
        agentLogInfo("turn.prompt_queue_hold", {
          sessionId,
          reason: decision.reason ?? "unknown",
          queueLength: current.promptQueue.length,
        });
      }
      return false;
    }

    const next = current.promptQueue[0];
    if (!next) return false;
    const cap = getCocoExecution(cocoPromptAccess.get(next.id));
    if (cap && !cap.canStartTurn()) return false;
    current.promptQueue = current.promptQueue.slice(1);
    emitPromptQueue(current);
    return startQueuedPromptTurn(current, next, "drain", turnContext);
  }

  function startQueuedPromptTurn(
    current: LiveSession,
    prompt: QueuedPrompt,
    via: "drain" | "manual",
    turnContext?: LiveSession["activeTurnContext"],
  ): boolean {
    const sessionId = current.session.id;
    if (current.session.source === "coco_chat") {
      try {
        if (cocoChatPromptHandler?.start(sessionId, prompt)) return true;
      } catch (error) {
        agentLogError("coco.chat_queue_start_failed", { sessionId, promptId: prompt.id, message: String(error) });
      }
      current.promptQueue = [prompt, ...current.promptQueue];
      emitPromptQueue(current);
      return false;
    }
    const executionId = cocoPromptAccess.get(prompt.id);
    const access = getCocoExecution(executionId);
    if (executionId && (!access || access.signal.aborted)) { cocoPromptAccess.delete(prompt.id); return false; }
    if (access && !access.canStartTurn()) { current.promptQueue = [prompt, ...current.promptQueue]; emitPromptQueue(current); return false; }
    current.promptQueueDraining = true;
    agentLogInfo("turn.prompt_queue_started", {
      sessionId,
      promptId: prompt.id,
      via,
      remaining: current.promptQueue.length,
    });
    void startTurn({
      sessionId,
      userText: prompt.userText,
      attachments: prompt.attachments,
      fullPermissions: access ? true : turnContext?.fullPermissions === true,
      ...(executionId ? { source: "coco" as const, cocoExecutionId: executionId } : {}),
      ...(turnContext?.autoSkillSummarize === true
        ? { autoSkillSummarize: true }
        : {}),
    })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        agentLogError("turn.prompt_queue_start_failed", {
          sessionId,
          promptId: prompt.id,
          message,
        });
        if (!executionId) current.promptQueue = [prompt, ...current.promptQueue];
        current.session.messages.push({
          id: randomUUID(),
          role: "system",
          createdAt: Date.now(),
          parts: [
            {
              type: "text",
              text: `Queued message could not start a turn: ${message}`,
              error: true,
            },
          ],
        });
        current.session.updatedAt = Date.now();
        persistSession(db, current.session);
        emitSessionUpdated(current.session);
        emitPromptQueue(current);
      })
      .finally(() => {
        cocoPromptAccess.delete(prompt.id);
        current.promptQueueDraining = false;
      });
    return true;
  }

  function discardPlan(sessionId: string): { ok: true } | { ok: false; error: string } {
    const current = sessions.get(sessionId);
    if (!current) {
      return { ok: false, error: "Session not found." };
    }

    current.planApproveQueued = false;
    if (current.abort) {
      cancelTurn(sessionId);
    }

    agentLogInfo("plan.discarded", { sessionId, via: "control_intent" });
    void startPlanControlTurn(sessionId, "discard").catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      agentLogError("plan.discard_start_failed", { sessionId, message });
    });
    return { ok: true };
  }

  async function approvePlan(
    sessionId: string,
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const current = sessions.get(sessionId);
    if (!current) {
      return { ok: false, error: "Session not found." };
    }
    if (current.abort) {
      current.planApproveQueued = true;
      current.session.progressText = "Approved — starting after this turn…";
      current.session.updatedAt = Date.now();
      emitSessionUpdated(current.session);
      agentLogInfo("plan.approve_queued", { sessionId });
      return { ok: true };
    }

    return startApprovedPlan(sessionId, current);
  }

  function startApprovedPlan(
    sessionId: string,
    current: LiveSession,
  ): { ok: true } {
    agentLogInfo("plan.approved", { sessionId, via: "control_intent" });

    void startPlanControlTurn(sessionId, "approve").catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      agentLogError("plan.approve_start_failed", { sessionId, message });
      const session = current.session;
      session.status = "idle";
      session.progressText = "";
      session.updatedAt = Date.now();
      persistSession(db, session);
      emitSessionUpdated(session);
      broadcast("agent:stream", { sessionId, event: { type: "error", message } });
      broadcast("agent:stream", { sessionId, event: { type: "done", reason: "error" } });
    });

    return { ok: true };
  }

  async function startPlanControlTurn(
    sessionId: string,
    controlIntent: "approve" | "discard",
  ): Promise<StartTurnResponse> {
    const live = sessions.get(sessionId);
    const settings = withSettingsDefaults(await readSettings());
    return startTurn({
      sessionId,
      userText: "",
      suppressUserMessage: true,
      fullPermissions: true,
      runMode:
        live?.session.composerRunMode ?? settings.composerRunMode,
      controlIntent,
    });
  }

  function persistRunningSessionsOnQuit(): void {
    let flushed = 0;
    for (const live of sessions.values()) {
      if (live.session.status !== "running") continue;
      persistSession(db, live.session);
      flushed += 1;
    }
    if (flushed > 0) {
      agentLogInfo("quit.persist_running_sessions", { count: flushed });
    }
  }

  return {
    database: db,
    prepareCocoTool: (sessionId: string, executionId: string, name: string, args: import("../session/types.js").JsonObject) => {
      const access = getCocoExecution(executionId), live = sessions.get(sessionId);
      if (!access || access.signal.aborted || !live || live.abort || live.session.workspaceId !== access.workspaceId) throw new Error("Coco tool replay is unavailable");
      access.assertTool(name, args);
      ensureSessionHydrated(sessionId);
      const assistantMessageId = randomUUID(), toolCallId = randomUUID();
      live.session.messages.push({ id: assistantMessageId, role: "assistant", createdAt: Date.now(), parts: [{ type: "tool_call", id: toolCallId, name, status: "pending", arguments: args, argumentsRaw: JSON.stringify(args) }] });
      persistSession(db, live.session);
      return { assistantMessageId, toolCallIds: [toolCallId] };
    },
    superviseCocoSession, enqueueCocoPrompt, clearCocoPrompts,
    hasCocoPrompts: id => [...sessions.values()].some(live => live.promptQueue.some(prompt => cocoPromptAccess.get(prompt.id) === id)),
    isCocoTurnActive: (sessionId, id) => cocoTurns.get(sessionId) === id && !!sessions.get(sessionId)?.abort,
    appendCocoChatNotice: (id,noticeId,text) => {
      const live=sessions.get(id);
      if(!live || live.abort || live.session.source!=="coco_chat" || live.compacting)return false;
      ensureSessionHydrated(id);
      if(live.session.messages.some(m=>m.id===noticeId))return true;
      live.session.messages.push({id:noticeId,role:"assistant",createdAt:Date.now(),parts:[{type:"text",text}]});
      live.session.updatedAt=Date.now();persistSession(db,live.session);emitSessionUpdated(live.session);return true;
    },
    createCocoChatSession: async ({ providerId, seedMessages }) => {
      const workspace = getWorkspace(db, COCO_HOME_WORKSPACE_ID);
      if (!workspace) throw new Error("CoCo home workspace is unavailable");
      const settings = withSettingsDefaults(await readSettings());
      const provider = (providerId ? settings.providers.find(p => p.id === providerId) : undefined) ?? resolveActiveProvider(settings);
      const now = Date.now();
      const session: Session = {
        id: randomUUID(), type: "agent", title: titleFromPrompt("", []), createdAt: now, updatedAt: now,
        status: "idle", progressText: "", messages: structuredClone(seedMessages ?? []),
        model: provider.modelId, providerId: provider.id, workspaceId: workspace.id, workspacePath: workspace.path,
        pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null,
        composerRunMode: "agent", source: "coco_chat",
      };
      sessions.set(session.id, { session, hydrated: true, abort: null, interruptPort: { fire: null }, promptQueue: [], pauseRequested: false });
      persistSession(db, session);
      emitSessionUpdated(session);
      return session.id;
    },
    restoreCocoChatPrompt: (id, text) => {
      const live = sessions.get(id);
      if (!live || live.abort || live.session.source !== "coco_chat" || !text.trim()) return;
      live.pendingPromptRestore = { text, attachments: [] };
      broadcast("agent:stream", { sessionId: id, event: { type: "prompt_restored", text, attachments: [] } });
      broadcast("agent:stream", { sessionId: id, event: { type: "done", reason: "error" } });
    },
    deleteCocoInternalSession: id => hardDeleteInternalSession(id),
    getTurnLifecycle: id => turnLifecycles.get(id),
    cocoRetentionCandidates: cutoff => {
      const result:CocoRetentionSlice[]=[];
      for(const live of sessions.values()){
        if(!["coco_chat","coco_internal"].includes(live.session.source??"") || live.abort || live.compacting || live.session.pendingUserAsk || live.promptQueue.length || live.pendingPromptRestore || turnLifecycles.get(live.session.id)?.pendingEffects.length || [...pendingApprovals.values()].some(a=>a.sessionId===live.session.id))continue;
        ensureSessionHydrated(live.session.id);const slice=cocoRetentionSlice(live.session,cutoff);if(slice)result.push(slice);
      }
      return result;
    },
    pruneCocoHistory: (slice,summary) => {
      const live=sessions.get(slice.sessionId);
      if(!summary.trim() || summary.length>100000 || !live || live.abort || live.compacting || live.session.pendingUserAsk || live.promptQueue.length || live.pendingPromptRestore || turnLifecycles.get(slice.sessionId)?.pendingEffects.length || [...pendingApprovals.values()].some(a=>a.sessionId===slice.sessionId))return false;
      ensureSessionHydrated(slice.sessionId);
      const current=cocoRetentionSlice(live.session,slice.cutoff);if(!current || current.digest!==slice.digest)return false;
      const next={...live.session,messages:retainedCocoMessages(live.session,current,summary,Date.now()),fsmBlackboard:null,contextUsage:{usedTokens:0,source:"estimate" as const},updatedAt:Date.now()};
      upsertSession(db,next);live.session=next;
      db.prepare("UPDATE tool_invocations SET scene_json=NULL WHERE session_id=? AND started_at<?").run(slice.sessionId,slice.cutoff);
      emitSessionUpdated(next);broadcast("agent:stream",{sessionId:slice.sessionId,event:{type:"transcript_changed"}});return true;
    },
    normalizeInterruptedTurn: id => {
      const live=sessions.get(id), lifecycle=turnLifecycles.get(id);
      if(!live || live.abort || live.session.status!=="running" || lifecycle?.state!=="interrupted")return false;
      const changed=forceEndUnendedTurn(live);
      if(changed){live.session.progressText="Interrupted turn recovered by Coco";persistSession(db,live.session);}
      return changed;
    },
    isTurnActive: (id) => !!sessions.get(id)?.abort,
    onSessionUpdated: (listener) => {
      sessionUpdatedListeners.add(listener);
      return () => sessionUpdatedListeners.delete(listener);
    },
    onTurnActivity: (listener) => {
      turnActivityListeners.add(listener);
      return () => turnActivityListeners.delete(listener);
    },
    listSessions,
    getSessionSummary: (id) => { const live = sessions.get(id); return live ? toSessionSummary(live.session) : null; },
    getSession,
    getSessionTail,
    getMessagesBefore,
    getSubagent,
    listRunningSubagents,
    listSubagents,
    getSubagentTranscript,
    searchSessions,
    startTurn,
    enqueuePrompt,
    setCocoChatPromptHandler,
    setCocoSessionSupervisionHandler,
    listCocoParkedRequests,
    reclaimCocoSession,
    listPromptQueue,
    removeQueuedPrompt,
    updateQueuedPromptText,
    removeTurnError,
    promoteQueuedPrompt,
    deferQueuedPrompt,
    moveQueuedPromptToFront,
    cancelTurn,
    takePromptRestore,
    persistRunningSessionsOnQuit,
    pauseTurn,
    resumeTurn,
    compactSession,
    clearSession,
    endSession,
    deleteSession,
    retryArchiveQueue: () => archiveWorker.retryNow(),
    respondToolApproval,
    respondUserAsk,
    respondHandoffPassword,
    listPendingToolApprovals,
    listPendingUserAsks,
    approvePlan,
    discardPlan,
    listWorkspaces,
    listArchivedWorkspaces,
    createWorkspace,
    listWorkspaceTemplates,
    inspectWorkspaceInit,
    createWorkspaceFromTemplate,
    updateWorkspace,
    deleteWorkspace,
    setWorkspaceArchived,
    setSessionArchived,
    getActiveWorkspaceId,
    setActiveWorkspaceId,
    setSessionProvider,
    setSessionSource,
    reassignSessionsUsingProvider,
    setComposerPrefs,
    detachFsmGraphFromSessions,
    memorySync,
  };
}
