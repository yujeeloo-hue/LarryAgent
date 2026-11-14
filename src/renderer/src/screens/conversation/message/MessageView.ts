import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../../../session/demoCardState.js";
import { renderMarkdownText, renderMarkdownTextAsync } from "../renderMarkdownText.js";
import { isShellToolName } from "../../../state/shellToolName.js";
import {
  isConversationCardVisible,
  TURN_REASONING_PART_ID,
  type ReasoningToolRecord,
} from "../turnDisplay.js";
import { createDisplayImageCard } from "../cards/DisplayImageCardView.js";
import { createDisplayPdfCard } from "../cards/DisplayPdfCardView.js";
import {
  createToolInvocationCard,
  type ToolResultSnapshot,
} from "../cards/ToolInvocationCardView.js";
import { unwrapToolCallBridge } from "../cards/toolInvocationHelpers.js";
import { createPlanCard } from "../cards/PlanCardView.js";
import { createAttachmentChip } from "../cards/AttachmentChipView.js";
import { createHostedToolCard } from "../cards/HostedToolCardView.js";
import { createResponseReferences, responseReferencesFromAnnotations } from "../cards/responseReferences.js";
import { createCompactionCard } from "../cards/CompactionCardView.js";
import { createClearCard } from "../cards/ClearCardView.js";
import { createDemoConfirmCard } from "../cards/DemoConfirmCardView.js";
import { createReasoningBlock, estimateReasoningTokensFromText } from "../cards/ReasoningBlockView.js";
import {
  createTurnErrorCard,
  isTurnErrorMessage,
  isTurnErrorTextPart,
  type RetryOutcome,
  type TurnErrorRetryPayload,
} from "../cards/TurnErrorCardView.js";
import type { PlanProgressDisplay, PlanSnapshot } from "../planSnapshots.js";
import type { SubagentCardSnapshot } from "../cards/SubagentCardView.js";
import { applyUserPromptClamp } from "./userPromptClamp.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "../../../../../session/types.js";
import { parseDemoConfirmMessage } from "../../../../../session/demoConfirm.js";

export type MessagePartLike = Record<string, unknown> & { type?: string };

export type MessageLike = {
  id?: string;
  role: string;
  parts: MessagePartLike[];
  toolCallId?: string;
};

export type MessageRenderContext = {
  sessionId?: string;
  messageId?: string;
  toolNamesByCallId: Map<string, string>;
  initiallyCollapsedToolCallIds?: Set<string>;
  toolResultsByCallId: Map<string, ToolResultSnapshot>;
  plansByCreateToolCallId: Map<string, PlanSnapshot>;
  progressByToolCallId: Map<string, PlanProgressDisplay>;
  subagentsByToolCallId: Map<string, SubagentCardSnapshot>;
  /** Subagent run id → LLM nickname (only when dispatch args set name). */
  subagentNamesById: Map<string, string>;
  pendingAsksByCallId: Map<
    string,
    {
      requestId: string;
      question: string;
      options: string[];
      optionDetails?: import("../../../../../shared/askUser.js").UserAskOption[];
      allowCustom: boolean;
      allowMultiple: boolean;
    }
  >;
  onUserAskAnswer?: (
    requestId: string,
    answer: { selected: string; selections?: string[]; custom: boolean; comment?: string },
  ) => void;
  onAbortToolCall?: (toolCallId: string) => void;
  /** present_demo: confirmed/queued params per tool call id. */
  demoSettledByCallId?: Map<string, DemoSettled>;
  /** present_demo: Confirm → submit values as the next user message. */
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    toolCallId: string,
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
  /** Retry payload per error message id (failed turn's user prompt). */
  turnErrorRetryByMessageId?: Map<string, TurnErrorRetryPayload>;
  /** Retry click: consume the error row and resend the turn's prompt. */
  onRetryTurnError?: (payload: TurnErrorRetryPayload) => RetryOutcome;
  revealLabel: string;
  onOpenFile: (path: string) => void;
  onRevealFile: (path: string) => void;
  /** Save As (copy to user-chosen location) for generated / output files. */
  onSaveFile?: (path: string) => void;
};

