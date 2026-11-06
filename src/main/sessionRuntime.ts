import { SessionTurnLifecycles, unfinishedTurnEffects, type SessionTurnStopReason, type SessionTurnLifecycle } from "../session/turnLifecycle.js";
import { cocoRetentionSlice, retainedCocoMessages, type CocoRetentionSlice } from "../session/cocoRetention.js";
import { execShellProcess } from "../tools/shellExec.js";
import { mcpManager } from "../mcp/manager.js";
import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
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
import {
  toSessionSummary,
  type CreateWorkspaceRequest,
  type SessionSummary,
  type StartTurnRequest,
  type StartTurnResponse,
  type ComposerRunMode,
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
import {
  normalizeReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
} from "../logging/agentLog.js";
/** Local OpenAI-compatible servers often need no real API key. */
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
import { HANDOFF_PROMPT_PART_ID } from "../session/types.js";
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
import { handoffDrainDropReason } from "./turnHandoffDrain.js";
import { getLoopsToolPort } from "./loops/toolAccess.js";
import { getNotifyToolPort } from "./notifyToolAccess.js";
import {
  planFsmGraphDetach,
  type FsmGraphDetachInputSession,
} from "../session/fsmGraphDetach.js";
import { LEVEL2_CONFIRMATION_TIMEOUT_MS } from "../tools/permissions.js";
import { registerBuiltins } from "../tools/index.js";
import type { UserAskAnswer, VisionClientConfig, ImageGenClientConfig, ToolApprovalRisk, ToolConfirmationSource } from "../tools/types.js";
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
import {
  applyGraphEdit,
} from "../agent/fsm/graphLibrary/applyGraphEdit.js";
import {
  createForkFromBuiltin,
  createNewGraphRecord,
  deleteFsmGraph,
  describeAction,
  describeEdge,
  getFsmGraph,
  listActionCatalogSlim,
  listEdgeCatalogSlim,
  listFsmGraphs,
  resolveCustomFsmGraphForTurn,
  saveFsmGraph,
  validateGraphConfig,
} from "../agent/fsm/graphLibrary/manager.js";
import type { FSMGraphConfig } from "../agent/fsm/types.js";
import type { TurnHandoffRequest } from "../tools/turnHandoffTool.js";
import { getCompactionStrategy } from "../agent/contextCompaction/registry.js";
import { isValidProtectTokenRatio } from "../shared/protectTokenRatio.js";

/**
 * Per-CoCo Chat compaction overrides (Settings → CoCo): only a commander
 * execution carries the getter, so Chat turns read the saved knobs fresh
 * while execution/background lanes and ordinary sessions keep the global
 * Agent settings. Undefined fields inherit the global value.
 */
function resolveCocoCompaction(coco: ReturnType<typeof getCocoExecution>): { compactTriggerRatio?: number | undefined; iterationProtectTokenRatio?: number | undefined } {
  return coco?.role === "commander" && coco.compaction ? coco.compaction() : {};
}

type LiveSession = {
  session: Session;
  /**
   * Whether session.messages is populated. Boot-loads lazily (false) until a
   * turn / explicit read hydrates it; freshly created sessions are born
   * hydrated. While false the DB stays authoritative for messages and
   * persistSession writes the session row only.
   */
  hydrated: boolean;
  abort: AbortController | null;
  /**
   * Per-turn interrupt port for explicit interruption. The running
   * turn's host fills `fire` at construction (aborts the in-flight model
   * stream without ending the turn); the turn `finally`
   * clears it. One-shot semantics live inside the host (recreated at drain).
   */
  interruptPort: { fire: (() => boolean) | null };
  /**
   * FIFO queue of user prompts submitted while a turn was running. Items
   * either drain in the turn `finally` as a **new turn** (`deferred`) or,
   * armed as `interrupt`, land at the next natural round boundary after
   * active model/tool work finishes. In-memory; never persisted (lost on app exit).
   */
  promptQueue: QueuedPrompt[];
  /** Single-flight guard for the turn-finally queue drain. */
  promptQueueDraining?: boolean;
  /**
   * Queued turn_handoff (in-memory, last-wins): drained in the turn
   * `finally` only after a `completed` turn; cleared by real user input,
   * steer, or cancel. Never persisted — lost on app exit.
   */
  pendingHandoff: TurnHandoffRequest | null;
  /**
   * Consecutive handoff-chained turns so far; reset to 0 by any real user
   * input (prompt / steer). Capped by TURN_HANDOFF_CHAIN_DEPTH_CAP.
   */
  handoffChainDepth: number;
  /** /pause queued via IPC; consumed at the next round boundary. */
  pauseRequested: boolean;
  /** /compact pass in flight; blocks turn start until it finishes. */
  compacting?: boolean;
  /**
   * Approve clicked while the review turn was still finishing. Runs as soon as
   * that turn ends so the user never has to wait for the button to work.
   */
  planApproveQueued?: boolean;
  /**
   * Composer run-mode switch requested by an FSM Action mid-turn
   * (`NodeActionSetComposerRunMode`): applied in the turn `finally` unless a
   * guard declines (queued prompts / pending plan approval / already on the
   * target mode). In-memory, last-wins; never persisted.
   */
  pendingRunModeRequest?: "agent" | "ask" | "plan" | null;
  /** Snapshot of composer settings for the in-flight parent turn. */
  activeTurnContext?: {
    runMode: ComposerRunMode;
    fullPermissions: boolean;
    autoSkillSummarize: boolean;
    reasoningEffort?: ReasoningEffort;
    /** Headless (Loops daemon) turn — asks auto-settle as cancelled. */
    headless?: boolean;
  } | null;
  /**
   * Prompt handed back after a STOP-before-content rollback (in-memory,
   * never persisted): the `prompt_restored` stream event is one-shot, so
   * this latch lets a renderer that was unmounted at rollback time fetch
   * it on remount. Take-once — the first consumer (Mac or web) wins.
   * Cleared by any new turn on the session.
   */
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
    // optional
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
/**
 * Extra `agent:stream` consumers besides renderer windows (remote relay
 * bridge). Sinks must never throw into the broadcast path.
 */
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
  // Sinks (remote relay bridge) only understand the agent:stream shape, so
  // ask-lifecycle broadcasts ride along as synthesized stream events. The
  // web console otherwise has no way to learn an ask_user card is waiting
  // for an answer (and no way to see it dismissed when answered on the Mac).
  let event: { sessionId: string; event: unknown } | null = null;
  if (channel === "agent:stream") {
    event = payload as { sessionId: string; event: unknown };
  } else if (channel === "agent:userAsk") {
    const ask = payload as { sessionId: string };
    event = { sessionId: ask.sessionId, event: { type: "user_ask", ask: payload } };
  } else if (channel === "agent:userAskDismiss") {
    const dismiss = payload as { sessionId: string };
    event = { sessionId: dismiss.sessionId, event: { type: "user_ask_dismiss", ...dismiss } };
  } else if (channel === "agent:sessionDeleted") {
    // Deleted sessions never stream again, so without this synthesized event
    // the web console would only notice on its next manual listSessions pull.
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
      // Sink errors are isolated — never break the agent loop.
    }
  }
}

function emitSessionUpdated(session: Session): void {
  broadcast("agent:sessionUpdated", toSessionSummary(session));
}

/**
 * High-frequency stream events should not fan out as sessionUpdated —
 * the conversation applies text_delta locally; the sidebar only needs
 * status / structural changes.
 */
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
      // Future turns and auxiliary clients must not resurrect the old in-memory
      // snapshot while the serialized settings write is still in flight.
      provider.responsesStateful = false;
      const changed = await disableResponsesStateful(appDataRoot, provider.id);
      if (changed) broadcast("llm:providersChanged", {});
    },
  };
}

/** Soft resolve for Plan-mode role overrides; missing key → omit from map. */
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
  // Reuse the referenced chat provider's key slot (+ `.env` fallback).
  // Local OpenAI-compatible servers often need no real key; still send a
  // placeholder Bearer so the HTTP client can call the endpoint.
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

/**
 * Resolve the dedicated ImageGen client for generate_image.
 * Returns null when the ImageGen profile is not configured in settings.
 */
