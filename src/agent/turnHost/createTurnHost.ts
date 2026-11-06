import type { StreamChatOptions } from "../../llm/types.js";
import type { StreamEvent } from "../../llm/streamEvents.js";
import { reasoningScopeForClient } from "../../llm/contextScope.js";
import { dispatchLlmApi } from "../../llm/apiDispatch.js";
import { canReplayResponsesInput, sealResponsesContext } from "../../llm/adapters/responses/context.js";
import { ResponseResourceError, retrieveResponse } from "../../llm/adapters/responses/http.js";
import { classifyResponsesRequestSafety } from "../../llm/adapters/responses/requestSafety.js";
import { responsesInputFromMessages } from "../../llm/adapters/responses/wire.js";
import {
  applyResponsesOutput,
  canApproveHostedMcp,
  denyApprovals,
  denyUnansweredApprovals,
  hasUnsupportedResponsesCall,
  sealHostedToolProgress,
  upsertHostedTool,
} from "../../llm/adapters/responses/transcript.js";
import { existsSync, unlinkSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { recordUserPrompt } from "../../llm/llmTimeline/recorder.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
  truncateForLog,
} from "../../logging/agentLog.js";
import type {
  AssistantMessage,
  Message,
  MessagePart,
  ModelResponsePart,
  HostedToolPart,
  JsonObject,
  SessionStatus,
  TextPart,
  ToolCallPart,
  UserMessage,
} from "../../session/types.js";
import {
  DEFAULT_COMPACT_TRIGGER_RATIO,
  DEFAULT_CONTEXT_LIMIT_TOKENS,
  DEFAULT_HARD_TRUNCATE_RATIO,
  DEFAULT_MAX_MODEL_ITERATIONS,
  DEFAULT_MAX_TURN_TOKENS,
  DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT,
  DEFAULT_ITERATION_PROTECT_TOKEN_RATIO,
} from "../../settings/types.js";
import { createOfferToolPredicate } from "../../tools/offerSet.js";
import { toolPreparingProgressText } from "../../tools/displayMeta.js";
import { adoptPlanDocHandler } from "../../tools/builtin/adoptPlanDoc.js";
import { loadUserMemory } from "../../memory/store.js";
import { loadProjectMemory } from "../../projectMemory/store.js";
import { getCompactionStrategy } from "../contextCompaction/registry.js";
import { hardTruncateKeepingSystemPrefix } from "../contextCompaction/hardTruncateContext.js";
import { recentConversationTurns } from "../contextCompaction/conversationTurns.js";
import {
  estimateTokensForRequest,
  estimateTokensForUserParts,
  estimateTokensFromText,
  resolveDecisionTokens,
} from "../estimateTokens.js";
import { runTools } from "../runTools.js";
import {
  FILE_WRITE_TOOL_NAMES,
  extractPartialPath,
  fileLockToken,
  rekeyStreamingReservation,
  releaseStreamingReservation,
  reserveStreamingWrite,
  sweepTurnFileLocks,
} from "../../tools/fileLock.js";
import {
  sealOrphanToolCallsInSession,
  sealToolCallsWithCancelledResults,
} from "../sealOrphanToolCalls.js";
import {
  findAssistantMessage,
  toolCallsByIds,
} from "../../session/pendingUserAsk.js";
import {
  bridgeScopeForSubagent,
  createSubagentManager,
  injectSubagentBatchResults,
  type SubagentManager,
} from "../subagents/index.js";
import { toolsToOpenAi } from "../toolsToOpenAi.js";
import { markPartsAsRetryContinuation, markPartsAsSteerContinuation } from "../turnContinuations.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";
import type { SessionPatch } from "../contracts/index.js";
import {
  getSessionPhase,
  SESSION_PHASE_BLACKBOARD_KEY,
  setSessionPhaseInMemory,
} from "../../session/sessionPhase.js";
import { planStepStatusesKey } from "../../session/plan.js";
import { buildSystemPrefix } from "./buildSystemPrefix.js";
import {
  assembleModelFacingMessages,
  ensureWireUserMessage,
  joinOverlayParts,
  phaseOverlayMessages,
} from "./phaseOverlayWire.js";
import {
  applyUsageToSession,
  emitContextDisplay,
} from "./contextDisplay.js";
import { emit } from "./emit.js";
import { finishTurn } from "./finishTurn.js";
import { buildUserParts, combineToolPredicates } from "./helpers.js";
import { handleTurnLimit, type TurnLimitKind } from "./turnBudget.js";
import { touch } from "./touch.js";
import type {
  AwaitSubagentResult,
  CreateTurnHostConfig,
  ModelRoundResult,
  PrepareModelWindowInput,
  PrepareModelWindowResult,
  PrepareToolsInput,
  PrepareToolsResult,
  ToolsPhaseResult,
  TurnHost,
  TurnHostCounters,
  TurnRunResult,
  TurnStartOptions,
} from "./types.js";

/** A pending request older than this is settled as unknown instead of blocking new turns. */
export const RESPONSES_RECOVERY_GIVE_UP_MS = 15 * 60_000;
const INTERRUPTED_RESPONSE_NOTE =
  "[This response was interrupted before it finished. Any hosted tool actions it started " +
  "(MCP, code interpreter, image generation) have an unknown outcome and were not retried automatically.]";

function abortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => { reject(signal.reason ?? new Error("Request cancelled")); };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", onAbort); reject(error); },
    );
  });
}

function ensureTextPart(parts: MessagePart[]): TextPart {
  const existing = parts.find((p): p is TextPart => p.type === "text");
  if (existing) return existing;
  const part: TextPart = { type: "text", text: "" };
  parts.push(part);
  return part;
}

export type CreateTurnHostInput = CreateTurnHostConfig & {
  /** Child turns recurse through the facade with the full turn input. */
  runChildTurn: (input: RunAgentTurnInput) => Promise<RunAgentTurnResult>;
};