async function appendTextPartAsync(
  container: HTMLElement,
  text: string,
  annotations?: unknown,
  ctx?: MessageRenderContext,
): Promise<void> {
  const wrap = document.createElement("div");
  wrap.className = "message-part message-part-text";
  try {
    await renderMarkdownTextAsync(text, wrap);
  } catch (err) {
    console.error("[conversation] markdown render failed", err);
    wrap.textContent = text;
  }
  const references = createResponseReferences(responseReferencesFromAnnotations(annotations), ctx);
  if (references) wrap.append(references);
  container.append(wrap);
}

function appendTextPart(container: HTMLElement, text: string, annotations?: unknown, ctx?: MessageRenderContext): void {
  const wrap = document.createElement("div");
  wrap.className = "message-part message-part-text";
  try {
    // Sync callers (optimistic / streaming reconcile): Mermaid stays as a hint.
    renderMarkdownText(text, wrap, { streaming: true });
  } catch (err) {
    console.error("[conversation] markdown render failed", err);
    wrap.textContent = text;
  }
  const references = createResponseReferences(responseReferencesFromAnnotations(annotations), ctx);
  if (references) wrap.append(references);
  container.append(wrap);
}

async function appendPartAsync(
  container: HTMLElement,
  part: MessagePartLike,
  ctx: MessageRenderContext,
): Promise<void> {
  const type = part.type;
  if (type === "text" && typeof part.text === "string") {
    await appendTextPartAsync(container, part.text, part.annotations, ctx);
    return;
  }
  if (type === "reasoning" && typeof part.text === "string") {
    appendReasoningPart(container, part);
    return;
  }
  appendPart(container, part, ctx);
}