async function resolveImageGenClient(
  appDataRoot: string,
  projectPath: string,
): Promise<ImageGenClientConfig | null> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(appDataRoot),
  );
  const imageGen = resolveImageGenProvider(settings);
  if (!imageGen) return null;
  // Local OpenAI-compatible servers often need no real key; still send a
  // placeholder Bearer so the HTTP client can call the endpoint.
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

/**
 * Resolve the COS/S3 uploader for generate_image input images (URL mode).
 * Returns null when object storage is not configured — the tool then
 * surfaces a clear configuration error instead of failing at upload time.
 */
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
  /** includeCoco=true also returns CoCo-owned sessions (`coco_chat` chat +
   * `coco` autonomous runs); `coco_internal` background sessions stay hidden
   * either way. Default false keeps the desktop renderer's list unchanged. */
  listSessions: (includeCoco?: boolean) => SessionSummary[];
  /** Main-process metadata lookup, including internal sessions, without reading messages. */
  getSessionSummary: (sessionId: string) => SessionSummary | null;
  getSession: (sessionId: string) => Session | null;
  /** Progressive load: session metadata + only the last N turns. */
  getSessionTail: (
    sessionId: string,
    opts?: { turns?: number },
  ) => import("../session/messageWindow.js").SessionTailResult | null;
  /** Older page ending just before the cursor message (null = stale cursor). */
  getMessagesBefore: (
    sessionId: string,
    beforeMessageId: string,
    opts?: { turns?: number },
  ) => import("../session/messageWindow.js").SessionMessageWindow | null;
  getSubagent: (
    sessionId: string,
    subagentId: string,
  ) => import("../agent/subagents/types.js").SubagentDetailSnapshot | null;
  /** Live monitor bootstrap: queued/running snapshots for a parent session. */
  listRunningSubagents: (
    sessionId: string,
  ) => import("../agent/subagents/types.js").SubagentStatusSnapshot[];
  /** Subagents window: every run for a session (live manager + DB history). */
  listSubagents: (sessionId: string) => SubagentRunSummary[];
  /** Subagents window: raw Message[] transcript for one run. */
  getSubagentTranscript: (
    sessionId: string,
    subagentId: string,
  ) => SubagentTranscript | null;
  searchSessions: (query: string) => SessionSearchHit[];
  startTurn: (req: StartTurnRequest) => Promise<StartTurnResponse>;
  /** Append a prompt to the session queue (default: after the whole turn). */
  enqueuePrompt: (req: EnqueuePromptRequest) => EnqueuePromptResponse;
  listPromptQueue: (sessionId: string) => QueuedPrompt[];
  /** CoCo Chat follow-ups must re-enter the commander with fresh scoped access. */
  setCocoChatPromptHandler(handler: {
    start(sessionId: string, prompt: QueuedPrompt): boolean;
    canInsert(sessionId: string): boolean;
  }): () => void;
  /** Handed-over sessions: CoCo answers ask_user / tool approvals on the user's behalf. */
  setCocoSessionSupervisionHandler(handler: {
    decide(sessionId: string, payload: UserAskRequestPayload): Promise<UserAskAnswer | "needs-user" | null>;
    approve(sessionId: string, payload: ToolApprovalRequestPayload): Promise<boolean | "needs-user" | null>;
    /** Live: CoCo currently supervises this session (Full permissions + high-risk review). */
    supervises(sessionId: string): boolean;
  }): () => void;
  /** CoCo-supervised requests parked on the CoCo Chat card (needs_user hand-offs). */
  listCocoParkedRequests(): { kind: "ask" | "approval"; requestId: string; sessionId: string }[];
  /** Undo CoCo session management: source back to "app", parked CoCo questions return to the user. */
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
  /** Consume a persisted turn error row (Retry click) before resending. */
  removeTurnError: (
    sessionId: string,
    messageId: string,
  ) => { ok: true } | { ok: false; error: string };
  /** Arm for mid-turn insertion, or send right away when idle. */
  promoteQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  /** Disarm back to "after this turn". */
  deferQueuedPrompt: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  moveQueuedPromptToFront: (
    sessionId: string,
    promptId: string,
  ) => PromptQueueMutationResponse;
  appendCocoChatNotice(sessionId: string, noticeId: string, text: string): boolean;
  /**
   * Hard-delete a finished `coco_internal` background session (no archive /
   * history summarization). Refuses other sources and live turns.
   */
  deleteCocoInternalSession(sessionId: string): boolean;
  /** Main-process Coco retention; never exposed as renderer/model mutations. */
  cocoRetentionCandidates(cutoff:number):CocoRetentionSlice[];
  pruneCocoHistory(slice:CocoRetentionSlice,summary:string):boolean;
  getTurnLifecycle(sessionId: string): SessionTurnLifecycle | undefined;
  normalizeInterruptedTurn(sessionId: string): boolean;
  cancelTurn: (sessionId: string, reason?: SessionTurnStopReason) => boolean;
  /**
   * Take-once STOP-rollback prompt: what the composer should restore after
   * a turn was cancelled before any model content landed. Null when the
   * latch is empty or already consumed.
   */
  takePromptRestore: (sessionId: string) => PromptRestorePayload | null;
  /**
   * before-quit snapshot: flush running-turn transcripts (normally held in
   * memory until the turn ends) so quitting mid-turn loses nothing. Boot
   * convergence then normalizes the persisted running rows to cancelled /
   * waiting-for-answer.
   */
  persistRunningSessionsOnQuit: () => void;
  /** /pause: queue graceful pause; turn finishes `paused` at round boundary. */
  pauseTurn: (sessionId: string, reason?: import("../session/turnLifecycle.js").SessionTurnStopReason) => { ok: boolean; reason?: string };
  /** /resume: continue a paused session (system note + optional continuation turn). */
  resumeTurn: (req: {
    sessionId: string;
    fullPermissions: boolean;
    autoSkillSummarize?: boolean;
    note?: string;
    /** When false, clear paused → idle with a note only (CoCo then starts its own turn). Default true. */
    startContinuation?: boolean;
  }) => Promise<{ ok: boolean; reason?: string }>;
  /** /compact: force one compaction pass on a quiescent session. */
  compactSession: (
    sessionId: string,
    cocoExecutionId?: string,
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
  deleteSession: (sessionId: string) => boolean;
  /**
   * Force-retry every pending session_history summarize task now, ignoring
   * remaining backoff (provider settings changed — probe immediately).
   */
  retryArchiveQueue: () => void;
  respondToolApproval: (req: ToolApprovalResponseRequest) => boolean;
  respondUserAsk: (req: UserAskResponseRequest) => boolean;
  /** Live pending level-2 approvals for a session (rehydrate after remount). */
  listPendingToolApprovals: (sessionId: string) => ToolApprovalRequestPayload[];
  /** Live pending ask_user prompts for a session (rehydrate after remount). */
  listPendingUserAsks: (sessionId: string) => UserAskRequestPayload[];
  approvePlan: (
    sessionId: string,
  ) => Promise<{ ok: true } | { ok: false; error: string }>;
  discardPlan: (
    sessionId: string,
  ) => { ok: true } | { ok: false; error: string };
  listWorkspaces: () => Workspace[];
  /** Workspaces with at least one archived session (derived, for Archived view). */
  listArchivedWorkspaces: () => Workspace[];
  createWorkspace: (req: CreateWorkspaceRequest) => Promise<Workspace>;
  /** Template registry for the new-workspace menu (renderer preview). */
  listWorkspaceTemplates: () => WorkspaceTemplateInfo[];
  /** git/npm detection for the create-dialog rows. */
  inspectWorkspaceInit: (req: {
    path: string;
    templateId: WorkspaceTemplateId;
  }) => TemplateInitInspection;
  /** Full template init flow; progress streams through the emit sink. */
  createWorkspaceFromTemplate: (
    req: unknown,
    emit: (progress: WorkspaceInitProgress) => void,
  ) => Promise<TemplateInitOutcome>;
  updateWorkspace: (req: UpdateWorkspaceRequest) => Promise<Workspace>;
  deleteWorkspace: (workspaceId: string) => Promise<boolean>;
  /**
   * Batch archive/unarchive all sessions under a workspace; throws on running
   * sessions (archive direction).
   */
  setWorkspaceArchived: (
    workspaceId: string,
    archived: boolean,
  ) => Promise<Workspace>;
  /** Archive/unarchive a single session; throws when the session is running. */
  setSessionArchived: (
    sessionId: string,
    archived: boolean,
  ) => SessionSummary;
  getActiveWorkspaceId: () => Promise<string | null>;
  setActiveWorkspaceId: (workspaceId: string) => Promise<string>;
  /**
   * Bind a chat LLM profile to an idle session. Does not change settings
   * `activeProviderId` (that remains the default for new sessions only).
   */
  setSessionProvider: (
    sessionId: string,
    providerId: string,
  ) => Promise<Session>;
  /** Single-field origin update (CoCo adoption / boot badge repair). */
  setSessionSource: (
    sessionId: string,
    source: import("../session/types.js").SessionSource,
  ) => boolean;
  /**
   * After a remote Token Hub delete, point sessions that still name the
   * removed profile at the settings default. Active turns and compactions
   * keep their binding; the next send resolves a removed profile to default.
   */
  reassignSessionsUsingProvider: (removedProviderId: string) => Promise<void>;
  /** Pin per-session composer prefs (schema v14); null un-pins a field. */
  setComposerPrefs: (
    sessionId: string,
    patch: {
      runMode?: "agent" | "ask" | "plan" | "custom" | null;
      fsmGraphId?: string | null;
      infinite?: boolean | null;
      reasoningEffort?: ReasoningEffort | null;
    },
  ) => Promise<Session>;
  /**
   * Pre-delete guard for a custom FSM graph: sessions pinning it
   * (`runMode custom` + matching `fsmGraphId`) are flipped to Auto.
   * Throws (nothing changed) when any of them are mid-turn.
   * Returns the ids of the sessions flipped to Auto.
   */
  detachFsmGraphFromSessions: (sessionId: string) => string[];
  /** Cross-device memory sync engine (M2 archive channel). */
  memorySync: MemorySync;
};