export function createTurnHost(opts: CreateTurnHostInput): TurnHost {
  const { runChildTurn, ...input } = opts;
  const {
    session,
    client,
    gate,
    createId,
    signal,
    interruptPort,
    onEvent,
    desktopNotify,
    requestComposerRunMode,
    runShell,
    blackboardGet,
    blackboardSet,
    hooks,
  } = input;

  const unlimitedTurnBudgets = input.unlimitedTurnBudgets === true;
  const maxModelIterations = unlimitedTurnBudgets
    ? Number.POSITIVE_INFINITY
    : (input.maxModelIterations ?? DEFAULT_MAX_MODEL_ITERATIONS);
  const maxTurnTokens = unlimitedTurnBudgets
    ? Number.POSITIVE_INFINITY
    : (input.maxTurnTokens ?? DEFAULT_MAX_TURN_TOKENS);
  const isSubagentTurn = input.isSubagentTurn === true;
  const contextLimitTokens =
    input.contextLimitTokens ?? DEFAULT_CONTEXT_LIMIT_TOKENS;
  const compactTriggerRatio =
    input.compactTriggerRatio ?? DEFAULT_COMPACT_TRIGGER_RATIO;
  const iterationProtectRawIterationCount =
    input.iterationProtectRawIterationCount ??
    DEFAULT_ITERATION_PROTECT_RAW_ITERATION_COUNT;
  const iterationProtectTokenRatio =
    input.iterationProtectTokenRatio ?? DEFAULT_ITERATION_PROTECT_TOKEN_RATIO;
  const strategy = getCompactionStrategy();
  const buildConfig = {
    contextLimitTokens,
    iterationProtectRawIterationCount,
    iterationProtectTokenRatio,
    ...(input.imageUrls === true ? { imageUrls: true } : {}),
    ...(input.toolRoleImages === true ? { toolRoleImages: true } : {}),
  };
  const turnStartedAt = Date.now();

  let subagentManager: SubagentManager | undefined;
  if (!isSubagentTurn) {
    subagentManager = createSubagentManager({
      parentSession: session,
      ...(signal ? { parentSignal: signal } : {}),
      client,
      gate,
      createId,
      maxModelIterations,
      maxTurnTokens,
      ...(unlimitedTurnBudgets ? { unlimitedTurnBudgets: true } : {}),
      contextLimitTokens,
      compactTriggerRatio,
      iterationProtectRawIterationCount,
      iterationProtectTokenRatio,
      ...(input.environmentContext
        ? { environmentContext: input.environmentContext }
        : {}),
      ...(input.getVisionClient
        ? { getVisionClient: input.getVisionClient }
        : {}),
      ...(input.getImageGenClient
        ? { getImageGenClient: input.getImageGenClient }
        : {}),
      ...(input.uploadImageGenInput
        ? { uploadImageGenInput: input.uploadImageGenInput }
        : {}),
      ...(input.uploadReadImage
        ? { uploadReadImage: input.uploadReadImage }
        : {}),
      ...(hooks ? { hooks } : {}),
      ...(input.streamChat ? { streamChat: input.streamChat } : {}),
      ...(input.summarize ? { summarize: input.summarize } : {}),
      ...(onEvent ? { onParentEvent: onEvent } : {}),
      ...(input.sessionDb ? { db: input.sessionDb } : {}),
      ...(input.llmBundle ? { llmBundle: input.llmBundle } : {}),
      ...(input.listAgentSessions
        ? { listAgentSessions: input.listAgentSessions }
        : {}),
      ...(input.listSessionHistory
        ? { listSessionHistory: input.listSessionHistory }
        : {}),
      ...(input.listWorkspaces
        ? { listWorkspaces: input.listWorkspaces }
        : {}),
      ...(input.fsmGraphLibrary
        ? { fsmGraphLibrary: input.fsmGraphLibrary }
        : {}),
      ...(input.turnHandoff ? { turnHandoff: input.turnHandoff } : {}),
      ...(input.loops ? { loops: input.loops } : {}),
      ...(input.notify ? { notify: input.notify } : {}),
      runTurn: (childInput) => runChildTurn(childInput),
    });
  }

  let modelIterations = 0;
  let turnBillableTokens = 0;
  let toolFailureCount = 0;
  let turnHookContext = "";
  let pendingUserPromptTokens = 0;
  let pendingStreamTokens = 0;
  let streamTextBuf = "";
  let streamToolBuf = "";
  let streamReasoningBuf = "";
  let lastDisplayEmitAt = 0;
  let displayFlushTimer: ReturnType<typeof setTimeout> | undefined;
  const configuredToolPredicate = input.toolPredicate;
  const baseToolPredicate: (name: string) => boolean = (name) => {
    return configuredToolPredicate ? configuredToolPredicate(name) : true;
  };
  let startLogged = false;

  const clearDisplayFlushTimer = (): void => {
    if (displayFlushTimer === undefined) return;
    clearTimeout(displayFlushTimer);
    displayFlushTimer = undefined;
  };

  const refreshContextDisplay = (force = false): void => {
    pendingStreamTokens =
      Math.ceil(streamTextBuf.length / 4) +
      Math.ceil(streamToolBuf.length / 4) +
      Math.ceil(streamReasoningBuf.length / 4);
    const display = Math.max(
      0,
      Math.round(
        session.contextUsage.usedTokens +
          pendingUserPromptTokens +
          pendingStreamTokens,
      ),
    );
    const now = Date.now();
    if (!force && now - lastDisplayEmitAt < 100) {
      if (session.contextUsage.displayUsedTokens !== display) {
        session.contextUsage = {
          ...session.contextUsage,
          displayUsedTokens: display,
        };
      }
      if (displayFlushTimer === undefined) {
        displayFlushTimer = setTimeout(() => {
          displayFlushTimer = undefined;
          refreshContextDisplay(true);
        }, 100);
      }
      return;
    }
    if (displayFlushTimer !== undefined) {
      clearDisplayFlushTimer();
    }
    lastDisplayEmitAt = now;
    emitContextDisplay(session, onEvent, display, "estimate");
  };

  const resetTurnBudgets = (reason: string): void => {
    if (unlimitedTurnBudgets) return;
    const previousModelIterations = modelIterations;
    const previousTurnBillableTokens = turnBillableTokens;
    modelIterations = 0;
    turnBillableTokens = 0;
    agentLogInfo("turn.budget_reset", {
      sessionId: session.id,
      reason,
      previousModelIterations,
      previousTurnBillableTokens,
    });
  };

  const finish = (
    status: SessionStatus,
    progressText: string,
    doneReason: "completed" | "cancelled" | "paused" | "error",
    iterations = modelIterations,
  ): Promise<TurnRunResult> => {
    clearDisplayFlushTimer();
    return finishTurn({
      session,
      status,
      progressText,
      ...(onEvent ? { onEvent } : {}),
      doneReason,
      modelIterations: iterations,
      turnStartedAt,
      ...(hooks ? { hooks } : {}),
      strategy,
      buildConfig,
    });
  };

  // Used at turn entry and before preparing each new model round. A steer can
  // continue within the same turn, so turn-entry checks alone are insufficient.
  const reconcileResponsesRequests = async (
    additionalClients: import("../../llm/types.js").OpenAiCompatibleClientConfig[] = [],
  ): Promise<TurnRunResult | undefined> => {
    const recoveryClients = [client, ...additionalClients, ...Object.values(input.llmBundle?.byProviderId ?? {}).map((binding) => binding.client)];
    let lastClear = -1;
    for (let i = 0; i < session.messages.length; i += 1) {
      if (session.messages[i]!.parts.some((part) => part.type === "context_clear")) lastClear = i;
    }
    const tail = session.messages.slice(lastClear + 1);
    const nativeParts = (): Array<{ message: (typeof tail)[number]; part: ModelResponsePart }> => tail.flatMap((message) =>
      message.parts.filter((part): part is ModelResponsePart => part.type === "model_response").map((part) => ({ message, part })));

    // Legacy checkpoints put the replay barrier on the failed request and refused
    // every later turn. The barrier now disables native replay for that scope.
    let migrated = false;
    for (const { part } of nativeParts()) {
      if (!part.contextReplayBlocked || part.status === "completed") continue;
      for (const { part: other } of nativeParts()) {
        if (other.providerScope !== part.providerScope || other.status !== "completed") continue;
        other.contextReplayBlocked = true;
        other.stored = false;
      }
      delete part.contextReplayBlocked;
      migrated = true;
    }
    if (migrated) { touch(session); await input.checkpoint?.(); }

    const latestByScope = new Map<string, ModelResponsePart>();
    for (const { part } of nativeParts()) latestByScope.set(part.providerScope, part);

    /**
     * Settle a request whose outcome cannot be learned so the conversation can
     * continue. Nothing is resubmitted: a continuation branches again from the
     * completed response it was built on, with every approval denied.
     */
    const settleLostResponse = async (message: (typeof tail)[number], part: ModelResponsePart, reason: string): Promise<void> => {
      const effects = part.requestSafety === "effects_possible" || part.hostedEffects === true;
      let settled: ModelResponsePart;
      if (part.resumeFrom) {
        const { continuationInput, ...prior } = part.resumeFrom;
        const answers = denyApprovals(continuationInput);
        settled = { type: "model_response", ...prior, ...(answers ? { continuationInput: answers } : {}) };
      } else {
        const { contextHash: _hash, contextLength: _length, continuationInput: _answers, ...rest } = part;
        settled = { ...rest, status: "outcome_unknown", stored: false };
        // A mixed local/MCP continuation carried the previous response's approvals;
        // the next request chains on that response and must not send them again.
        let predecessor: ModelResponsePart | undefined;
        for (const { part: other } of nativeParts()) {
          if (other === part) break;
          if (other.providerScope === part.providerScope && other.status === "completed") predecessor = other;
        }
        const denied = denyApprovals(predecessor?.continuationInput);
        if (predecessor && denied) predecessor.continuationInput = denied;
      }
      message.parts[message.parts.indexOf(part)] = settled;
      const activities = sealHostedToolProgress(message as AssistantMessage);
      if (effects) message.parts.push({ type: "text", text: INTERRUPTED_RESPONSE_NOTE });
      agentLogWarn("responses.outcome_unknown", { sessionId: session.id, responseId: part.responseId || null,
        status: part.status, restored: Boolean(part.resumeFrom), reason });
      touch(session);
      await input.checkpoint?.();
      for (const activity of activities) emit(onEvent, { ...activity, messageId: message.id });
      emit(onEvent, { type: "response_state", responseId: settled.responseId, status: settled.status, stored: settled.stored, messageId: message.id });
    };

    for (const { message, part } of nativeParts()) {
      if (message.role !== "assistant") continue;
      if (part.status === "completed") {
        const before = JSON.stringify(message.parts);
        if (hasUnsupportedResponsesCall(part.output)) {
          // Every continuation would fail waiting for an output we cannot produce.
          part.status = "invalid";
          part.stored = false;
          delete part.contextHash;
          delete part.contextLength;
        } else {
          applyResponsesOutput(message, part.output, true);
          // Stop or a crash during an approval prompt leaves the request unanswered;
          // the next continuation would be rejected until it is answered.
          if (latestByScope.get(part.providerScope) === part) {
            const answers = denyUnansweredApprovals(part.output, part.continuationInput);
            if (answers) part.continuationInput = answers;
          }
        }
        if (JSON.stringify(message.parts) !== before) { touch(session); await input.checkpoint?.(); }
        continue;
      }
      if (part.status === "rejected" && part.resumeFrom) {
        await settleLostResponse(message, part, "continuation_rejected");
        continue;
      }
      if (!["submitting", "queued", "in_progress"].includes(part.status)) continue;
      const hasApproval = part.continuationInput?.some((item) => item.type === "mcp_approval_response" && item.approve === true)
        || part.output.some((item) => item.type === "mcp_approval_response" && item.approve === true);
      const readOnly = !hasApproval && (part.requestSafety === "read_only"
        || (part.requestSafety === undefined && part.hostedEffects === false));
      if (part.resumeFrom && (readOnly || !part.responseId)) {
        await settleLostResponse(message, part, readOnly ? "read_only_continuation" : "missing_response_id");
        continue;
      }
      if (readOnly) {
        // Local abandonment says nothing about remote cancellation. Searches
        // may finish remotely, but cannot justify blocking the conversation.
        part.status = "abandoned_local";
        part.stored = false;
        delete part.contextHash;
        delete part.contextLength;
        const activities = sealHostedToolProgress(message as AssistantMessage);
        touch(session);
        await input.checkpoint?.();
        for (const activity of activities) emit(onEvent, { ...activity, messageId: message.id });
        emit(onEvent, { type: "response_state", responseId: part.responseId, status: part.status, stored: false, messageId: message.id });
        continue;
      }
      if (!part.responseId) {
        // Lost before response.created: there is no ID to query.
        await settleLostResponse(message, part, "missing_response_id");
        continue;
      }
      const expired = Date.now() - message.createdAt >= RESPONSES_RECOVERY_GIVE_UP_MS;
      const sourceClient = recoveryClients.map((candidate) => part.model ? { ...candidate, model: part.model } : candidate)
        .find((candidate) => dispatchLlmApi(candidate).matchesReplayScope(candidate, part.providerScope));
      if (!sourceClient) {
        if (expired) { await settleLostResponse(message, part, "provider_binding_unavailable"); continue; }
        return finish("error", "The previous hosted-tool request belongs to an unavailable provider binding. Restore that provider to recover it, or send again later to continue without it; it was not submitted again.", "error");
      }
      try {
        signal?.throwIfAborted();
        // Some compatible services retain responses despite store:false.
        // A known ID can be queried safely without resubmitting any work.
        const recovered = await retrieveResponse(sourceClient, part.responseId, signal);
        signal?.throwIfAborted();
        if (["queued", "in_progress"].includes(String(recovered.status))) {
          if (expired) { await settleLostResponse(message, part, "still_running"); continue; }
          return finish("error", "The previous Responses request is still running on the provider. Wait for it to finish before continuing; it was not submitted again.", "error");
        }
        if (recovered.id !== part.responseId || !["completed", "failed", "incomplete", "cancelled"].includes(String(recovered.status))
          || !Array.isArray(recovered.output)) throw new ResponseResourceError("Invalid stored response", 200);
        const recoveredOutput = recovered.output.filter(
          (item): item is JsonObject => !!item && typeof item === "object" && !Array.isArray(item),
        );
        if (recovered.status !== "completed" && part.resumeFrom) {
          await settleLostResponse(message, part, `continuation_${String(recovered.status)}`);
          continue;
        }
        part.status = String(recovered.status);
        part.stored = part.stored && recovered.store !== false;
        part.output = [...part.output, ...(part.continuationInput ?? []), ...recoveredOutput];
        delete part.continuationInput;
        delete part.resumeFrom;
        if (part.status === "completed" && hasUnsupportedResponsesCall(part.output)) {
          part.status = "invalid";
          part.stored = false;
        }
        sealResponsesContext(part);
        applyResponsesOutput(message, part.output, true);
        await input.checkpoint?.();
        for (const activity of message.parts) {
          if (activity.type === "hosted_tool") emit(onEvent, { ...activity, messageId: message.id });
        }
        emit(onEvent, { type: "response_state", responseId: part.responseId, status: part.status, stored: part.stored, messageId: message.id });
      } catch (error) {
        if (signal?.aborted) return finish("cancelled", "Cancelled", "cancelled");
        // An answered 4xx or a malformed record will not improve on retry.
        const definite = error instanceof ResponseResourceError && error.status !== undefined && error.status < 500;
        if (definite || expired) {
          await settleLostResponse(message, part, error instanceof Error ? error.message : String(error));
          continue;
        }
        const detail = error instanceof Error ? error.message : String(error);
        return finish("error", `Unable to reach the provider to recover the previous Responses request: ${detail}. Send again to retry; it was not submitted again.`, "error");
      }
    }
    return undefined;
  };

  const applySessionPatchToSession = (patch: SessionPatch): void => {
    const statusesBefore =
      "plan" in patch ? planStepStatusesKey(session.plan) : undefined;
    if ("plan" in patch) {
      session.plan = patch.plan ?? null;
      emit(onEvent, { type: "plan", plan: session.plan });
    }
    if ("planDoc" in patch) {
      session.planDoc = patch.planDoc ?? null;
      emit(onEvent, {
        type: "plan_approval",
        pending: session.planDoc?.approvalPending === true,
      });
    }
    if ("phase" in patch) {
      const phase = patch.phase ?? null;
      if (blackboardSet) {
        const out = blackboardSet(SESSION_PHASE_BLACKBOARD_KEY, phase);
        if (!out.ok) {
          agentLogWarn("session.phase_blackboard_write_failed", {
            sessionId: session.id,
            error: out.error,
          });
          setSessionPhaseInMemory(session, phase);
        } else {
          // Mirror legacy Session.phase for upsert / older readers.
          session.phase = phase;
        }
      } else {
        setSessionPhaseInMemory(session, phase);
      }
      emit(onEvent, {
        type: "phase",
        phase: getSessionPhase(session),
      });
    }
    touch(session);
    if (
      "plan" in patch &&
      statusesBefore !== undefined &&
      planStepStatusesKey(session.plan) !== statusesBefore
    ) {
      resetTurnBudgets("plan_step_status_changed");
    }
  };

  // ---- User-prompt interrupt plumbing ----
  // Separate one-shot controller: firing aborts the in-flight model stream
  // (combined into chatOptions.signal) WITHOUT ending the turn. The round
  // loop seals partial content as kind:"interrupted"; the round gate then
  // drains the queued prompt, and drainPendingSteer recreates the controller
  // so the follow-up round is not instantly re-aborted.
  let interruptController: AbortController | null = new AbortController();
  const requestInterrupt = (): boolean => {
    const controller = interruptController;
    if (!controller || controller.signal.aborted) return false;
    controller.abort();
    return true;
  };
  if (interruptPort) {
    interruptPort.fire = requestInterrupt;
  }

  const host: TurnHost = {
    session,
    gate,
    createId,
    ...(signal ? { signal } : {}),
    requestInterrupt,
    ...(onEvent ? { onEvent } : {}),
    ...(desktopNotify ? { desktopNotify } : {}),
    ...(requestComposerRunMode ? { requestComposerRunMode } : {}),
    ...(runShell ? { runShell } : {}),
    ...(blackboardGet ? { blackboardGet } : {}),
    ...(blackboardSet ? { blackboardSet } : {}),
    isSubagentTurn,

    getCounters(): TurnHostCounters {
      return { modelIterations, turnBillableTokens, toolFailureCount };
    },
    setCounters(next: Partial<TurnHostCounters>): void {
      if (typeof next.modelIterations === "number") {
        modelIterations = next.modelIterations;
      }
      if (typeof next.turnBillableTokens === "number") {
        turnBillableTokens = next.turnBillableTokens;
      }
      if (typeof next.toolFailureCount === "number") {
        toolFailureCount = next.toolFailureCount;
      }
    },
    resetTurnBudgets,
    applySessionPatch: applySessionPatchToSession,
    planDocExists(path: string): boolean {
      try { gate.assertPath?.(path); } catch { return false; }
      const trimmed = path.trim();
      return trimmed.length > 0 && existsSync(trimmed);
    },
    async readPlanDocContent(path: string): Promise<string | null> {
      gate.assertPath?.(path);
      try { return await readFile(path, "utf8"); } catch { return null; }
    },
    async adoptPlanDoc(path: string, executionRequested: boolean) {
      gate.assertPath?.(path);
      const result = await adoptPlanDocHandler({ path }, {
        workspacePath: session.workspacePath ?? "",
        fullPermissionsEnabled: false,
        planExecutionRequested: executionRequested,
        planDocSnapshot: session.planDoc ?? null,
        ...(signal ? { signal } : {}),
      });
      return result.sessionPatch?.planDoc ?? null;
    },
    deletePlanDoc(path: string): void {
      gate.authorizeTool?.("write_file", { path, content: "" });
      gate.assertPath?.(path);
      const trimmed = path.trim();
      if (!trimmed) return;
      try {
        unlinkSync(trimmed);
      } catch {
        // Best-effort
      }
    },

    async startTurn(startInput: TurnStartOptions): Promise<"ok" | TurnRunResult> {
      let effectiveUserText = startInput.userText;

      const recovery = await reconcileResponsesRequests();
      if (recovery) return recovery;

      if (hooks) {
        const submit = await hooks.run("beforeSubmitPrompt", {
          sessionId: session.id,
          workspacePath: session.workspacePath,
          prompt: effectiveUserText,
          attachment_count: startInput.attachments?.length ?? 0,
          ...(startInput.parentSessionId
            ? { parentSessionId: startInput.parentSessionId }
            : {}),
          ...(startInput.subagentId ? { subagentId: startInput.subagentId } : {}),
        });
        if (submit.denied || submit.permission === "deny") {
          emit(onEvent, {
            type: "progress",
            text: submit.agentMessage?.trim() || "Hook blocked prompt",
          });
          return finish(
            "cancelled",
            submit.agentMessage?.trim() ||
              submit.userMessage?.trim() ||
              "Cancelled by hook",
            "cancelled",
            0,
          );
        }
        if (typeof submit.updatedPrompt === "string") {
          effectiveUserText = submit.updatedPrompt;
        }
      }

      const userMessage: UserMessage | null = startInput.suppressUserMessage
        ? null
        : {
            id: createId(),
            role: "user",
            createdAt: Date.now(),
            parts: buildUserParts(
              effectiveUserText,
              startInput.attachments,
              createId,
            ),
          };
      // Retry-click continuation: stamp the marker so every UI hides the
      // message while the model still sees it on the wire.
      if (userMessage && startInput.continuation === "retry") {
        markPartsAsRetryContinuation(userMessage.parts);
      }
      const sealedOrphans = sealOrphanToolCallsInSession(session, createId,
        startInput.resumeToolBatch ? { resumeToolBatch: startInput.resumeToolBatch } : undefined);
      if (sealedOrphans > 0) {
        agentLogWarn("tool.orphan_tool_calls_sealed", {
          sessionId: session.id,
          sealed: sealedOrphans,
        });
      }
      if (userMessage) session.messages.push(userMessage);
      // Dev Panel Timeline: user-prompt marker on the User track (subagent
      // turns land in the child session's own buffer, like their LLM rounds;
      // synthetic suppressUserMessage prompts and hidden retry continuations
      // are not user input).
      if (!startInput.suppressUserMessage && !startInput.continuation) {
        recordUserPrompt({
          sessionId: session.id,
          label: effectiveUserText.trim().slice(0, 80) || "(no text)",
          promptRaw: effectiveUserText,
        });
      }
      session.status = "running";
      touch(session, "Waiting for model…");
      emit(onEvent, { type: "status", status: "running" });

      pendingUserPromptTokens = userMessage
        ? estimateTokensForUserParts(userMessage.parts)
        : 0;
      pendingStreamTokens = 0;
      streamTextBuf = "";
      streamToolBuf = "";
      streamReasoningBuf = "";
      lastDisplayEmitAt = 0;
      refreshContextDisplay(true);

      if (hooks) {
        const start = await hooks.run("turnStart", {
          sessionId: session.id,
          workspacePath: session.workspacePath,
          prompt: effectiveUserText,
          ...(startInput.parentSessionId
            ? { parentSessionId: startInput.parentSessionId }
            : {}),
          ...(startInput.subagentId
            ? { subagentId: startInput.subagentId }
            : {}),
        });
        if (start.additionalContext?.trim()) {
          turnHookContext = start.additionalContext.trim();
        }
      }

      if (!startLogged) {
        startLogged = true;
        agentLogInfo("turn.start", {
          sessionId: session.id,
          model: session.model || client.model,
          providerId: session.providerId,
          fullPermissions: gate.fullPermissionsEnabled,
          attachmentCount: startInput.attachments?.length ?? 0,
          userTextChars: effectiveUserText.trim().length,
          unlimitedTurnBudgets,
          maxModelIterations: Number.isFinite(maxModelIterations)
            ? maxModelIterations
            : null,
          maxTurnTokens: Number.isFinite(maxTurnTokens) ? maxTurnTokens : null,
          contextLimitTokens,
        });
      }

      await loadUserMemory();
      if (session.workspacePath?.trim()) {
        await loadProjectMemory(session.workspacePath);
      }

      const resumeBatch = startInput.resumeToolBatch;
      if (resumeBatch && resumeBatch.toolCallIds.length > 0) {
        const assistant = findAssistantMessage(
          session,
          resumeBatch.assistantMessageId,
        );
        if (!assistant) {
          return finish(
            "error",
            "Missing assistant message for resumed tool batch",
            "error",
          );
        }
        const calls = toolCallsByIds(assistant, resumeBatch.toolCallIds);
        if (calls.length === 0) {
          return finish(
            "error",
            "Missing tool calls for resumed tool batch",
            "error",
          );
        }
        const resumed = await host.runToolsPhase(assistant, calls);
        if (resumed.kind === "cancelled" || resumed.kind === "error") {
          return resumed.result;
        }
      }

      return "ok";
    },

    checkAbort(): boolean {
      return signal?.aborted === true;
    },

    async enforceBudget(): Promise<"resume" | TurnRunResult> {
      // /pause lands here at the round boundary: finish gracefully as
      // `paused` instead of evaluating budgets. Consumed once; if the turn
      // ends before the next boundary the runtime clears the stale flag.
      if (input.takePauseRequested?.() === true) {
        agentLogInfo("turn.pause", {
          sessionId: session.id,
          modelIterations,
          turnBillableTokens,
        });
        return finish("paused", "Paused", "paused");
      }
      const tokensExceeded = turnBillableTokens >= maxTurnTokens;
      const iterationsExceeded = modelIterations >= maxModelIterations;
      if (!tokensExceeded && !iterationsExceeded) {
        return "resume";
      }
      const kind: TurnLimitKind = tokensExceeded ? "tokens" : "iterations";
      return handleTurnLimit({
        kind,
        session,
        gate,
        createId,
        ...(onEvent ? { onEvent } : {}),
        ...(signal ? { signal } : {}),
        isSubagentTurn,
        maxTurnTokens,
        turnBillableTokens,
        maxModelIterations,
        modelIterations,
        resetIterations: () => {
          modelIterations = 0;
        },
        resetTokens: () => {
          turnBillableTokens = 0;
        },
        finish: (status, progressText, doneReason) =>
          finish(status, progressText, doneReason),
      }) as Promise<"resume" | TurnRunResult>;
    },

    async drainPendingSteer(): Promise<boolean> {
      const drained = input.takePendingSteer?.() ?? [];
      // Consume the one-shot at EVERY boundary, even if its last prompt
      // was removed or changed to deferred while a protected write ran.
      // Keep this synchronous with the take: a later enqueue during hooks
      // must fire the new controller and survive into the next boundary.
      if (interruptController?.signal.aborted) {
        interruptController = new AbortController();
      }
      if (drained.length === 0) return false;

      // Merge drain: ALL armed interrupt items land as ONE user message
      // (texts joined with blank lines, attachments unioned) so rapid
      // multi-sends are seen together instead of burning an aborted round
      // each.
      const mergedText = drained
        .map((item) => item.userText.trim())
        .filter(Boolean)
        .join("\n\n");
      const mergedAttachments = drained.flatMap((item) => item.attachments);
      const drainedIds = drained.map((item) => item.id);

      let effectiveUserText = mergedText;
      if (hooks) {
        const submit = await hooks.run("beforeSubmitPrompt", {
          sessionId: session.id,
          workspacePath: session.workspacePath,
          prompt: effectiveUserText,
          attachment_count: mergedAttachments.length,
          steer: true,
        });
        if (submit.denied || submit.permission === "deny") {
          const text =
            submit.agentMessage?.trim() ||
            submit.userMessage?.trim() ||
            "Hook blocked correction";
          touch(session, text);
          emit(onEvent, { type: "progress", text });
          for (const id of drainedIds) {
            emit(onEvent, { type: "steer_consumed", id, applied: false });
          }
          agentLogWarn("turn.steer_blocked", {
            sessionId: session.id,
            steerIds: drainedIds,
          });
          return true;
        }
        if (typeof submit.updatedPrompt === "string") {
          effectiveUserText = submit.updatedPrompt;
        }
      }

      const userMessage: UserMessage = {
        id: createId(),
        role: "user",
        createdAt: Date.now(),
        parts: buildUserParts(
          effectiveUserText,
          mergedAttachments,
          createId,
        ),
      };
      markPartsAsSteerContinuation(userMessage.parts);
      session.messages.push(userMessage);
      // Dev Panel Timeline: steer prompt marker on the User track (mid-turn,
      // must not clear the running turn's records).
      recordUserPrompt({
        sessionId: session.id,
        label: `steer · ${effectiveUserText.trim().slice(0, 80) || "(no text)"}`,
        promptRaw: effectiveUserText,
        clearPrevious: false,
      });
      pendingUserPromptTokens += estimateTokensForUserParts(userMessage.parts);
      touch(session, "Applying your correction…");
      // One event per drained id: the renderer clears its queue rows from
      // the prompt_queue snapshot; this only marks them consumed.
      for (const id of drainedIds) {
        emit(onEvent, { type: "steer_consumed", id, applied: true });
      }
      emit(onEvent, {
        type: "progress",
        text: "Applying your correction…",
      });
      refreshContextDisplay(true);
      agentLogInfo("turn.steer_applied", {
        sessionId: session.id,
        steerIds: drainedIds,
        mergedCount: drainedIds.length,
        attachmentCount: mergedAttachments.length,
      });
      return true;
    },

    hasPendingSteer(): boolean {
      return input.hasPendingSteer?.() === true;
    },

    prepareTools(prep: PrepareToolsInput = {}): PrepareToolsResult {
      const useOfferSet =
        typeof prep.useOfferSet === "boolean"
          ? prep.useOfferSet
          : !isSubagentTurn;
      const iterationToolPredicate = combineToolPredicates(
        baseToolPredicate,
        prep.toolPredicate,
        useOfferSet ? createOfferToolPredicate() : undefined,
      );
      const localPredicate = combineToolPredicates(baseToolPredicate, prep.toolPredicate);
      const local = (input.additionalTools ?? []).filter(t => localPredicate?.(t.definition.name) !== false).map(t => ({ type: "function" as const, function: { name: t.definition.name, description: t.definition.description, parameters: t.definition.parameters, strict: false } }));
      return { tools: [...toolsToOpenAi(iterationToolPredicate), ...local] };
    },

    async prepareModelWindow(
      prep: PrepareModelWindowInput,
    ): Promise<PrepareModelWindowResult> {
      const recovery = await reconcileResponsesRequests();
      if (recovery) return { ok: false, result: recovery };
      const windowBuildConfig = {
        ...buildConfig,
        reasoningScope: prep.reasoningScope ?? reasoningScopeForClient(client),
      };
      const turnLimit = input.conversationTurnLimit;
      const windowSource = (): Message[] =>
        turnLimit ? recentConversationTurns(session.messages, turnLimit) : session.messages;
      let skipCompact = prep.skipCompact === true || turnLimit !== undefined;
      if (hooks) {
        const preCompact = await hooks.run("preCompact", {
          sessionId: session.id,
          workspacePath: session.workspacePath,
          context_limit_tokens: contextLimitTokens,
          used_tokens: session.contextUsage.usedTokens,
        });
        if (preCompact.denied || preCompact.permission === "deny") {
          skipCompact = true;
        }
      }

      if (prep.progressLabel) {
        touch(session, prep.progressLabel);
        emit(onEvent, { type: "progress", text: prep.progressLabel });
      }

      const iterationTools = prep.tools;
      const estimateTools = [...iterationTools, ...(prep.hostedTools ?? [])];

      // Bucket0 + trailing overlay do not depend on the compaction marker;
      // build them before compact so the host can pass one full-window estimate
      // into both the compact trigger and (later) hard-truncate.
      const phaseOverlay = joinOverlayParts(prep.trailingOverlay, input.wireTrailingNote);
      const systemPrefix = buildSystemPrefix({
        session,
        personaSlot: isSubagentTurn ? "subagent" : "agent",
        ...(prep.personaLabel ? { personaLabel: prep.personaLabel } : {}),
        ...(prep.agentTemplateOverride
          ? { roleTemplate: prep.agentTemplateOverride }
          : {}),
        ...(prep.roleSystemPrompt
          ? { roleSystemPrompt: prep.roleSystemPrompt }
          : {}),
        ...(input.environmentContext
          ? { environmentContext: input.environmentContext }
          : {}),
        ...(turnHookContext ? { turnHookContext } : {}),
        ...(input.extraSystemPrompt
          ? { extraSystemPrompt: input.extraSystemPrompt }
          : {}),
        ...(input.resolvePersona && !isSubagentTurn
          ? { persona: input.resolvePersona() }
          : {}),
      });
      const preCompactConversation = strategy.buildModelMessages(
        windowSource(),
        windowBuildConfig,
      );
      const preCompactMessages = assembleModelFacingMessages({
        systemPrefix,
        conversation: preCompactConversation,
        phaseOverlay,
      });
      // Full-window BPE is expensive on long sessions (synchronous on main);
      // reused below whenever compaction / orphan sealing left the transcript
      // untouched.
      const preCompactEstimate = estimateTokensForRequest(
        preCompactMessages,
        estimateTools,
      );
      const windowEstimateTokens = preCompactEstimate.decision;
      const transcriptLengthBefore = session.messages.length;
      const transcriptTailBefore = session.messages.at(-1);

      const compactResult = skipCompact
        ? {
            compacted: false as const,
            estimatedTokens: resolveDecisionTokens(
              session.contextUsage,
              windowEstimateTokens,
            ).decisionTokens,
          }
        : await strategy.maybeCompactBeforeIteration({
            session,
            client,
            createId,
            contextLimitTokens,
            compactTriggerRatio,
            iterationProtectRawIterationCount,
            iterationProtectTokenRatio,
            tools: iterationTools,
            windowEstimateTokens,
            ...(signal ? { signal } : {}),
            ...(onEvent ? { onEvent } : {}),
            ...(input.summarize ? { summarize: input.summarize } : {}),
          });

      if (compactResult.compacted) {
        clearDisplayFlushTimer();
        pendingUserPromptTokens = 0;
        pendingStreamTokens = 0;
        streamTextBuf = "";
        streamToolBuf = "";
        streamReasoningBuf = "";
        emitContextDisplay(
          session,
          onEvent,
          session.contextUsage.displayUsedTokens ??
            session.contextUsage.usedTokens,
          "estimate",
        );
      }

      if ("error" in compactResult && compactResult.error) {
        const cancelled =
          compactResult.error === "Cancelled" || signal?.aborted;
        emit(onEvent, {
          type: "error",
          message: compactResult.error,
        });
        if (!cancelled) {
          agentLogError("compact.error", {
            sessionId: session.id,
            message: compactResult.error,
            estimatedTokens: compactResult.estimatedTokens,
          });
        }
        return {
          ok: false,
          result: await finish(
            cancelled ? "cancelled" : "error",
            compactResult.error,
            cancelled ? "cancelled" : "error",
          ),
        };
      }

      const midSealed = sealOrphanToolCallsInSession(session, createId);
      if (midSealed > 0) {
        agentLogWarn("tool.orphan_tool_calls_sealed", {
          sessionId: session.id,
          sealed: midSealed,
          phase: "before_model_round",
        });
      }

      modelIterations += 1;

      const transcriptUnchanged =
        !compactResult.compacted &&
        midSealed === 0 &&
        session.messages.length === transcriptLengthBefore &&
        session.messages.at(-1) === transcriptTailBefore;
      // Rebuild conversation after compact may have inserted/replaced a marker.
      const conversationMessages = transcriptUnchanged
        ? preCompactConversation
        : strategy.buildModelMessages(windowSource(), windowBuildConfig);
      let modelMessages = transcriptUnchanged
        ? preCompactMessages
        : assembleModelFacingMessages({
            systemPrefix,
            conversation: conversationMessages,
            phaseOverlay,
          });
      let didHardTruncate = false;
      const preTruncateEstimate = transcriptUnchanged
        ? preCompactEstimate
        : estimateTokensForRequest(modelMessages, estimateTools);
      {
        const hardTruncateTrigger = Math.floor(
          contextLimitTokens * compactTriggerRatio,
        );
        // Same gate as compaction: provider prompt_tokens when available,
        // else the full-window BPE estimate (system + conversation + overlay +
        // tools). Using estimate alone previously starved LLM compaction on
        // GLM (local o200k ~1.2–1.6× over provider).
        // A turn-limited window is much smaller than the last provider usage
        // (measured on the full transcript), so only its own estimate counts.
        const { decisionTokens, source: decisionSource } = turnLimit
          ? { decisionTokens: preTruncateEstimate.decision, source: "estimate" as const }
          : resolveDecisionTokens(session.contextUsage, preTruncateEstimate.decision);
        if (decisionTokens >= hardTruncateTrigger && prep.skipHardTruncate !== true) {
          const budget = Math.floor(
            contextLimitTokens * DEFAULT_HARD_TRUNCATE_RATIO,
          );
          const overlayMsgs = phaseOverlayMessages(phaseOverlay);
          const overlayReserve =
            overlayMsgs.length > 0
              ? estimateTokensForRequest(overlayMsgs, []).decision
              : 0;
          const conversationBudget = Math.max(
            1,
            budget - Math.max(0, overlayReserve),
          );
          // Truncate conversation only; always re-attach trailing overlay.
          const truncated = hardTruncateKeepingSystemPrefix(
            systemPrefix,
            conversationMessages,
            conversationBudget,
          );
          if (truncated.truncated) {
            modelMessages = ensureWireUserMessage([
              ...truncated.messages,
              ...overlayMsgs,
            ]);
            didHardTruncate = true;
            emit(onEvent, {
              type: "progress",
              text: "Context hard-truncated",
            });
            agentLogWarn("context.hard_truncate", {
              sessionId: session.id,
              iteration: modelIterations,
              decisionTokens,
              decisionSource,
              beforeTokens: preTruncateEstimate.decision,
              keptTokens: truncated.keptTokens,
              budgetTokens: budget,
              droppedMessageCount: truncated.droppedMessageCount,
              keptMessageCount: truncated.keptMessageCount,
              contextLimitTokens,
              afterCompact: compactResult.compacted,
            });
          }
        }
      }

      const tokenEstimate = didHardTruncate
        ? estimateTokensForRequest(modelMessages, estimateTools)
        : preTruncateEstimate;
      const estimatedTokens = tokenEstimate.decision;

      if (compactResult.compacted || didHardTruncate) {
        session.contextUsage = {
          usedTokens: estimatedTokens,
          displayUsedTokens: estimatedTokens,
          source: "estimate",
        };
        emitContextDisplay(session, onEvent, estimatedTokens, "estimate");
      }

      agentLogInfo("iteration.start", {
        sessionId: session.id,
        iteration: modelIterations,
        estimatedTokens,
        estimateRaw: tokenEstimate.raw,
        estimateMessages: tokenEstimate.messages,
        estimateTools: tokenEstimate.tools,
        lastKnownUsedTokens: session.contextUsage.usedTokens,
        lastKnownSource: session.contextUsage.source ?? null,
        displayUsedTokens: session.contextUsage.displayUsedTokens ?? null,
        messageCount: modelMessages.length,
      });

      return {
        ok: true,
        reasoningScope: windowBuildConfig.reasoningScope,
        messages: modelMessages,
        estimatedTokens,
        compacted: compactResult.compacted,
      };
    },

    async streamModelRound(roundInput: {
      llm: import("./types.js").TurnStreamLlm;
      messages: import("../../llm/types.js").OpenAiChatMessage[];
      tools: import("../../llm/types.js").OpenAiToolDefinition[];
      hostedTools?: JsonObject[];
      builtScope?: string;
      progressText: string;
    }): Promise<ModelRoundResult> {
      const recovery = await reconcileResponsesRequests([roundInput.llm.client]);
      if (recovery) return { kind: recovery.status === "cancelled" ? "cancelled" : "error", result: recovery };
      touch(session, roundInput.progressText || "Waiting for model…");

      const assistant: AssistantMessage = {
        id: createId(),
        role: "assistant",
        createdAt: Date.now(),
        parts: [],
      };
      session.messages.push(assistant);
      touch(session);

      const toolCalls: ToolCallPart[] = [];
      let roundError: string | undefined;
      let streamDoneReason:
        | "completed"
        | "cancelled"
        | "paused"
        | "error"
        | undefined;
      let sawUsage = false;
      const announcedToolPrep = new Set<string>();
      // Streaming write reservations for this round: streamKey (delta id) →
      // { token, path, materialized }. Non-materialized reservations are
      // released when the stream ends; materialized ones wait for the handler
      // adopt (permission approval included) or runTools/dispose cleanup.
      const streamWriteReservations = new Map<
        string,
        { token: string; path: string; materialized: boolean }
      >();
      const streamWriteArgs = new Map<string, string>();
      let reasoningBuf = "";
      /** Any reasoning delta streamed in this round (even empty ones). */
      let sawReasoningDelta = false;
      /**
       * The round's first text part was born before any reasoning delta —
       * the reply led the round, so the merged Thought must stay BELOW it
       * (stream order). Otherwise reasoning streamed first and the Thought
       * renders above the reply text.
       */
      let textLedRound = false;
      let reasoningStartedAt = 0;
      let reasoningLastAt = 0;
      let roundBillableTokens = 0;

      const estimatedTokens = estimateTokensForRequest(
        roundInput.messages,
        [...roundInput.tools, ...(roundInput.hostedTools ?? [])],
      ).decision;

      const chatOptions: StreamChatOptions = {
        messages: roundInput.messages,
        tools: roundInput.tools,
        ...(roundInput.hostedTools?.length ? { nativeTools: roundInput.hostedTools } : {}),
        meta: {
          sessionId: session.id,
          iteration: modelIterations,
          purpose: "chat",
        },
      };
      const roundInterruptSignal = interruptController?.signal;
      if (signal || roundInterruptSignal) {
        const roundSignal =
          signal && roundInterruptSignal
            ? AbortSignal.any([signal, roundInterruptSignal])
            : (signal ?? roundInterruptSignal);
        if (roundSignal) {
          chatOptions.signal = roundSignal;
        }
      }

      const activeLlm = roundInput.llm;
      const modelConfig = activeLlm.client;
      const roundStream = activeLlm.stream;
      const disableResponsesState = async (
        reason: "store_rejected" | "previous_response_id_rejected",
      ): Promise<void> => {
        if (modelConfig.responsesStateful !== true) return;
        modelConfig.responsesStateful = false;
        agentLogInfo("responses.stateful_disabled", {
          sessionId: session.id,
          model: modelConfig.model,
          reason,
        });
        try {
          await modelConfig.onResponsesStatefulDisabled?.(reason);
        } catch (error) {
          agentLogWarn("responses.stateful_disable_persist_failed", {
            sessionId: session.id,
            model: modelConfig.model,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      };
      // Saved approvals from a mixed local/native round are still pending.
      // A later Graph action may have removed their server. Persist the denied
      // answer in both the wire window and transcript before preparing hashes.
      let approvalsChanged = false;
      for (const message of roundInput.messages) {
        const state = message.responsesOutput;
        if (!state?.continuationInput || state.providerScope !== reasoningScopeForClient(modelConfig)) continue;
        let changed = false;
        const answers = state.continuationInput.map((answer) => {
          if (answer.type !== "mcp_approval_response" || answer.approve !== true) return answer;
          const approval = state.output.find((item) => item.type === "mcp_approval_request" && item.id === answer.approval_request_id);
          if (canApproveHostedMcp(approval, roundInput.hostedTools ?? [], state.output)) return answer;
          changed = true;
          return { ...answer, approve: false };
        });
        if (!changed) continue;
        message.responsesOutput = { ...state, continuationInput: answers };
        for (const source of session.messages) {
          for (const part of source.parts) {
            if (part.type === "model_response" && part.providerScope === state.providerScope && part.responseId === state.responseId) {
              part.continuationInput = answers;
            }
          }
        }
        approvalsChanged = true;
      }
      if (approvalsChanged) await input.checkpoint?.();
      const apiAdapter = dispatchLlmApi(modelConfig);
      const boundMessages = apiAdapter.messagesForBinding(
        roundInput.messages,
        roundInput.builtScope,
        modelConfig,
      );
      chatOptions.messages = boundMessages;
      const nativeContext = apiAdapter.prepareServerContext(boundMessages, modelConfig);
      if (nativeContext) {
        chatOptions.responses = { input: nativeContext.input,
          ...(nativeContext.previousResponseId ? { previousResponseId: nativeContext.previousResponseId } : {}) };
      }
      let nativePart: ModelResponsePart | undefined;
      let beforeRequestPart: ModelResponsePart | undefined;
      let restoredUnsubmittedRequest = false;
      let rejectedReplayBlocked = false;
      // Logical input the next response is chained on; visible-only after an unsafe replay.
      let sealBaseInput = nativeContext?.fullInput;

      streamTextBuf = "";
      streamToolBuf = "";
      streamReasoningBuf = "";
      pendingStreamTokens = 0;

      const roundStartedAt = Date.now();
      // Providers usually emit done:cancelled, but an async iterator may
      // throw AbortError instead. Normalize it so partial-content sealing
      // and reservation cleanup always run before the turn continues.
      const roundEvents = async function* (): AsyncGenerator<StreamEvent> {
        try {
          let requestOptions = chatOptions;
          let fullRequestInput = nativeContext?.fullInput;
          let cursorFallbackUsed = false;
          const accumulated: JsonObject[] = [];
          for (let approvalRound = 0; ; approvalRound += 1) {
            let currentOutput: JsonObject[] = [];
            let finalState: Extract<StreamEvent, { type: "response_state" }> | undefined;
            let terminal: Extract<StreamEvent, { type: "done" }> | undefined;
            let rejectedCursor: string | undefined;
            let rejectedStore = false;
            let cursorError: Extract<StreamEvent, { type: "error" }> | undefined;
            let acceptedResponse = false;
            for await (const event of roundStream(modelConfig, requestOptions)) {
              if (event.type === "response_state") {
                if (event.rejectedPreviousResponseId === requestOptions.responses?.previousResponseId
                  && event.rejectedPreviousResponseId) {
                  rejectedCursor = event.rejectedPreviousResponseId;
                  rejectedReplayBlocked = !fullRequestInput || !canReplayResponsesInput(fullRequestInput);
                  await disableResponsesState("previous_response_id_rejected");
                }
                if (event.rejectedStore === true) {
                  rejectedStore = true;
                  rejectedReplayBlocked = !fullRequestInput || !canReplayResponsesInput(fullRequestInput);
                  await disableResponsesState("store_rejected");
                }
                if (event.responseId) acceptedResponse = true;
                finalState = event;
                if (event.output) currentOutput = event.output;
                yield { ...event,
                  ...(event.status === "submitting" && !event.requestSafety
                    ? { requestSafety: classifyResponsesRequestSafety(requestOptions.nativeTools, requestOptions.responses?.input) } : {}),
                  ...(event.output ? { output: [...accumulated, ...event.output] } : {}) };
              } else if (event.type === "error" && (rejectedCursor || rejectedStore)) {
                // Do not send a terminal UI error before trying the known local
                // history. Only an explicit HTTP rejection can reach this path.
                cursorError = event;
              } else if (event.type === "done") terminal = event;
              else yield event;
            }
            if (rejectedCursor || rejectedStore) {
              if (!cursorFallbackUsed && !acceptedResponse && terminal?.reason === "error"
                && !chatOptions.signal?.aborted) {
                cursorFallbackUsed = true;
                if (rejectedReplayBlocked || !fullRequestInput) {
                  // Native items could re-run approved hosted work when replayed
                  // statelessly. Continue from visible text and local tool records.
                  const scope = reasoningScopeForClient(modelConfig);
                  fullRequestInput = responsesInputFromMessages(roundInput.messages.map((message) => {
                    if (message.responsesOutput?.providerScope !== scope) return message;
                    const { responsesOutput: _native, ...visible } = message;
                    return visible;
                  }), scope);
                  sealBaseInput = fullRequestInput;
                  accumulated.length = 0;
                }
                // Seamless by design: providers without real stored context
                // hit this every turn. Log for traceability, never surface
                // in chat — the local-history continuation is equivalent.
                if (rejectedStore) {
                  agentLogInfo("responses.store_fallback", {
                    sessionId: session.id,
                    replayBlocked: rejectedReplayBlocked === true,
                  });
                } else {
                  agentLogInfo("responses.cursor_fallback", {
                    sessionId: session.id,
                    responseId: rejectedCursor,
                    replayBlocked: rejectedReplayBlocked === true,
                  });
                }
                requestOptions = { ...requestOptions, responses: { input: fullRequestInput, noRetry: true } };
                continue;
              }
              yield cursorError ?? { type: "error", message: "The saved server context is unavailable." };
              if (terminal) yield terminal;
              break;
            }
            const approvals = currentOutput.filter((item) => item.type === "mcp_approval_request" && typeof item.id === "string");
            if (!nativeContext || terminal?.reason !== "completed" || !approvals.length) {
              if (terminal) yield terminal;
              break;
            }
            if (approvalRound >= 8) throw new Error("Too many consecutive hosted MCP approval requests");
            const answers: JsonObject[] = [];
            try {
              for (const approval of approvals) {
                chatOptions.signal?.throwIfAborted();
                let toolArguments: JsonObject = {};
                try {
                  const parsed = typeof approval.arguments === "string" ? JSON.parse(approval.arguments) : approval.arguments;
                  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) toolArguments = parsed;
                } catch { toolArguments = { arguments: String(approval.arguments ?? "") }; }
                const approve = canApproveHostedMcp(approval, roundInput.hostedTools ?? [], [...accumulated, ...currentOutput])
                  && gate.headless !== true && typeof gate.requestConfirmation === "function"
                  ? await abortable(gate.requestConfirmation({ toolName: `MCP ${String(approval.server_label ?? "")}/${String(approval.name ?? "tool")}`,
                      arguments: toolArguments }), chatOptions.signal) : false;
                chatOptions.signal?.throwIfAborted();
                answers.push({ type: "mcp_approval_response", approval_request_id: approval.id!, approve });
              }
            } catch (error) {
              // Stop / steer while prompting: record a denial for every request so the
              // next continuation is accepted and nothing approved runs later.
              if (nativePart && chatOptions.signal?.aborted) {
                nativePart.continuationInput = approvals.map((approval): JsonObject => (
                  { type: "mcp_approval_response", approval_request_id: approval.id!, approve: false }));
                await input.checkpoint?.();
              }
              throw error;
            }
            // A mixed response must return its functions to RunTools first.
            // The next model round submits both local outputs and approvals.
            if (currentOutput.some((item) => item.type === "function_call")) {
              if (nativePart) { nativePart.continuationInput = answers; await input.checkpoint?.(); }
              if (terminal) yield terminal;
              break;
            }
            accumulated.push(...currentOutput, ...answers);
            if (nativePart) { nativePart.continuationInput = answers; await input.checkpoint?.(); }
            fullRequestInput = [...nativeContext.fullInput, ...accumulated];
            requestOptions = { ...chatOptions, responses: !cursorFallbackUsed && finalState?.stored && finalState.responseId
              ? { input: answers, previousResponseId: finalState.responseId }
              : { input: fullRequestInput, ...(cursorFallbackUsed ? { noRetry: true } : {}) } };
          }
        } catch (err) {
          if (!chatOptions.signal?.aborted) throw err;
          yield { type: "done", reason: "cancelled" };
        }
      };
      for await (const event of roundEvents()) {
        if (event.type === "response_state") {
          if (event.status === "submitting") {
            restoredUnsubmittedRequest = false;
            beforeRequestPart = nativePart?.status === "completed" ? structuredClone(nativePart) : undefined;
          }
          if (event.status === "not_submitted" && nativePart && beforeRequestPart) {
            // A cancelled MCP continuation that never reached fetch still owns
            // its previous completed response and its unsent approval answers.
            const index = assistant.parts.indexOf(nativePart);
            nativePart = beforeRequestPart;
            assistant.parts[index] = nativePart;
            restoredUnsubmittedRequest = true;
            touch(session);
            await input.checkpoint?.();
            emit(onEvent, { type: "response_state", responseId: nativePart.responseId, status: nativePart.status,
              stored: nativePart.stored, messageId: assistant.id });
            continue;
          }
          if (event.rejectedPreviousResponseId) {
            // Drop the current binding's old cursor chain, while retaining its
            // completed output and tool results. Persist before any new POST.
            // When native replay is unsafe, history keeps only visible records.
            const scope = reasoningScopeForClient(modelConfig);
            for (const message of session.messages) {
              for (const part of message.parts) {
                if (part.type !== "model_response" || part.providerScope !== scope) continue;
                part.stored = false;
                if (part.resumeFrom) part.resumeFrom.stored = false;
                if (rejectedReplayBlocked && part !== nativePart) {
                  if (part.status === "completed") part.contextReplayBlocked = true;
                  if (part.resumeFrom) part.resumeFrom.contextReplayBlocked = true;
                }
              }
            }
            for (const message of roundInput.messages) {
              if (message.responsesOutput?.providerScope === scope) message.responsesOutput.stored = false;
            }
          }
          if (!nativePart) {
            nativePart = { type: "model_response", providerScope: reasoningScopeForClient(modelConfig),
              responseId: event.responseId, status: event.status, stored: event.stored === true, output: [],
              model: modelConfig.model, hostedEffects: Boolean(roundInput.hostedTools?.length) };
            assistant.parts.push(nativePart);
          }
          nativePart.responseId = event.responseId;
          nativePart.status = event.status;
          if (event.requestSafety) {
            nativePart.requestSafety = event.requestSafety;
            nativePart.hostedEffects = event.requestSafety === "effects_possible";
          }
          if (event.rejectedPreviousResponseId) nativePart.stored = false;
          else if (event.stored !== undefined) nativePart.stored = event.stored;
          if (event.status === "submitting" && beforeRequestPart) {
            // Persisted before fetch: if this continuation's outcome is lost,
            // recovery branches again from the completed response.
            const { type: _type, resumeFrom: _prior, ...prior } = beforeRequestPart;
            nativePart.resumeFrom = prior;
          }
          if (event.output) {
            nativePart.output = event.output;
            delete nativePart.continuationInput;
            delete nativePart.resumeFrom;
          }
          sealResponsesContext(nativePart, sealBaseInput);
          touch(session);
          await input.checkpoint?.();
          emit(onEvent, { type: "response_state", responseId: event.responseId, status: event.status,
            stored: nativePart.stored, messageId: assistant.id });
          continue;
        }
        if (event.type === "hosted_tool") {
          upsertHostedTool(assistant, { id: event.id, name: event.name, status: event.status,
            ...(event.item ? { item: event.item } : {}) });
          touch(session);
          await input.checkpoint?.();
          emit(onEvent, { ...event, messageId: assistant.id });
          continue;
        }
        if (event.type === "text_delta") {
          const hadTextPart = assistant.parts.some((p) => p.type === "text");
          const textPart = ensureTextPart(assistant.parts);
          if (!hadTextPart && !sawReasoningDelta) textLedRound = true;
          textPart.text += event.text;
          streamTextBuf += event.text;
          touch(session);
          emit(onEvent, { ...event, messageId: assistant.id });
          refreshContextDisplay();
          continue;
        }

        if (event.type === "reasoning_delta") {
          const now = Date.now();
          sawReasoningDelta = true;
          if (!reasoningStartedAt) reasoningStartedAt = now;
          reasoningLastAt = now;
          reasoningBuf += event.text;
          streamReasoningBuf += event.text;
          touch(session);
          emit(onEvent, { ...event, messageId: assistant.id });
          refreshContextDisplay();
          continue;
        }

        if (event.type === "tool_call") {
          // Materialize the streaming write reservation for this call:
          // rekey pending-N → real id (keeps the FIFO position) and hold it
          // until the handler adopts (or deny / args-error / sweep releases).
          if (FILE_WRITE_TOOL_NAMES.has(event.name)) {
            const finalPath =
              extractPartialPath(event.argumentsRaw ?? "") ??
              (typeof event.arguments?.path === "string" &&
              event.arguments.path.trim().startsWith("/")
                ? event.arguments.path.trim()
                : null);
            if (finalPath) {
              for (const [key, rec] of [...streamWriteReservations]) {
                if (rec.materialized || rec.path !== finalPath) continue;
                const realToken = fileLockToken(session.id, event.id);
                if (key !== event.id) {
                  rekeyStreamingReservation(rec.path, rec.token, realToken);
                  streamWriteReservations.delete(key);
                }
                streamWriteReservations.set(event.id, {
                  token: realToken,
                  path: rec.path,
                  materialized: true,
                });
                break; // first non-materialized match = earliest queued
              }
            }
          }
          const part: ToolCallPart = {
            type: "tool_call",
            id: event.id,
            name: event.name,
            status: "pending",
            arguments: event.arguments,
            argumentsRaw: event.argumentsRaw,
            ...(typeof event.argumentsError === "string"
              ? { argumentsError: event.argumentsError }
              : {}),
          };
          assistant.parts.push(part);
          toolCalls.push(part);
          touch(session);
          emit(onEvent, { ...event, messageId: assistant.id });
          continue;
        }

        if (event.type === "tool_call_delta") {
          if (event.argumentsRawDelta) {
            streamToolBuf += event.argumentsRawDelta;
            // Streaming write reservation: while write args stream in, the
            // target file counts as "being written" (readers queue behind).
            const streamKey = event.id;
            const streamName =
              typeof event.name === "string" ? event.name.trim() : "";
            if (streamKey) {
              const next =
                (streamWriteArgs.get(streamKey) ?? "") +
                event.argumentsRawDelta;
              streamWriteArgs.set(streamKey, next);
              if (streamName && FILE_WRITE_TOOL_NAMES.has(streamName)) {
                const partial = extractPartialPath(next);
                if (partial) {
                  // Same-path reservation under a superseded stream key
                  // (pending-N → real id flip mid-stream): rekey in place to
                  // keep the FIFO position instead of dropping to the tail.
                  for (const [otherKey, rec] of [...streamWriteReservations]) {
                    if (
                      rec.path === partial &&
                      otherKey !== streamKey &&
                      !rec.materialized
                    ) {
                      const rekeyedToken = fileLockToken(session.id, streamKey);
                      rekeyStreamingReservation(
                        rec.path,
                        rec.token,
                        rekeyedToken,
                      );
                      streamWriteReservations.delete(otherKey);
                      streamWriteReservations.set(streamKey, {
                        ...rec,
                        token: rekeyedToken,
                      });
                    }
                  }
                  if (!streamWriteReservations.has(streamKey)) {
                    const token = fileLockToken(session.id, streamKey);
                    reserveStreamingWrite(partial, token);
                    streamWriteReservations.set(streamKey, {
                      token,
                      path: partial,
                      materialized: false,
                    });
                  }
                }
              }
            }
          }
          if (typeof event.name === "string" && event.name.length > 0) {
            streamToolBuf += event.name;
          }
          emit(onEvent, { ...event, messageId: assistant.id });
          const toolName =
            typeof event.name === "string" ? event.name.trim() : "";
          const prepKey = event.id || toolName;
          if (toolName && prepKey && !announcedToolPrep.has(prepKey)) {
            announcedToolPrep.add(prepKey);
            const text = toolPreparingProgressText(toolName);
            touch(session, text);
            emit(onEvent, { type: "progress", text, toolName });
          }
          refreshContextDisplay();
          continue;
        }

        if (event.type === "usage") {
          sawUsage = true;
          const applied = applyUsageToSession(
            session,
            event,
            estimatedTokens,
            onEvent,
          );
          if (applied) {
            clearDisplayFlushTimer();
            pendingUserPromptTokens = 0;
            pendingStreamTokens = 0;
            streamTextBuf = "";
            streamToolBuf = "";
            streamReasoningBuf = "";
            lastDisplayEmitAt = Date.now();
            const total =
              typeof event.totalTokens === "number" && event.totalTokens > 0
                ? event.totalTokens
                : (typeof event.promptTokens === "number"
                    ? event.promptTokens
                    : 0) +
                  (typeof event.completionTokens === "number"
                    ? event.completionTokens
                    : 0);
            if (total > 0) {
              roundBillableTokens = total;
            }
          }
          emit(onEvent, event);
          continue;
        }

        if (event.type === "status" || event.type === "progress") {
          if (event.type === "progress") {
            touch(session, event.text);
          }
          emit(onEvent, event);
          continue;
        }

        if (event.type === "error") {
          roundError = event.message;
          // The renderer treats error as terminal. A deliberate prompt
          // interrupt is a continuation, including cancellation reported
          // before a request starts or during provider retry backoff.
          if (!roundInterruptSignal?.aborted || signal?.aborted) {
            emit(onEvent, event);
          }
          continue;
        }

        if (event.type === "done") {
          streamDoneReason = event.reason;
          continue;
        }
      }

      // Stream ended: release reservations that never materialized into a
      // tool_call (aborted arg streaming / partial JSON / duplicate names).
      for (const [key, rec] of [...streamWriteReservations]) {
        if (!rec.materialized) {
          releaseStreamingReservation(rec.path, rec.token);
          streamWriteReservations.delete(key);
        }
      }
      streamWriteArgs.clear();

      if (!sawUsage) {
        if (session.contextUsage.source !== "provider") {
          clearDisplayFlushTimer();
          pendingUserPromptTokens = 0;
          pendingStreamTokens = 0;
          streamTextBuf = "";
          streamToolBuf = "";
          streamReasoningBuf = "";
          session.contextUsage = {
            usedTokens: estimatedTokens,
            displayUsedTokens: estimatedTokens,
            source: "estimate",
          };
          touch(session);
          emitContextDisplay(session, onEvent, estimatedTokens, "estimate");
        } else {
          refreshContextDisplay(true);
        }
      }

      if (nativePart?.output.length) {
        if (!restoredUnsubmittedRequest && nativePart.status === "completed" && (roundError || streamDoneReason === "error")) {
          nativePart.status = "invalid";
          delete nativePart.contextHash;
          delete nativePart.contextLength;
        }
        applyResponsesOutput(assistant, nativePart.output);
        touch(session);
        await input.checkpoint?.();
      }
      const interruptedActivities = sealHostedToolProgress(assistant);
      if (interruptedActivities.length) {
        touch(session);
        await input.checkpoint?.();
        for (const activity of interruptedActivities) {
          emit(onEvent, { ...activity, messageId: assistant.id });
        }
      }
      const textPart = assistant.parts.find(
        (p): p is TextPart => p.type === "text",
      );
      if (reasoningBuf.trim() || toolCalls.length > 0) {
        const durationMs =
          reasoningStartedAt > 0
            ? Math.max(0, (reasoningLastAt || Date.now()) - reasoningStartedAt)
            : undefined;
        const tokenCount = reasoningBuf
          ? estimateTokensFromText(reasoningBuf)
          : 0;
        const reasoningPart: {
          type: "reasoning";
          text: string;
          providerScope: string;
          durationMs?: number;
          tokenCount?: number;
        } = {
          type: "reasoning",
          text: reasoningBuf,
          providerScope: reasoningScopeForClient(modelConfig),
        };
        if (durationMs !== undefined) reasoningPart.durationMs = durationMs;
        if (tokenCount > 0) reasoningPart.tokenCount = tokenCount;
        // Place the merged Thought at its first-occurrence position: when
        // reasoning streamed before the reply, it belongs above the round's
        // text AND its tool calls (the snapshot projection renders parts in
        // order — a trailing placement used to flip text above the Thought
        // and split one visual Thinking block into two rows on rebuild).
        const firstToolIdx = assistant.parts.findIndex(
          (p) => p.type === "tool_call",
        );
        const textIdx = textLedRound
          ? -1
          : assistant.parts.findIndex((p) => p.type === "text");
        const insertAt =
          textIdx >= 0 && (firstToolIdx < 0 || textIdx < firstToolIdx)
            ? textIdx
            : firstToolIdx;
        if (insertAt >= 0) {
          assistant.parts.splice(insertAt, 0, reasoningPart);
        } else {
          assistant.parts.push(reasoningPart);
        }
        if (reasoningBuf.trim()) {
          console.warn(
            `[agent] reasoning (iteration ${modelIterations}, ${reasoningBuf.length} chars):\n` +
              truncateForLog(reasoningBuf, 2_000),
          );
        }
      }
      agentLogInfo("iteration.end", {
        sessionId: session.id,
        iteration: modelIterations,
        durationMs: Date.now() - roundStartedAt,
        textChars: textPart?.text.length ?? 0,
        reasoningChars: reasoningBuf.length,
        ...(reasoningBuf
          ? { reasoningPreview: truncateForLog(reasoningBuf, 8_000) }
          : {}),
        toolCallCount: toolCalls.length,
        toolNames: toolCalls.map((c) => c.name),
        streamDoneReason: streamDoneReason ?? null,
        ...(roundError ? { error: roundError } : {}),
        usedTokens: session.contextUsage.usedTokens,
      });

      if (roundBillableTokens > 0) {
        turnBillableTokens += roundBillableTokens;
      }

      if (signal?.aborted || roundInterruptSignal?.aborted || streamDoneReason === "cancelled") {
        if (
          roundInterruptSignal?.aborted === true &&
          signal?.aborted !== true
        ) {
          // User-prompt interrupt — non-terminal. Seal partial content:
          // keep streamed text/reasoning (text gets a "(interrupted)"
          // suffix so the model sees why it stopped), cancel-seal complete
          // tool calls with an explicit not-executed result, release their
          // write reservations, drop an empty assistant shell. The round
          // gate drains the queued prompt before the next model call.
          if (textPart) {
            if (textPart.text.trim()) {
              textPart.text += "\n\n(interrupted)";
            } else {
              const textIdx = assistant.parts.indexOf(textPart);
              if (textIdx >= 0) assistant.parts.splice(textIdx, 1);
            }
          }
          const sealed = sealToolCallsWithCancelledResults(
            session,
            createId,
            toolCalls,
            "Interrupted by user message — not executed",
            assistant.id,
          );
          for (const call of sealed) {
            emit(onEvent, {
              type: "tool_finished", id: call.id, name: call.name,
              messageId: assistant.id,
            });
          }
          for (const rec of streamWriteReservations.values()) {
            if (rec.materialized) {
              releaseStreamingReservation(rec.path, rec.token);
            }
          }
          streamWriteReservations.clear();
          if (assistant.parts.length === 0 && sealed.length === 0) {
            session.messages.pop();
          }
          agentLogInfo("turn.round_interrupted", {
            sessionId: session.id,
            iteration: modelIterations,
            sealedToolCalls: sealed.length,
            textChars: textPart?.text.length ?? 0,
          });
          emit(onEvent, {
            type: "round_interrupted",
            messageId: assistant.id,
          });
          emit(onEvent, {
            type: "progress",
            text: "Interrupted — applying your message…",
          });
          return {
            kind: "interrupted",
            assistant,
            reasoningBuf,
            roundBillableTokens,
            sealedToolCalls: sealed.length,
          };
        }
        return {
          kind: "cancelled",
          result: await finish("cancelled", "Cancelled", "cancelled"),
        };
      }

      if (roundError || streamDoneReason === "error") {
        const errText = roundError ?? "Model error";
        return {
          kind: "error",
          result: await finish("error", errText, "error"),
        };
      }

      return {
        kind: "ok",
        assistant,
        toolCalls,
        ...(textPart ? { textPart } : {}),
        reasoningBuf,
        roundBillableTokens,
      };
    },

    async runToolsPhase(
      assistant: AssistantMessage,
      toolCalls: ToolCallPart[],
      options?: {
        disabledTools?: string[];
        allowedTools?: string[];
        extra?: Record<string, unknown>;
      },
    ): Promise<ToolsPhaseResult> {
      const phaseDisabledTools =
        options?.disabledTools && options.disabledTools.length > 0
          ? options.disabledTools
          : undefined;
      const allowedTools =
        options?.allowedTools && options.allowedTools.length > 0
          ? options.allowedTools
          : undefined;
      const toolsResult = await runTools({
        session,
        assistantMessageId: assistant.id,
        toolCalls,
        ...(input.additionalTools ? { additionalTools: input.additionalTools } : {}),
        gate,
        createId,
        ...(input.checkpoint ? { checkpoint: input.checkpoint } : {}),
        applySessionPatch: applySessionPatchToSession,
        ...(phaseDisabledTools ? { phaseDisabledTools } : {}),
        ...(allowedTools ? { allowedTools } : {}),
        ...(options?.extra ? { toolContextExtra: options.extra } : {}),
        ...(signal ? { signal } : {}),
        // Interrupt-mode prompts cascade into interruptible-class calls
        // only (isInterruptibleToolName); write-class tools complete.
        ...(interruptController
          ? { interruptSignal: interruptController.signal }
          : {}),
        ...(onEvent ? { onEvent } : {}),
        ...(input.getVisionClient
          ? { getVisionClient: input.getVisionClient }
          : {}),
        ...(input.getImageGenClient
          ? { getImageGenClient: input.getImageGenClient }
          : {}),
        ...(input.uploadImageGenInput
          ? { uploadImageGenInput: input.uploadImageGenInput }
          : {}),
        ...(hooks ? { hooks } : {}),
        ...(subagentManager ? { subagents: subagentManager.asHost() } : {}),
        ...(input.parentSessionId
          ? { parentSessionId: input.parentSessionId }
          : {}),
        ...(input.subagentId ? { subagentId: input.subagentId } : {}),
        ...(isSubagentTurn
          ? {
              bridgeScope: bridgeScopeForSubagent(
                input.subagentRoleKind ?? "general",
              ),
            }
          : {}),
        ...(input.listAgentSessions
          ? { listAgentSessions: input.listAgentSessions }
          : {}),
        ...(input.listSessionHistory
          ? { listSessionHistory: input.listSessionHistory }
          : {}),
        ...(input.listWorkspaces
          ? { listWorkspaces: input.listWorkspaces }
          : {}),
        ...(input.fsmGraphLibrary
          ? { fsmGraphLibrary: input.fsmGraphLibrary }
          : {}),
        ...(input.turnHandoff ? { turnHandoff: input.turnHandoff } : {}),
        ...(input.loops ? { loops: input.loops } : {}),
        ...(input.notify ? { notify: input.notify } : {}),
        ...(!isSubagentTurn
          ? {
              resetModelIterations: () => {
                if (unlimitedTurnBudgets) return;
                const previous = modelIterations;
                modelIterations = 0;
                agentLogInfo("turn.budget_reset_ask_user", {
                  sessionId: session.id,
                  previousModelIterations: previous,
                });
              },
            }
          : {}),
      });

      // Non-force sweep: release write reservations this tool batch did not
      // adopt (permission deny/block, ask-mode / phase-disabled deny, unknown
      // tool, args parse error, bridge-scope rejection). Adopted-and-executed
      // holders already released themselves in withFileLock's finally.
      sweepTurnFileLocks(session.id);

      const toolBatchError = toolsResult.persistenceError ?? toolsResult.processingError;
      if (toolBatchError) {
        return {
          kind: "error",
          result: await finish("error", toolBatchError, "error"),
        };
      }

      if (toolsResult.cancelled || signal?.aborted) {
        return {
          kind: "cancelled",
          result: await finish("cancelled", "Cancelled", "cancelled"),
        };
      }

      toolFailureCount += toolsResult.toolFailureCount;

      return {
        kind: "ok",
        cancelled: false,
        toolFailureCount: toolsResult.toolFailureCount,
        routeEvents: toolsResult.routeEvents,
        ...(toolsResult.receipts ? { receipts: toolsResult.receipts } : {}),
      };
    },

    appendSyntheticToolRound(roundInput: {
      toolCalls: ToolCallPart[];
      progressText?: string;
    }): AssistantMessage {
      // DeepSeek thinking mode requires reasoning_content on every tool-call
      // assistant message in later requests — keep an empty reasoning part.
      const assistant: AssistantMessage = {
        id: createId(),
        role: "assistant",
        createdAt: Date.now(),
        ...(roundInput.toolCalls[0] ? { toolCallId: roundInput.toolCalls[0].id } : {}),
        parts: [{ type: "reasoning", text: "" }, ...roundInput.toolCalls],
      };
      session.messages.push(assistant);
      touch(session, roundInput.progressText);
      for (const call of roundInput.toolCalls) {
        emit(onEvent, {
          type: "tool_call",
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          argumentsRaw: call.argumentsRaw,
          messageId: assistant.id,
        });
      }
      return assistant;
    },

    async awaitSubagentBatches(options?: {
      waitIfIncomplete?: boolean;
    }): Promise<AwaitSubagentResult> {
      if (!subagentManager) return "none";
      subagentManager.sealOpenBatches();
      if (options?.waitIfIncomplete && subagentManager.hasIncompleteBatches()) {
        emit(onEvent, {
          type: "progress",
          text: "Waiting for subagents…",
        });
        touch(session, "Waiting for subagents…");
        try {
          await subagentManager.waitForIncompleteBatches(signal);
        } catch {
          return "cancelled";
        }
        if (signal?.aborted) {
          return "cancelled";
        }
      }
      const pending = subagentManager.drainInbox();
      if (pending.length > 0) {
        injectSubagentBatchResults({
          sessionMessages: session.messages,
          batches: pending,
          createId,
        });
        touch(session);
        return "injected";
      }
      return "none";
    },

    dropMessage(id: string): void {
      const idx = session.messages.findIndex((m) => m.id === id);
      if (idx >= 0) session.messages.splice(idx, 1);
    },

    finalizeEmptyAssistant(finalizeInput: {
      assistant: AssistantMessage;
      textPart?: TextPart;
      reasoningBuf: string;
    }): void {
      const hasText = (finalizeInput.textPart?.text.trim().length ?? 0) > 0;
      if (hasText) return;
      const reasoningText = finalizeInput.reasoningBuf.trim();
      if (reasoningText) {
        const notice =
          "The model returned only internal reasoning (no final reply). Showing that reasoning below:";
        const surfaced = ensureTextPart(finalizeInput.assistant.parts);
        surfaced.text = `${notice}\n\n${reasoningText}`;
        touch(session);
        agentLogWarn("round.reasoning_as_text", {
          sessionId: session.id,
          iteration: modelIterations,
          reasoningChars: reasoningText.length,
          reasoningPreview: truncateForLog(reasoningText, 8_000),
        });
      } else {
        host.dropMessage(finalizeInput.assistant.id);
        agentLogWarn("round.empty_assistant", {
          sessionId: session.id,
          iteration: modelIterations,
          reasoningChars: 0,
          reasoningPreview: "",
        });
      }
    },

    finish,
    emitProgress(text: string): void {
      touch(session, text);
      emit(onEvent, { type: "progress", text });
    },
    emitError(message: string): void {
      emit(onEvent, { type: "error", message });
    },
    touchSession(progressText?: string): void {
      touch(session, progressText);
    },

    dispose(): void {
      if (interruptPort) interruptPort.fire = null;
      interruptController = null;
      // Stop / cascade-abort safety net: force-release everything this turn
      // still owns — streaming reservations AND active holders. Release is
      // idempotent (an orphaned holder's later finally is a no-op); the
      // in-flight fs promise may still land — accepted on a cancelled path.
      sweepTurnFileLocks(session.id, { force: true });
      if (!subagentManager) return;
      const remaining = subagentManager.list(false);
      if (remaining.length > 0) {
        agentLogWarn("subagent.cleanup", {
          sessionId: session.id,
          runningCount: remaining.length,
          ids: remaining.map((r) => r.id),
        });
      }
      subagentManager.dispose();
      subagentManager = undefined;
    },
  };

  return host;
}