function appendReasoningPart(container: HTMLElement, part: MessagePartLike): void {
  const text = typeof part.text === "string" ? part.text : "";
  const toolHints = Array.isArray(part.toolHints)
    ? part.toolHints.filter((hint): hint is string => typeof hint === "string")
    : [];
  const rawRecords = Array.isArray(part.toolRecords) ? part.toolRecords : [];
  const toolRecords: ReasoningToolRecord[] = [];
  for (const item of rawRecords) {
    if (item === null || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    if (typeof record.hint !== "string" || !record.hint) continue;
    toolRecords.push({
      id: typeof record.id === "string" ? record.id : record.hint,
      hint: record.hint,
      ...(typeof record.durationMs === "number" && Number.isFinite(record.durationMs)
        ? { durationMs: record.durationMs }
        : {}),
      ...(record.failed === true ? { failed: true } : {}),
    });
  }
  if (!text.trim() && toolHints.length === 0 && toolRecords.length === 0) return;
  const stats: {
    durationMs?: number;
    tokenCount?: number;
  } = {};
  if (typeof part.durationMs === "number") stats.durationMs = part.durationMs;
  if (typeof part.tokenCount === "number") {
    stats.tokenCount = part.tokenCount;
  } else {
    stats.tokenCount = estimateReasoningTokensFromText(text);
  }
  const block = createReasoningBlock({
    text,
    mode: "collapsed",
    stats,
    toolHints,
    ...(toolRecords.length > 0 ? { toolRecords } : {}),
  });
  if (part.id === TURN_REASONING_PART_ID) block.dataset.turnReasoning = "1";
  container.append(block);
}

function appendPart(
  container: HTMLElement,
  part: MessagePartLike,
  ctx: MessageRenderContext,
): void {
  const type = part.type;
  if (type === "text" && typeof part.text === "string") {
    appendTextPart(container, part.text, part.annotations, ctx);
    return;
  }

  // Native response state contains opaque replay data, never presentation.
  if (type === "model_response") return;

  if (type === "hosted_tool" && typeof part.id === "string" && typeof part.name === "string") {
    container.append(createHostedToolCard({
      id: part.id,
      name: part.name,
      status: typeof part.status === "string" ? part.status : "incomplete",
      item: part.item,
      referenceContext: ctx,
    }));
    return;
  }

  if (type === "reasoning" && typeof part.text === "string") {
    appendReasoningPart(container, part);
    return;
  }

  if (type === "context_compaction" && typeof part.summary === "string") {
    container.append(createCompactionCard());
    return;
  }

  if (type === "context_clear") {
    container.append(createClearCard());
    return;
  }

  if (type === "tool_call" && typeof part.name === "string") {
    const id = typeof part.id === "string" ? part.id : "";
    // Deferred `tool_call` bridge: hydrate/replay as the inner tool so the
    // card shape (upload/sleep) and hidden-tool checks match direct calls.
    const partView = unwrapToolCallBridge(part.name, part.arguments);
    const partName = partView.name;
    const partArgs = partView.arguments;
    if (id) ctx.toolNamesByCallId.set(id, partName);
    const result = id ? ctx.toolResultsByCallId.get(id) : undefined;
    const pendingAsk = id ? ctx.pendingAsksByCallId.get(id) : undefined;

    // update/complete only refresh the plan card created by create_plan.
    if (partName === "update_plan" || partName === "complete_plan") {
      return;
    }

    if (!isConversationCardVisible(partName, partArgs)) return;

    if (partName === "create_plan") {
      const plan = id ? ctx.plansByCreateToolCallId.get(id) : undefined;
      if (plan) {
        container.append(createPlanCard(plan));
        return;
      }
      // A successful create_plan without an authoritative plan snapshot only
      // staged domain data for review. It has no transcript card.
      if (result?.returnCode === 0) return;
      // Fall through to a generic tool card while the plan snapshot is missing.
    }

    const status = typeof part.status === "string" ? part.status : "pending";
    const isDispatchSubagent = partName === "dispatch_subagent";
    const isStreamingWritePreview =
      (partName === "write_file" || partName === "patch") &&
      (typeof part.argumentsRaw === "string" ||
        (partArgs !== undefined && partArgs !== null));
    if (
      !result &&
      !pendingAsk &&
      (status === "pending" || status === "running") &&
      !isDispatchSubagent &&
      !isStreamingWritePreview &&
      !isShellToolName(partName) &&
      partName !== "upload_files" &&
      partName !== "generate_image"
    ) {
      return;
    }

    if (
      partName === "display_image" ||
      partName === "capture_app_window" ||
      partName === "generate_image"
    ) {
      try {
        container.append(
          createDisplayImageCard({
            arguments: partArgs,
            ...(result ? { result } : {}),
            revealLabel: ctx.revealLabel,
            onOpen: ctx.onOpenFile,
            onReveal: ctx.onRevealFile,
            ...(partName === "generate_image"
              ? {
                  title: "Generate Image",
                  onSave: ctx.onSaveFile,
                  saveLabel: "Save As",
                  // No result yet — render the in-flight generating placeholder.
                  ...(!result ? { pendingLabel: "Generating image…" } : {}),
                }
              : {}),
            ...(partName === "capture_app_window"
              ? {
                  startCollapsed: true,
                  title: "Capture App Window",
                }
              : {}),
          }),
        );
      } catch (err) {
        console.error(`[conversation] ${partName} image card failed`, err);
        const fallback = document.createElement("p");
        fallback.className = "md-paragraph";
        fallback.textContent = "Failed to render image.";
        container.append(fallback);
      }
      return;
    }

    if (partName === "display_pdf") {
      try {
        container.append(
          createDisplayPdfCard({
            arguments: partArgs,
            ...(result ? { result } : {}),
            revealLabel: ctx.revealLabel,
            onOpen: ctx.onOpenFile,
            onReveal: ctx.onRevealFile,
          }),
        );
      } catch (err) {
        console.error("[conversation] display_pdf card failed", err);
        const fallback = document.createElement("p");
        fallback.className = "md-paragraph";
        fallback.textContent = "Failed to render PDF.";
        container.append(fallback);
      }
      return;
    }

    const planProgress = id ? ctx.progressByToolCallId.get(id) : undefined;
    const liveSubagent = id ? ctx.subagentsByToolCallId.get(id) : undefined;
    container.append(
      createToolInvocationCard({
        id,
        name: partName,
        initiallyCollapsed: ctx.initiallyCollapsedToolCallIds?.has(id) ?? false,
        status: typeof part.status === "string" ? part.status : "pending",
        arguments: partArgs,
        argumentsRaw:
          typeof part.argumentsRaw === "string" ? part.argumentsRaw : "",
        ...(result ? { result } : {}),
        ...(pendingAsk ? { pendingAsk } : {}),
        ...(planProgress ? { planProgress } : {}),
        ...(liveSubagent ? { subagentStatus: liveSubagent.status } : {}),
        ...(liveSubagent && typeof liveSubagent.usedTokens === "number"
          ? { subagentUsedTokens: liveSubagent.usedTokens }
          : {}),
        subagentNamesById: ctx.subagentNamesById,
        ...(ctx.onUserAskAnswer
          ? { onUserAskAnswer: ctx.onUserAskAnswer }
          : {}),
        ...(ctx.onAbortToolCall
          ? { onAbortToolCall: ctx.onAbortToolCall }
          : {}),
        ...(id && ctx.demoSettledByCallId?.has(id)
          ? { demoSettled: ctx.demoSettledByCallId.get(id)! }
          : {}),
        ...(ctx.demoStates ? { demoStates: ctx.demoStates } : {}),
        ...(ctx.onSubmitDemoParams
          ? {
              onSubmitDemoParams: (
                values: Record<string, string | number | boolean | null>,
                note?: string,
              ) => ctx.onSubmitDemoParams?.(id, values, note),
            }
          : {}),
      }),
    );
    return;
  }

  // tool_result parts are folded into the invocation card via context.
  if (type === "tool_result") return;

  if (type === "attachment") {
    const chip: Parameters<typeof createAttachmentChip>[0] = {
      kind: typeof part.kind === "string" ? part.kind : "file",
      uri: typeof part.uri === "string" ? part.uri : "",
      mimeType: typeof part.mimeType === "string" ? part.mimeType : "",
    };
    if (typeof part.name === "string") chip.name = part.name;
    if (typeof part.sizeBytes === "number") chip.sizeBytes = part.sizeBytes;
    container.append(createAttachmentChip(chip));
  }
}

/** Small "Edited" marker for a user prompt rewritten mid-turn. */
function appendUserEditedTagIfPresent(
  body: HTMLElement,
  message: MessageLike,
): void {
  const edited = message.parts.some(
    (part) => part.type === "text" && part.edited === true,
  );
  if (!edited) return;
  const tag = document.createElement("span");
  tag.className = "user-prompt-edited";
  tag.textContent = "Edited";
  body.append(tag);
}

/** In-turn user inserts start a prompt segment, but share the original turn. */
function markTurnContinuation(row: HTMLElement, message: MessageLike): void {
  if (
    message.role === "user" &&
    message.parts.some(
      (part) => part.type === "text" && part.id === STEER_CONTINUATION_PART_ID,
    )
  ) {
    row.dataset.turnContinuation = "1";
  }
}

/** Turn error system message → tool-card-family error card row. */
function createTurnErrorRow(
  message: MessageLike,
  ctx: MessageRenderContext,
): HTMLElement | null {
  if (!isTurnErrorMessage(message)) return null;
  const row = document.createElement("article");
  row.className = "conversation-msg conversation-msg-system";
  row.dataset.turnError = "1";
  if (typeof message.id === "string" && message.id.length > 0) {
    row.dataset.messageId = message.id;
  }
  const text = message.parts
    .map((part) =>
      isTurnErrorTextPart(part) ? (part as { text: string }).text : "",
    )
    .filter((chunk) => chunk.length > 0)
    .join("\n");
  const retry =
    typeof message.id === "string"
      ? (ctx.turnErrorRetryByMessageId?.get(message.id) ?? null)
      : null;
  row.append(
    createTurnErrorCard({
      text,
      retry,
      ...(ctx.onRetryTurnError ? { onRetry: ctx.onRetryTurnError } : {}),
    }),
  );
  return row;
}

/**
 * D7 demo confirm marker on a user text part → compact summary card (plan
 * §4). The marker message never enters the markdown pipeline; unmatched
 * text renders normally (graceful degradation).
 */
function appendUserDemoConfirmPart(
  container: HTMLElement,
  part: MessagePartLike,
): boolean {
  if (part.type !== "text" || typeof part.text !== "string") return false;
  const parsed = parseDemoConfirmMessage(part.text);
  if (!parsed) return false;
  container.append(createDemoConfirmCard(parsed));
  return true;
}

/** Hidden retry-continuation user message — no row (model-facing only). */
function isRetryContinuationMessage(message: MessageLike): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) => part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
    )
  );
}