/**
 * App-level session + workspace store.
 * `appDataRoot` is Electron userData (settings.json + sessions.sqlite).
 */
export type SessionStoreDependencies = {
  resolveClient?: typeof resolveClient;
  readSettings?: () => Promise<WorkspaceSettings | null>;
  runAgentTurn?: typeof runAgentTurn;
  /** Isolated hosts/tests may own the background workers themselves. */
  startBackgroundServices?: boolean;
};

export function createSessionStore(
  appDataRoot: string,
  dependencies: SessionStoreDependencies = {},
): SessionStore {
  const resolveStoreClient = dependencies.resolveClient ?? resolveClient;
  const runStoreTurn = dependencies.runAgentTurn ?? runAgentTurn;
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
    }
  >();

  // CoCo-supervised requests parked for the CoCo Chat card: a needs_user
  // hand-off from a handed-over session waits there instead of the session's
  // own ask UI. FIFO by insertion; the settle paths unpark automatically.
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
      // Supervised hand-over approvals can outlive the 30s popup timer (the
      // decide model allows up to 60s), so the timer only arms once the
      // request is actually delivered to the user.
      const deliverToUser = (): void => {
        const pending = pendingApprovals.get(requestId);
        if (pending && !pending.timer) {
          pending.timer = setTimeout(() => {
            settleApproval(requestId, false);
          }, LEVEL2_CONFIRMATION_TIMEOUT_MS);
        }
        broadcast("agent:toolApproval", payload);
      };
      // Handed-over sessions: CoCo decides tool approvals too (D-6); a
      // decline or "needs-user" falls back to the user's approval popup.
      const supervision = cocoSessionSupervisionHandler;
      if (supervision && sessions.get(sessionId)?.session.source === "coco") {
        void supervision.approve(sessionId, payload).then((outcome) => {
          if (!pendingApprovals.has(requestId)) return; // settled meanwhile
          // Take-back mid-decision: CoCo's verdict is void, the user decides.
          if (sessions.get(sessionId)?.session.source !== "coco") {
            deliverToUser();
            return;
          }
          if (outcome === null) {
            deliverToUser();
            return;
          }
          if (outcome === "needs-user") {
            // Parked for the CoCo Chat card (D-4); an answer there or a turn
            // abort unparks it.
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

  function requestUserAsk(
    sessionId: string,
    input: {
      toolCallId: string;
      question: string;
      options: string[];
      optionDetails?: import("../shared/askUser.js").UserAskOption[];
      allowCustom: boolean;
      allowMultiple?: boolean;
      assistantMessageId?: string;
      remainingToolCallIds?: string[];
    },
    signal?: AbortSignal,
  ): Promise<UserAskAnswer | null> {
    if (signal?.aborted) {
      return Promise.resolve(null);
    }

    const requestId = randomUUID();
    const payload: UserAskRequestPayload = {
      requestId,
      sessionId,
      toolCallId: input.toolCallId,
      question: input.question,
      options: input.options,
      ...(input.optionDetails ? { optionDetails: input.optionDetails } : {}),
      allowCustom: input.allowCustom,
      allowMultiple: input.allowMultiple === true,
    };

    const live = sessions.get(sessionId);
    if (live) {
      const ctx = live.activeTurnContext;
      live.session.pendingUserAsk = {
        requestId,
        toolCallId: input.toolCallId,
        question: input.question,
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
      });
      const deliverToUser = (): void => {
        broadcast("agent:userAsk", payload);
        // Headless (Loops daemon) turns: no renderer will ever respond.
        // Settle right now through the same path respondUserAsk uses for a
        // user cancel — the awaiting tool gets a cancelled answer immediately
        // and the turn keeps running instead of hanging forever.
        const awaitDecision = resolveAskAwait({
          headless: live?.activeTurnContext?.headless === true,
        });
        if (awaitDecision.kind === "auto-settle") {
          agentLogInfo("ask_user.headless_auto_settle", {
            sessionId,
            requestId,
          });
          settleUserAsk(requestId, awaitDecision.answer);
        }
      };
      // Handed-over sessions: CoCo answers on the user's behalf first. The
      // supervision handler resolves with the answer (settled here), or
      // null/"needs-user" when CoCo declines — then the ask reaches the user.
      const supervision = cocoSessionSupervisionHandler;
      if (supervision && live?.session.source === "coco") {
        void supervision.decide(sessionId, payload).then((outcome) => {
          if (!pendingUserAsks.has(requestId)) return; // aborted meanwhile
          // Take-back mid-decision: CoCo's answer is void, the user answers.
          if (sessions.get(sessionId)?.session.source !== "coco") {
            deliverToUser();
            return;
          }
          if (outcome === "needs-user") {
            // Parked for the CoCo Chat card (D-4); an answer there or a turn
            // abort unparks it.
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

  // Sync enabled flag from settings (default on when unset).
  void readWorkspaceSettings(appDataRoot).then((settings) => {
    setToolStatsEnabled(withSettingsDefaults(settings).toolStatsEnabled);
  });

  const sessions = new Map<string, LiveSession>();
  // Capability tokens never enter public queue rows, persistence or IPC.
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

  /**
   * Sidebar take-back: undo CoCo management of a session (hand-over or CoCo
   * origin). The source flips back to "app" — supervision stops immediately,
   * restarts keep it that way (backfill only repairs absent sources) — and
   * questions parked on the CoCo Chat card are delivered to the user now.
   */
  function reclaimCocoSession(sessionId: string): { ok: true } | { ok: false; error: string } {
    const live = sessions.get(sessionId);
    if (!live) return { ok: false, error: "Unknown session." };
    if (live.session.archived) return { ok: false, error: "This session is archived." };
    if (live.session.source === "coco") {
      if (!setSessionSource(sessionId, "app")) return { ok: false, error: "Unknown session." };
      // Parked needs_user hand-offs belong to the user again; approval timers
      // arm only now — the 30s window starts when the popup is visible.
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
    // Steering/adopting a user-created session claims the CoCo origin marker
    // (sidebar badge). Execution lanes only — chat/internal sessions are born
    // with their own markers. 'app' is an absent field in memory.
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

  /**
   * Lazy-aware persist (shadows the module-level full writer inside the
   * store): sessions whose messages were never hydrated keep an empty
   * in-memory array — the DB row is the only authoritative copy, so only the
   * session row is written and the message table is left untouched.
   */
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

  /**
   * Populate a lazily-loaded session's messages from the DB (idempotent,
   * synchronous — better-sqlite3). Every path that reads or mutates
   * session.messages must route through a store entry that hydrates first.
   */
  function ensureSessionHydrated(sessionId: string): LiveSession | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    if (!live.hydrated) {
      live.session.messages = loadSessionMessages(db, sessionId);
      live.hydrated = true;
    }
    return live;
  }

  // Lazy boot: session rows only. Messages hydrate on first use (turn start,
  // explicit reads, search) — long histories no longer pay the load at boot.
  const loaded = loadSessionRows(db);
  console.log(
    `[session-db] opened ${sessionDbPath(appDataRoot)} loaded=${loaded.length} (messages lazy)`,
  );

  for (const session of loaded) {
    let hydrated = false;
    if (session.status === "running") {
      // Crash recovery needs the transcript (seal orphan tool calls, mark
      // cancelled / resumable ask) — hydrate just these sessions.
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
        // A quit-time flush (persistRunningSessionsOnQuit) can leave the
        // interrupted turn's trailing assistant with tool_calls that never
        // got results — seal them here so the transcript is immediately
        // honest (and wire-valid) instead of waiting for the next startTurn.
        // pendingUserAsk sessions skip this: their tool batch is resumable
        // (respondUserAsk → resumeToolBatch), unanswered siblings included.
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
      // Not yet in the map → the inner persistSession falls through to the
      // full writer, which is exactly right for these hydrated sessions.
      persistSession(db, session);
    }
    sessions.set(session.id, {
      session,
      hydrated,
      abort: null,
      interruptPort: { fire: null },
      promptQueue: [],
      pendingHandoff: null,
      handoffChainDepth: 0,
      pauseRequested: false,
    });
  }

  // Delete-archive summarize queue: one serial worker for the whole app.
  // Boot flips interrupted running rows back to pending (crash recovery);
  // every delete funnel relocates via moveSessionToHistory and kicks, and
  // settings saves kick again so a fixed provider resumes immediately.
  // Memory sync (M2) rides the same cadence: each finished summary kicks
  // the sync engine, which pushes the fresh done row on its next cycle.
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

  // Boot sync runs after sessions load so the index reflects derived
  // workspace visibility (active = unarchived sessions or empty workspace).
  if (dependencies.startBackgroundServices !== false) {
    void syncUserMemoryProjectsIndex(listWorkspaces()).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[user-memory] projects index sync failed: ${message}`);
    });
  }

  function listSessions(includeCoco = false): SessionSummary[] {
    return [...sessions.values()].filter(live => {
      const source = live.session.source ?? "";
      // `coco` (autonomous runs) has always been listed; only chat and the
      // internal background sessions are opt-in/hidden.
      if (source === "coco_internal") return false;
      if (!includeCoco && source === "coco_chat") return false;
      return true;
    })
     .map((live) => toSessionSummary(live.session))
     .sort((a, b) => b.updatedAt - a.updatedAt);
 }

  function getSession(sessionId: string): Session | null {
    // Full read ⇒ hydrate (legacy callers expect the whole transcript).
    return ensureSessionHydrated(sessionId)?.session ?? null;
  }

  /**
   * Progressive conversation load: session metadata plus only the last N
   * turns. Mirrors the renderer's turn boundaries (non-steer user messages,
   * /clear marker as hard floor). Hydrated sessions slice in memory; lazy
   * ones use the DB window query so the full transcript never materializes.
   */
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

  /**
   * Older page ending just before `beforeMessageId`. Null when the session
   * is unknown or the cursor message vanished (stale window → reload tail).
   */
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
    // Lazy path: DB window slice. A running turn's in-memory messages are
    // ahead of the DB — but running turns are always hydrated, so lazy here
    // implies idle and the DB is authoritative.
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

  /** Live monitor bootstrap: queued/running snapshots for a parent session. */
  function listRunningSubagents(sessionId: string) {
    return getSubagentManager(sessionId)?.list() ?? [];
  }

  /**
   * Subagents window list: union of the live manager (authoritative for this
   * app run, includes finished runs still in memory) and DB rows (history
   * across restarts). Live wins on id collision.
   */
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

  /** Raw transcript for the Subagents window; live manager first, DB next. */
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
    // Lazy-friendly search: SQL LIKE pre-filters message content down to
    // candidate sessions; only those hydrate. Title matches come free (titles
    // always live in memory). Hydrated sessions stay in so exact lowercasing
    // semantics are preserved where it matters (running/recent work).
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

  /**
   * Push the queue snapshot to the renderer. Every mutation broadcasts the
   * full array (not a delta) so the conversation view can mirror it verbatim —
   * with multiple queued prompts, incremental patching drifts too easily.
   */
  function emitPromptQueue(live: LiveSession): void {
    broadcast("agent:stream", {
      sessionId: live.session.id,
      event: { type: "prompt_queue", items: live.promptQueue },
    });
  }

  /** Shared reply shape for queue mutations (always carries a fresh snapshot). */
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

  /**
   * Queue a user prompt. `mode` defaults to `deferred`: the running turn is
   * never interrupted and the prompt starts a new turn once that turn ends.
   * Arming for mid-turn insertion is an explicit user action
   * (`promoteQueuedPrompt`).
   */
  function enqueuePrompt(req: EnqueuePromptRequest): EnqueuePromptResponse {
    const live = sessions.get(req.sessionId);
    if (!live) {
      throw new Error(`Unknown session: ${req.sessionId}`);
    }
    if (live.session.type !== "agent") {
      throw new Error("Only agent sessions can queue prompts");
    }
    const running = live.session.status === "running" && live.abort !== null;
    // Intake shim: legacy `steer` normalizes to interrupt; interrupt is only
    // meaningful while a turn runs, otherwise it falls back to deferred.
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
    // Real user input always wins: a queued handoff is dropped and the
    // chain-depth counter resets.
    live.pendingHandoff = null;
    live.handoffChainDepth = 0;
    agentLogInfo("turn.prompt_queued", {
      sessionId: live.session.id,
      promptId: result.queued.id,
      mode,
      queueLength: live.promptQueue.length,
      attachmentCount: result.queued.attachments.length,
    });
    emitPromptQueue(live);
    // Armed prompts are consumed at a natural graph boundary. Keep the
    // active model request, tool execution, and permission cards running.
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

  /**
   * Consume a persisted turn error message (Retry click). Pure surgery
   * lives in turnErrorConsume.ts; this guards the running turn, persists,
   * and notifies. The renderer follows up with a hidden continuation turn
   * (startTurn + continuation: "retry") — the prompt is NOT resent.
   */
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
    // Removal mutates the transcript — hydrate lazy sessions first.
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

  /**
   * User asked for this prompt to join the current turn:
   * - turn running → arm it as `interrupt` for the next natural round
   *   boundary after active model/tool work finishes.
   * - session idle → there is no turn to steer, so start one immediately.
   */
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
    // The next graph boundary drains this arm without aborting active work.
    return queueResult(live, true);
  }

  /** Undo an arm: back to "wait for the whole turn". */
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

  /**
   * Stop on a session still marked `running` with no AbortController left: the
   * turn returned without a terminal status (see `finishUnendedTurn` in
   * FsmGraphWorkflow for that bug class). Nothing is in flight to abort, so end
   * the session here — otherwise Stop is a no-op and every new send is rejected
   * as "already has a running turn" until the app restarts.
   */
  function forceEndUnendedTurn(live: LiveSession): boolean {
    if (live.session.status !== "running") return false;
    const sessionId = live.session.id;
    ensureSessionHydrated(sessionId);
    live.planApproveQueued = false;
    live.pendingHandoff = null;
    live.handoffChainDepth = 0;
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
    turnLifecycles.requestStop(sessionId,reason);
    // Approve keeps the session running while tasks are extracted, with no
    // agent turn to abort yet — Stop must still reach that request.
    if (!live.abort) return forceEndUnendedTurn(live);
    // Stop must not silently eat queued prompts: keep them, only disarm the
    // ones that were waiting for a round boundary of the turn being stopped.
    // The turn `finally` skips the drain for a cancelled turn, so nothing
    // auto-starts — the user decides what happens to the queue.
    const demoted = demoteArmedOnTurnEnd(live.promptQueue);
    if (demoted.changed) {
      live.promptQueue = demoted.items;
      emitPromptQueue(live);
    }
    // Stop after Approve means stop — do not start execution on turn end.
    live.planApproveQueued = false;
    // Cancel is user input: drop a queued handoff and reset the chain.
    live.pendingHandoff = null;
    live.handoffChainDepth = 0;
    live.abort.abort();
    return true;
  }

  /**
   * Take-once fetch of a STOP-rollback prompt (see the turn `finally`).
   * First consumer wins — the Mac renderer on remount or the web console
   * on session open — so the prompt comes back wherever the user returns.
   */
  function takePromptRestore(sessionId: string): PromptRestorePayload | null {
    const live = sessions.get(sessionId);
    if (!live) return null;
    const payload = live.pendingPromptRestore ?? null;
    live.pendingPromptRestore = null;
    return payload;
  }

  /**
   * /pause: queue a graceful pause. The running turn finishes as `paused` at
   * its next round boundary (host.enforceBudget consumes the flag). A turn
   * waiting on an ask_user answer or a permission card is already paused —
   * /pause is a no-op there (user-confirmed semantics).
   */
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

  /**
   * /resume: continue a session paused by /pause — appends a system note and
   * optionally starts a continuation turn with no user message. CoCo budget
   * recovery uses startContinuation:false so it can startTurn with its own
   * instruction. A plain user message on a paused session goes through
   * startTurn directly (paused clears itself).
   */
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
    // Paused-since-boot sessions may still be lazy — resume mutates messages.
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

  /**
   * /compact: force a manual compaction pass on a quiescent session (never
   * running / paused / waiting on cards, so it never races the turn loop's
   * own compaction). Reuses the configured strategy with force=true.
   */
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

    // Compaction reads and rewrites the transcript — hydrate first.
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
      // `/compact <keep>`: one-off protect-ratio override for this pass.
      // Invalid values (outside (0, 0.9]) are dropped — the renderer already
      // validates with the same shared helper, this is the trust boundary.
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
        // Persist the compacted window so DB reads stay honest. Source stays
        // "estimate" — renderer hydration only trusts provider readings, and
        // the next provider usage event overwrites this projection anyway.
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
    }
  }

  /**
   * /clear: soft-clear a quiescent session — append a context_clear marker
   * so the model window (and the conversation view) start fresh after it.
   * Drops the prompt queue, resets compaction/bucket state and the FSM
   * blackboard; the DB transcript stays intact (audit, nothing deleted).
   */
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

    // The clear marker appends to (and persists) the transcript — hydrate so
    // the rewritten message table keeps the full history above the marker.
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
    // /clear means "start over": queued prompts belong to the old context.
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

  /**
   * /end: fold the whole conversation into a single digest (lossy, incremental
   * — an existing summary is carried into the new one; already-covered turns
   * are never re-read). The session stays continuable with the digest as the
   * new context seed. `compacted: false` means nothing new to summarize.
   */
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

    // Compaction reads and rewrites the transcript — hydrate first.
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
      // Full digest: zero every retention window so nothing stays raw.
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
    }
  }

  /**
   * Archive-time memory snapshot: mirror the delete funnel's summarize
   * behavior without removing the session — copy the transcript into
   * session_history (pending) and let the archive worker digest it. No-op
   * (returns false) when an existing history row already covers the current
   * transcript, so re-archiving never double-summarizes.
   */
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
      // Not running under Electron — record as unknown.
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

    // A session with a turn in flight must be stopped first — deleting
    // mid-run would drop in-flight tool work and break turn bookkeeping.
    if (live.abort) return false;

    // Same mutual exclusion as /compact: an in-flight compaction pass holds
    // the session object and would re-persist (resurrect) the row on finish.
    if (live.compacting) return false;

    // The archival move serializes the full transcript — lazy sessions hold
    // an empty in-memory array until first use, so hydrate before moving.
    ensureSessionHydrated(sessionId);

    // Already summarized into history by the archive funnel (and unchanged
    // since)? Drop the session row only — never re-summarize what history
    // already covers. A still-pending/running snapshot row also counts: its
    // payload is fresh and the worker will digest it on its own.
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
      return true;
    }

    // Device snapshot (schema v23): which install deleted this session —
    // sync settings read, reuses the persisted relay deviceId.
    let appVersion = "";
    try {
      appVersion = hostAdapter().appVersion();
    } catch {
      // Not running under Electron — record as unknown.
    }
    const device = readSessionDeviceSnapshot(appDataRoot, appVersion);

    try {
      // One transaction: relocate the transcript + metadata/date/workspace
      // snapshot into session_history (queued for the archive worker to
      // summarize) and hard-delete the session row (messages cascade). Any
      // stale history row for the session (e.g. summarized, then the
      // unarchived session grew) is superseded inside the same move. All
      // delete funnels — sidebar, archived view single/batch, workspace
      // purge loops — pass through here, so archived sessions ride the same
      // path.
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
      // Wake the summarize queue — the relocated task is due immediately.
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

    broadcast("agent:sessionDeleted", { id: sessionId });
    return true;
  }

  /**
   * Settle any dangling approvals / asks owned by a session that is being
   * removed (shared by both delete paths above).
   */
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

  /**
   * Derived workspace visibility: PROJECTS shows workspaces with no sessions
   * or at least one unarchived agent session; Archived shows workspaces with
   * at least one archived session. Mixed workspaces appear in both.
   */
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

  /** Whether the workspace owns at least one session (archived or not). */
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

  /**
   * Batch archive/unarchive every session under a workspace. No-op when no
   * session would change state; throws on any running unarchived session.
   */
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

    // Sessions flipping to archived here get the same memory snapshot as
    // the single-session path (captured before the batch UPDATE so the
    // transition set is exact; already-archived rows never re-summarize).
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

  /** Archive a single session; throws when the session is running. */
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

    // Archiving mirrors the delete funnel's memory behavior: snapshot the
    // transcript into the summarize queue (no-op when history already
    // covers it). Unarchiving never touches history.
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
    // Import-time bootstrap: generate .larry/tasks.json for the detected
    // project type when (and only when) the file does not exist yet. Best
    // effort — a read-only folder must not fail the import itself.
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

  /** New-workspace template flow (menu → scaffold → progress). */
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
      // Repointed folder = fresh import for task config purposes.
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

  /**
   * Hard-delete a quiescent `coco_internal` background session (no archive /
   * history summarization). Refuses other sources and live turns; shared body
   * of the store's `deleteCocoInternalSession` and workspace deletion.
   */
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
    return true;
  }

  /** Wait (bounded) for cancelled internal sessions to finish their cleanup. */
  async function waitInternalSessionsSettled(
    sessionIds: string[],
    timeoutMs = 5000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const busy = sessionIds.some((sessionId) => {
        const live = sessions.get(sessionId);
        if (!live) return false;
        return !!live.abort || !!live.compacting || live.promptQueue.length > 0 ||
          (turnLifecycles.get(sessionId)?.pendingEffects.length ?? 0) > 0;
      });
      if (!busy) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
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
      // Hidden `coco_internal` background sessions never keep a workspace
      // alive: they are prunable by design and invisible to the user.
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

    // Stop any live background turn first, wait (bounded) for it to settle,
    // then hard-delete the internal transcripts — before the workspace row
    // decision below, so no orphan rows are left behind.
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

    // Mixed workspace: keep the project and active sessions; only purge archived.
    if (hasUnarchivedAgent) {
      for (const sessionId of archivedIds) {
        deleteSession(sessionId);
      }
      broadcast("workspace:changed", { type: "updated", workspace: existing });
      return true;
    }

    // Fully archived (or empty of agent sessions): delete everything.
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

  /** Single-field origin update (CoCo adoption / boot badge repair). */
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

  /**
   * Pin per-session composer prefs (schema v14) onto the session row.
   * Explicit write path — regular upserts never touch these columns.
   * `null` un-pins a field (back to following the settings.json default).
   */
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
    if (effective.handoffEnabled !== undefined) {
      live.session.handoffEnabled = effective.handoffEnabled ?? null;
    }
    if (effective.handoffEnabled !== undefined) {
      live.session.handoffEnabled = effective.handoffEnabled ?? null;
    }
    if (effective.handoffEnabled !== undefined) {
      live.session.handoffEnabled = effective.handoffEnabled ?? null;
    }
    if (effective.handoffEnabled !== undefined) {
      live.session.handoffEnabled = effective.handoffEnabled ?? null;
    }
    if (changed) {
      live.session.updatedAt = Date.now();
      persistSession(db, live.session);
      emitSessionUpdated(live.session);
    }
    return live.session;
  }

  /**
   * FSM graph delete guard: sessions pinning `graphId` as their composer
   * graph are switched to Auto before the graph file is removed. Sessions
   * mid-turn (running / aborting) block the deletion — nothing is changed
   * in that case. Flipped sessions are persisted + broadcast so open
   * conversation views update their composer chip immediately.
   */
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
    // setComposerPrefs is async-signatured but fully synchronous here; the
    // running guard above keeps it from throwing mid-loop.
    for (const target of plan.flip) {
      void setComposerPrefs(target.id, { runMode: "agent" });
    }
    return plan.flip.map((s) => s.id);
  }

  async function startTurn(req: StartTurnRequest): Promise<StartTurnResponse> {
    const coco = getCocoExecution(req.cocoExecutionId);
    const cocoSource = cocoSourceForAccess(coco);
    const existing = req.sessionId ? sessions.get(req.sessionId)?.session : undefined;
    const executionAccess = () => coco ?? supervisor(sessionId);
    let turnFullPermissions = req.fullPermissions;
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
    // Turn start ⇒ the transcript becomes live memory (model context,
    // streaming, persistence all read/mutate it from here on).
    if (live) ensureSessionHydrated(live.session.id);
    // An execution-lane turn on a planner-adopted user session (source unset
    // ⇒ 'app') claims the CoCo origin marker so the sidebar badge reflects
    // who drives the session.
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
        // Pin the New Task draft prefs onto the row (schema v14). Absent
        // fields stay NULL → follow the settings.json global defaults.
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
        // Origin marker (Loops daemon passes "loop"); omitted → DB 'app'.
        // A trusted CoCo execution access identifies the owner even when the
        // caller forgets the explicit marker.
        ...(req.source ? { source: req.source } : cocoSource ? { source: cocoSource } : {}),
      };
      live = {
        session,
        // Freshly created sessions carry their messages in memory.
        hydrated: true,
        abort: null,
        interruptPort: { fire: null },
        promptQueue: [],
        pendingHandoff: null,
        handoffChainDepth: 0,
        pauseRequested: false,
      };
      sessions.set(session.id, live);
      persistSession(db, session);
    }

    // Plan Approve / ask_user resume may continue while status is already running.
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

    // Claim the slot before any asynchronous setup. Cancellation, provider
    // changes and a second start must observe the same owner immediately.
    const current = live;
    const sessionId = current.session.id;
    const abort = new AbortController();
    current.abort = abort;
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
    // Fresh port per turn: the host fills `fire` during construction; the
    // turn `finally` resets it so late enqueues can never fire into a dead
    // turn.
    const interruptPort: { fire: (() => boolean) | null } = { fire: null };
    current.interruptPort = interruptPort;
    // Per-session composer prefs: session row (v14) → settings.json default.
    // New sessions pinned their values onto the row at creation; renderer
    // request values are advisory only and never override the row.
    const projectPath = current.session.workspacePath;
    let client: Awaited<ReturnType<typeof resolveClient>>;
    let prefSettings: ReturnType<typeof withSettingsDefaults>;
    let runMode: ComposerRunMode;
    let reasoningEffort: ReasoningEffort;
    let fsmGraphConfig: FSMGraphConfig | undefined;
    let fsmGraphId: string | undefined;
    try {
      coco?.onSessionClaim?.(sessionId);
      current.pendingPromptRestore = null;
      if (!continuesRunningTurn && req.handoffChain !== true) {
        current.pendingHandoff = null;
        current.handoffChainDepth = 0;
      }
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
      // Handoffs override this turn's graph without changing composer prefs.
      const handoffGraphOverride =
        req.handoffChain === true && typeof req.handoffGraphId === "string"
          ? req.handoffGraphId.trim()
          : "";
      runMode = coco ? (req.runMode === "ask" || req.runMode === "plan" ? req.runMode : "agent") : handoffGraphOverride
        ? "custom"
        : current.session.composerRunMode ?? prefSettings.composerRunMode;
      reasoningEffort = normalizeReasoningEffort(
        current.session.reasoningEffort ?? prefSettings.reasoningEffort,
      );
      if (runMode === "custom") {
        const resolved = await resolveCustomFsmGraphForTurn(
          handoffGraphOverride || current.session.composerFsmGraphId,
        );
        ensureTurnActive();
        fsmGraphConfig = resolved.config;
        fsmGraphId = resolved.id;
      }
      current.session.providerId = client.providerId;
      current.session.model = client.model;
      current.session.updatedAt = Date.now();
      current.activeTurnContext = {
        runMode,
        fullPermissions: req.fullPermissions,
        autoSkillSummarize: req.autoSkillSummarize === true,
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
      // Transcript boundary of this turn — captured before anything (user
      // message, placeholders) lands; the finally's STOP rollback truncates
      // from here, so it must live outside the try scope.
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
        // The dial is never "unset": leaving the field out would fall back
        // to the provider default, which e.g. Kimi K3 treats as max.
        const turnClient = { ...client, reasoningEffort: turnReasoningEffort };

        // Image attachments → model wire. Three paths, per provider imageInput:
        // - "file" (Moonshot files API only): upload to {baseUrl}/files
        //   (purpose="image"), reference as `ms://<file-id>`.
        // - "base64": inline a downscaled (≤800×600) data URI.
        // - "url" (default, non-Moonshot only): upload to S3/COS, send the
        //   https URL. Moonshot/Kimi cannot fetch external image URLs — the
        //   option is hidden in Setting and the runtime predicate never
        //   accepts it, so images degrade to the read_image stub path.
        // Failures degrade per-file to the stub path — sending is never blocked.
        let turnAttachments = attachments;
        let imageUrls = false;
        // Image uploads over the network (object storage / provider files
        // API) can take seconds — surface a dedicated sticky status instead
        // of leaving the renderer on its optimistic "Waiting for model…"
        // line for the whole upload. runAgentTurn's first model round
        // overwrites the text right after.
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
              // Raw endpoints point at chat/completions — no derivable files
              // URL. Degrade all images to the read_image stub path.
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
          // No applicable path (e.g. Moonshot + stale/unset imageInput):
          // keep the plain attachments — read_image stubs on the wire.
        }

        // read_image direct (tool-role images): probe-verified providers put
        // the pixels inside the tool result instead of relaying a vision
        // description. The wire flag enables rendering of tool-result image
        // attachments (also replays prior ones after a provider switch back);
        // the upload closure resolves transport per provider — bigmodel is
        // forced to S3 URLs (data-URI tool parts get stringified there).
        // Missing object storage / upload failures degrade to the relay path.
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

        // loops tool port: registered by main boot (setLoopsToolPort) once
        // the LoopsService exists; null on this host = tool reports
        // unavailability instead of failing the turn.
        const loopsToolPort = getLoopsToolPort();
        // notify tool port: registered by main boot (setNotifyToolPort);
        // null on daemon hosts = tool reports unavailability (same
        // semantics as the loops port above).
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
        ensureTurnActive();
        await runStoreTurn({
          session: current.session,
          userText: text,
          attachments: turnAttachments,
          ...(imageUrls ? { imageUrls: true } : {}),
          ...(toolRoleImageSupport.enabled ? { toolRoleImages: true } : {}),
          ...(uploadReadImage ? { uploadReadImage } : {}),
          ...(req.suppressUserMessage ? { suppressUserMessage: true } : {}),
          ...(req.continuation ? { continuation: req.continuation } : {}),
          ...(req.resumeAfterUserAsk ? { resumeAfterUserAsk: true } : {}),
          ...(req.resumeToolBatch ? { resumeToolBatch: req.resumeToolBatch } : {}),
          // Explicit interruption remains available to the host. Queueing or
          // arming a prompt waits for a natural boundary and never fires it.
          interruptPort,
          // The FSM round gate only ever sees *armed* queue items: a plain
          // queued prompt (mode "deferred") must not interrupt this turn.
          hasPendingSteer: () => hasArmedInterrupt(current.promptQueue),
          // Merge drain: ALL armed interrupt items land as ONE user message
          // at the first boundary; a single snapshot broadcast clears every
          // renderer row.
          takePendingSteer: () => {
            // Revoked Coco additions must never become ordinary user prompts.
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
            streamChat: coco.stream, summarize: coco.summarize, additionalTools: coco.additionalTools ?? [],
            ...(coco.role === "background" ? { agentSystemPrompt: coco.extraSystemPrompt ?? "" }
              : coco.role === "commander" ? { extraSystemPrompt: coco.extraSystemPrompt ?? "", ...(coco.persona ? { resolvePersona: coco.persona } : {}), ...(coco.wireTrailingNote ? { wireTrailingNote: coco.wireTrailingNote } : {}), ...(coco.conversationTurnLimit ? { conversationTurnLimit: coco.conversationTurnLimit } : {}) }
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
            // Live getters: a sidebar hand-over mid-turn applies to the rest of that turn.
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
              return requestToolConfirmation(sessionId, input);
            },
            requestUserAsk: (input) => {
              const access = executionAccess();
              if (access && access.role !== "commander") return access.ask?.(input) ?? Promise.resolve(null);
              return requestUserAsk(sessionId, input, abort.signal);
            },
            headless: req.headless === true,
          },
          autoSkillSummarize: req.autoSkillSummarize === true,
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
              // search_session_history scans transcripts — hydrate on call
              // (rare tool; boot stays lazy).
              .filter(live => !["coco_chat","coco_internal"].includes(live.session.source??"") && (!executionAccess() || executionAccess()?.allowWorkspace?.(live.session.workspaceId) !== false))
              .map((live) => ensureSessionHydrated(live.session.id)!.session)
              .filter((s) => s.type === "agent"),
          listSessionHistory: () => loadSummarizedHistory(db).filter(record => !executionAccess() || executionAccess()?.allowWorkspace?.(record.workspaceId) !== false),
          fsmGraphLibrary: {
            listFsmGraphs: () => listFsmGraphs(),
            getFsmGraph: (id: string) => getFsmGraph(id),
            createNewGraphRecord: (
              name: string,
              opts?: { origin?: "user" | "llm" },
            ) => createNewGraphRecord(name, opts),
            createForkFromBuiltin: (
              mode: import("../tools/fsmGraphTool.js").FsmGraphForkMode,
              name?: string,
            ) => createForkFromBuiltin(mode, name),
            saveFsmGraph: (record: Record<string, unknown>) =>
              saveFsmGraph(record as Parameters<typeof saveFsmGraph>[0]),
            deleteFsmGraph: (id: string) => deleteFsmGraph(id),
            listActionCatalogSlim: () => listActionCatalogSlim(),
            listEdgeCatalogSlim: () => listEdgeCatalogSlim(),
            describeAction: (type: string) => describeAction(type),
            describeEdge: (type: string) => describeEdge(type),
            validateStoredGraph: async (id: string) => {
              const record = await getFsmGraph(id);
              if (!record) {
                throw Object.assign(new Error(`FSM graph not found: ${id}`), {
                  code: "NOT_FOUND",
                });
              }
              validateGraphConfig(record.config);
            },
            applyGraphEdit: (input) => applyGraphEdit(input),
            detachFsmGraphFromSessions: (graphId: string) =>
              detachFsmGraphFromSessions(graphId),
          },
          // turn_handoff tool port: session gate + in-memory queue. The
          // drain lives in this turn's finally (see drainQueuedHandoff).
          turnHandoff: {
            isHandoffEnabled: (sid: string) =>
              sessions.get(sid)?.session.handoffEnabled === true,
            getFsmGraph: (id: string) => getFsmGraph(id),
            queueHandoff: (sid: string, handoff: TurnHandoffRequest) => {
              const target = sessions.get(sid);
              if (!target) {
                throw new Error(`Unknown session: ${sid}`);
              }
              const replaced = target.pendingHandoff !== null;
              target.pendingHandoff = handoff;
              target.session.progressText =
                handoff.note ??
                `Turn handoff queued — next turn runs graph ${handoff.graphId}`;
              target.session.updatedAt = Date.now();
              emitSessionUpdated(target.session);
              agentLogInfo("turn.handoff_queued", {
                sessionId: sid,
                graphId: handoff.graphId,
                replaced,
              });
              return { replaced };
            },
            cancelHandoff: (sid: string) => {
              const target = sessions.get(sid);
              const cancelled = target?.pendingHandoff != null;
              if (target) {
                target.pendingHandoff = null;
              }
              if (cancelled) {
                agentLogInfo("turn.handoff_cancelled", { sessionId: sid });
              }
              return { cancelled };
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
              // DevTools FSM Graph tab: remember the last visited node + the
              // graph actually executing this turn (schema v16/v17 persistence
              // rides the regular persistSession cadence).
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
            // Avoid flooding the renderer with full session summaries on
            // high-frequency deltas (text / tool args / usage / progress).
            if (shouldEmitSessionUpdated(event)) {
              emitSessionUpdated(current.session);
            }
          },
          // Long-running Auto / Plan turns fire the task-done toast
          // (in-app / corner popup per focus state) gated by
          // NodeActionNotifyTaskDone; the session id rides along for
          // click-to-jump.
          desktopNotify: (input) =>
            hostAdapter().notifyTaskDone({ ...input, sessionId: current.session.id }),
          // FSM NodeActionSetComposerRunMode sink: record the request now;
          // the turn `finally` applies it after the terminal-state guards
          // (prompt queue / queued plan approval / same-mode idempotence).
          requestComposerRunMode: (mode) => {
            current.pendingRunModeRequest = mode;
            agentLogInfo("turn.run_mode_requested", {
              sessionId,
              mode,
            });
          },
          // FSM NodeActionRunShell (custom graphs): user-authored graph config
          // is trusted — ungated shell execution in the session workspace.
          runShell: (input) => {
            if (coco) throw new Error("Custom FSM shell execution is unavailable to Coco");
            return runFsmShellScript(input, current.session.workspacePath);
          },
          // FSM session blackboard (schema v19; Write/Read Blackboard +
          // Compare): session-scoped key/value store persisted in the
          // sessions table. Writes mutate the live session first, then land
          // synchronously via the dedicated repository path (not waiting for
          // the next persistSession cadence).
          blackboardGet: (key) => current.session.fsmBlackboard?.[key],
          blackboardSet: (key, value) => {
            const next: Record<string, unknown> = {
              ...(current.session.fsmBlackboard ?? {}),
            };
            // null / undefined clears the key (used to clear workflow phase).
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
            // First successful turn only: replace the heuristic sidebar title
            // using this turn's transcript (reasoning disabled on the call).
            scheduleSessionTitle({
              sessionId,
              turnMessages,
              // Title generation reuses the session's own chat client
              // (reasoning disabled, non-streaming inside generateTitle).
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
        if (!ownsTurn()) return;
        if (powerGuardAcquired) hostAdapter().powerGuard.release(sessionId);
        // STOP before any visible model content: the turn's prompt (and
        // its content-free assistant placeholders — thinking-only stops
        // included, reasoning is not visible output) never became
        // conversation — drop it from the transcript and hand it back to
        // the composer for a second edit. Runs after the closing `done`
        // event; the follow-up `prompt_restored` event makes renderers
        // refresh + restore.
        const restored = rollbackCancelledTurnPrompt({
          session: current.session,
          turnStartIndex,
          aborted: abort.signal.aborted,
          // Continuation turns carry a hidden synthetic prompt — it must
          // never land in the composer.
          fallback: req.continuation
            ? null
            : { text, attachments },
        });
        if (restored) {
          // Shape B arrives via the catch path (abort during pre-model
          // work): normalize the error status the catch left behind.
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
        // Queued prompts survive the turn (they are user intent, not turn
        // state). Items armed for this turn's round boundaries missed their
        // window, so they fall back to "after the turn".
        const demoted = demoteArmedOnTurnEnd(current.promptQueue);
        if (demoted.changed) {
          current.promptQueue = demoted.items;
          emitPromptQueue(current);
        }
        turnLifecycles.finish(current.session,lifecycleTurnId,unfinishedTurnEffects(current.session,turnStartIndex),current.session.status==="error"?current.session.progressText:undefined);
        current.pauseRequested = false;
        current.abort = null;
        // Detach the interrupt port: the host is gone, so a late enqueue
        // must not fire into a dead turn.
        current.interruptPort = { fire: null };
        // Snapshot before activeTurnContext clears: the handoff follow-up
        // turn inherits this turn's full-permissions state, and a queued
        // plan approval (user action) takes precedence over the handoff.
        const handoffFullPermissions =
          current.activeTurnContext?.fullPermissions === true;
        const planApprovalQueued = current.planApproveQueued === true;
        const turnContext = current.activeTurnContext;
        current.activeTurnContext = null;
        persistSession(db, current.session);
        emitSessionUpdated(current.session);
        // Deferred composer run-mode switch (NodeActionSetComposerRunMode):
        // apply only on a quiescent session — queued prompts or a queued
        // plan approval are user intent composed for the current mode and
        // win the slot. A same-mode request is an idempotent no-op.
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
        // Broadcast only after the rolled-back transcript is persisted and
        // summarized — renderers refresh on this event and must not race a
        // stale tail fetch.
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
        // Queued user prompts outrank a queued handoff (same rule as a
        // queued plan approval): drain the queue first and let the handoff
        // decision see that it lost the slot.
        const promptQueueDrained = drainPromptQueue(
          current,
          planApprovalQueued,
          turnContext ?? null,
        );
        drainQueuedHandoff(
          sessionId,
          current,
          handoffFullPermissions,
          planApprovalQueued,
          promptQueueDrained,
        );
      }
    })();

    return { sessionId };
  }

  /** Run an Approve that arrived while the review turn was still finishing. */
  function drainQueuedPlanApproval(
    sessionId: string,
    current: LiveSession,
  ): void {
    if (!current.planApproveQueued) return;
    current.planApproveQueued = false;
    startApprovedPlan(sessionId, current);
  }

  /**
   * Prompt-queue drain — runs in the turn `finally`, after
   * drainQueuedPlanApproval and before drainQueuedHandoff.
   *
   * Only a cleanly completed, fully quiescent session drains (see
   * `promptQueueDrainDecision`). Every other outcome (Stop / error / paused /
   * waiting on a card) deliberately *keeps* the queue: the rows stay on screen
   * so the user decides, instead of an unexpected turn firing after they hit
   * Stop. Returns true when a follow-up turn was started (the handoff drain
   * treats that as "user input won this slot").
   */
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

  /**
   * Start a turn from one dequeued prompt. Composer-scoped settings are
   * inherited from the turn that just finished (`turnContext`) so a queued
   * follow-up keeps the same permissions posture; a manual "send now" on an
   * idle session has no such context and falls back to the safe defaults.
   */
  function startQueuedPromptTurn(
    current: LiveSession,
    prompt: QueuedPrompt,
    via: "drain" | "manual",
    turnContext?: LiveSession["activeTurnContext"],
  ): boolean {
    const sessionId = current.session.id;
    if (current.session.source === "coco_chat") {
      // Starting an ordinary app turn here would drop CoCo's tools, metering,
      // policy and job ownership. The service queues a fresh commander job.
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
        // Put the prompt back at the front so the user can retry or edit it
        // instead of losing what they typed.
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

  /**
   * turn_handoff drain — runs in the turn finally, after
   * drainQueuedPlanApproval. Fail-stop: only a cleanly completed turn
   * (status "idle") may hand off; every other terminal state drops the
   * queue with a system message so the user sees what happened. Gate,
   * chain cap, and graph validity are all re-checked here because
   * queue-time validation can go stale mid-turn.
   */
  function drainQueuedHandoff(
    sessionId: string,
    current: LiveSession,
    fullPermissions: boolean,
    planApprovalTookPrecedence: boolean,
    promptQueueTookPrecedence: boolean,
  ): void {
    const handoff = current.pendingHandoff;
    if (!handoff) return;
    current.pendingHandoff = null;

    const drop = (reason: string): void => {
      current.session.messages.push({
        id: randomUUID(),
        role: "system",
        createdAt: Date.now(),
        // Policy drop (queue precedence, chain cap, …) — informational
        // note, not a failure: no error card.
        parts: [{ type: "text", text: reason }],
      });
      current.session.updatedAt = Date.now();
      persistSession(db, current.session);
      emitSessionUpdated(current.session);
      agentLogInfo("turn.handoff_dropped", { sessionId, reason });
    };

    const dropReason = handoffDrainDropReason({
      planApprovalTookPrecedence,
      promptQueueTookPrecedence,
      status: current.session.status,
      handoffEnabled: current.session.handoffEnabled,
      chainDepth: current.handoffChainDepth,
    });
    if (dropReason) {
      drop(dropReason);
      return;
    }

    void (async () => {
      try {
        // Graph re-check at drain time: it may have been disabled or
        // deleted while the turn was running.
        const graph = await getFsmGraph(handoff.graphId);
        if (!graph) {
          drop(`Turn handoff dropped: FSM graph not found: ${handoff.graphId}.`);
          return;
        }
        if (!graph.enabled) {
          drop(
            `Turn handoff dropped: FSM graph "${graph.name}" (${handoff.graphId}) was disabled before this turn ended.`,
          );
          return;
        }
        // Race re-check after the await: real user input may have started a
        // new turn while the graph lookup was in flight — user always wins.
        if (current.abort || current.session.status === "running") {
          drop(
            "Turn handoff dropped: new user input arrived while the handoff was starting.",
          );
          return;
        }
        current.handoffChainDepth += 1;
        // Pre-persist the handoff prompt as the next turn's user message
        // with the marker part id, then startTurn with suppressUserMessage
        // (plan control turn pattern) so the transcript holds one copy.
        current.session.messages.push({
          id: randomUUID(),
          role: "user",
          createdAt: Date.now(),
          parts: [
            { type: "text", id: HANDOFF_PROMPT_PART_ID, text: handoff.prompt },
          ],
        });
        current.session.updatedAt = Date.now();
        persistSession(db, current.session);
        emitSessionUpdated(current.session);
        agentLogInfo("turn.handoff_started", {
          sessionId,
          graphId: handoff.graphId,
          chainDepth: current.handoffChainDepth,
        });
        await startTurn({
          sessionId,
          userText: handoff.prompt,
          suppressUserMessage: true,
          handoffChain: true,
          handoffGraphId: handoff.graphId,
          fullPermissions,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        agentLogError("turn.handoff_start_failed", { sessionId, message });
        const target = sessions.get(sessionId);
        if (target) {
          target.session.messages.push({
            id: randomUUID(),
            role: "system",
            createdAt: Date.now(),
            parts: [
              {
                type: "text",
                text: `Turn handoff failed to start: ${message}`,
                error: true,
              },
            ],
          });
          target.session.updatedAt = Date.now();
          persistSession(db, target.session);
          emitSessionUpdated(target.session);
        }
      }
    })();
  }

  function discardPlan(sessionId: string): { ok: true } | { ok: false; error: string } {
    const current = sessions.get(sessionId);
    if (!current) {
      return { ok: false, error: "Session not found." };
    }
    // Gates + clear live in NodeActionApplyControlIntent when mounted on the graph.
    // Runtime only cancels an in-flight turn and passes controlIntent through.

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
    // Review / planDoc gates live in NodeActionApplyControlIntent.
    // Runtime only queues or starts a turn with controlIntent.
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

  /**
   * Pass-through controlIntent only. Composer runMode follows the session
   * row (v14) with settings.json as fallback for un-pinned rows.
   */
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

  /**
   * before-quit snapshot: running turns keep their whole transcript in
   * memory until the turn ends (persistSession normally runs in the turn
   * `finally`). Flush every running session so quitting mid-turn loses
   * nothing — boot convergence then normalizes the persisted running rows.
   * Synchronous better-sqlite3 write; JS single-threading makes the snapshot
   * atomic against the still-running turn's async mutations.
   */
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
      // The full writer commits replacement messages atomically. On failure the
      // live session and original detailed messages remain authoritative.
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