/** Presentation-only message row (sync; Mermaid text stays as a status hint). */
export function createMessageView(
  message: MessageLike,
  ctx: MessageRenderContext,
): HTMLElement | null {
  // Tool messages are merged into the assistant tool_call cards.
  if (message.role === "tool") return null;
  const errorRow = createTurnErrorRow(message, ctx);
  if (errorRow) return errorRow;
  if (isRetryContinuationMessage(message)) return null;

  const row = document.createElement("article");
  row.className = `conversation-msg conversation-msg-${message.role}`;
  markTurnContinuation(row, message);
  if (
    message.parts.some(
      (p) => p.type === "context_compaction" || p.type === "context_clear",
    )
  ) {
    row.classList.add("conversation-msg-compaction");
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    row.dataset.messageId = message.id;
  }

  const body = document.createElement("div");
  body.className = "conversation-msg-body";

  const partContext = { ...ctx, ...(message.id ? { messageId: message.id } : {}) };

  const visibleParts = message.parts.filter((p) => p.type !== "tool_result" && p.type !== "model_response");
  if (visibleParts.length === 0 && body.childElementCount === 0) {
    return null;
  } else {
    for (const part of visibleParts) {
      if (message.role === "user" && appendUserDemoConfirmPart(body, part)) {
        continue;
      }
      appendPart(body, part, partContext);
    }
  }

  // Drop empty assistant rows that only contained skipped parts.
  if (body.childElementCount === 0) return null;

  if (message.role === "user") {
    if (body.querySelector(".content-card-demo-confirm")) {
      row.classList.add("is-demo-confirm");
    }
    appendUserEditedTagIfPresent(body, message);
    applyUserPromptClamp(body);
  }

  row.append(body);
  return row;
}

/**
 * Like {@link createMessageView}, but awaits Mermaid SVG cards serially before
 * returning so the conversation can wait on diagram completion.
 */
export async function createMessageViewAsync(
  message: MessageLike,
  ctx: MessageRenderContext,
): Promise<HTMLElement | null> {
  if (message.role === "tool") return null;
  const errorRow = createTurnErrorRow(message, ctx);
  if (errorRow) return errorRow;
  if (isRetryContinuationMessage(message)) return null;

  const row = document.createElement("article");
  row.className = `conversation-msg conversation-msg-${message.role}`;
  markTurnContinuation(row, message);
  if (
    message.parts.some(
      (p) => p.type === "context_compaction" || p.type === "context_clear",
    )
  ) {
    row.classList.add("conversation-msg-compaction");
  }
  if (typeof message.id === "string" && message.id.length > 0) {
    row.dataset.messageId = message.id;
  }

  const body = document.createElement("div");
  body.className = "conversation-msg-body";

  const partContext = { ...ctx, ...(message.id ? { messageId: message.id } : {}) };

  const visibleParts = message.parts.filter((p) => p.type !== "tool_result" && p.type !== "model_response");
  if (visibleParts.length === 0) {
    return null;
  }
  for (const part of visibleParts) {
    if (message.role === "user" && appendUserDemoConfirmPart(body, part)) {
      continue;
    }
    await appendPartAsync(body, part, partContext);
  }

  if (body.childElementCount === 0) return null;

  if (message.role === "user") {
    if (body.querySelector(".content-card-demo-confirm")) {
      row.classList.add("is-demo-confirm");
    }
    appendUserEditedTagIfPresent(body, message);
    applyUserPromptClamp(body);
  }

  row.append(body);
  return row;
}
