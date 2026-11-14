import type { DemoSettled } from "../../../../session/demoCardState.js";
import { buildPlansByCreateToolCallId } from "./planSnapshots.js";
import { parseDemoConfirmMessage } from "../../../../session/demoConfirm.js";
import { buildSubagentNamesById } from "./subagentDisplay.js";
import { splitMessagesIntoTurns } from "./turnModifiedFiles.js";
import {
  turnErrorRetryPayloadsByMessageId,
  type RetryOutcome,
  type TurnErrorRetryPayload,
} from "./cards/TurnErrorCardView.js";
import type { MessageRenderContext } from "./message/MessageView.js";
import type { PendingUserAsk } from "./ConversationView.js";
import type { SubagentCardSnapshot } from "./cards/SubagentCardView.js";
import { isVirtualizedToolName, MAX_EXPANDED_TOOL_CARDS } from "./cards/virtualToolCard.js";
import { unwrapToolCallBridge } from "./cards/toolInvocationHelpers.js";
import { isConversationCardVisible } from "./turnDisplay.js";

type MessageLike = {
  role: string;
  parts: Array<Record<string, unknown>>;
};

export function buildMessageRenderContext(
  messages: MessageLike[],
  options: {
    sessionId?: string;
    revealLabel: string;
    onOpenFile: (path: string) => void;
    onRevealFile: (path: string) => void;
    onSaveFile?: (path: string) => void;
    pendingAsks?: PendingUserAsk[];
    plan?: unknown;
    subagentsByToolCallId?: Map<string, SubagentCardSnapshot>;
    onUserAskAnswer?: MessageRenderContext["onUserAskAnswer"];
    onAbortToolCall?: MessageRenderContext["onAbortToolCall"];
    onRetryTurnError?: (payload: TurnErrorRetryPayload) => RetryOutcome;
    /** Currently queued prompt texts (present_demo settled scan). */
    queuedPrompts?: string[];
    demoStates?: MessageRenderContext["demoStates"];
    onSubmitDemoParams?: MessageRenderContext["onSubmitDemoParams"];
  },
): MessageRenderContext {
  const toolNamesByCallId = new Map<string, string>();
  const codeToolCallIds = new Set<string>();
  const toolResultsByCallId = new Map<
    string,
    {
      returnCode: number;
      content: Array<Record<string, unknown>>;
      executionSummary?: string;
    }
  >();

  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "tool_call" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        toolNamesByCallId.set(part.id, part.name);
        const tool = unwrapToolCallBridge(part.name, part.arguments);
        if (isVirtualizedToolName(tool.name) &&
            isConversationCardVisible(tool.name, tool.arguments)) {
          codeToolCallIds.add(part.id);
        }
      }
      if (part.type === "tool_result" && typeof part.toolCallId === "string") {
        toolResultsByCallId.set(part.toolCallId, {
          returnCode:
            typeof part.returnCode === "number" ? part.returnCode : 1,
          content: Array.isArray(part.content)
            ? (part.content as Array<Record<string, unknown>>)
            : [],
          ...(typeof part.executionSummary === "string" &&
          part.executionSummary.trim().length > 0
            ? { executionSummary: part.executionSummary.trim() }
            : {}),
        });
      }
    }
  }

  const planRebuild = buildPlansByCreateToolCallId(messages, options.plan);

  // Retry payloads for error cards: each turn group's user prompt, keyed by
  // the error message id inside that turn (same grouping the rows render in).
  const turnErrorRetryByMessageId = new Map<string, TurnErrorRetryPayload>();
  for (const turn of splitMessagesIntoTurns(messages)) {
    for (const [id, payload] of turnErrorRetryPayloadsByMessageId(turn)) {
      turnErrorRetryByMessageId.set(id, payload);
    }
  }

  // present_demo settled scan (plan §3): a demo card whose confirm message
  // is already in the transcript or the prompt queue renders settled. The
  // newest unsettled demo card stays expanded; older/settled ones start
  // collapsed (mount strategy — the preview iframe only mounts when opened).
  const demoToolCallIds: string[] = [];
  const demoSettledByCallId = new Map<string, DemoSettled>();
  const scanDemoConfirmText = (text: string, enqueued = false): void => {
    const parsed = parseDemoConfirmMessage(text);
    if (parsed) {
      demoSettledByCallId.set(parsed.toolCallId, {
        paramsJson: parsed.paramsJson,
        ...(parsed.note ? { note: parsed.note } : {}),
        ...(enqueued ? { enqueued: true } : {}),
      });
    }
  };
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "tool_call" &&
        typeof part.id === "string" &&
 part.name === "present_demo"
      ) {
        demoToolCallIds.push(part.id);
      }
    }
    if (message.role === "user") {
      for (const part of message.parts) {
        if (part.type === "text" && typeof part.text === "string") {
          scanDemoConfirmText(part.text);
        }
      }
    }
  }
  for (const queued of options.queuedPrompts ?? []) {
    scanDemoConfirmText(queued, true);
  }
  let lastUnsettledDemoIndex = -1;
  for (let i = 0; i < demoToolCallIds.length; i += 1) {
    if (!demoSettledByCallId.has(demoToolCallIds[i]!)) {
      lastUnsettledDemoIndex = i;
    }
  }
  const collapsedDemoIds = demoToolCallIds.filter(
    (id, index) => index !== lastUnsettledDemoIndex,
  );

  return {
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    toolNamesByCallId,
    // Decide before creating cards: older history never builds/highlights a body.
    initiallyCollapsedToolCallIds: new Set([
      ...[...codeToolCallIds].slice(0, -MAX_EXPANDED_TOOL_CARDS),
      ...collapsedDemoIds,
    ]),
    toolResultsByCallId,
    plansByCreateToolCallId: planRebuild.plansByCreateToolCallId,
    progressByToolCallId: planRebuild.progressByToolCallId,
    subagentsByToolCallId: options.subagentsByToolCallId ?? new Map(),
    subagentNamesById: buildSubagentNamesById(messages),
    pendingAsksByCallId: new Map(
      (options.pendingAsks ?? []).map((ask) => [
        ask.toolCallId,
        {
          requestId: ask.requestId,
          question: ask.question,
          options: ask.options,
          ...(ask.optionDetails ? { optionDetails: ask.optionDetails } : {}),
          allowCustom: ask.allowCustom,
          allowMultiple: ask.allowMultiple,
        },
      ]),
    ),
    ...(options.onUserAskAnswer
      ? { onUserAskAnswer: options.onUserAskAnswer }
      : {}),
    ...(options.onAbortToolCall
      ? { onAbortToolCall: options.onAbortToolCall }
      : {}),
    demoSettledByCallId,
    ...(options.demoStates ? { demoStates: options.demoStates } : {}),
    ...(options.onSubmitDemoParams
      ? { onSubmitDemoParams: options.onSubmitDemoParams }
      : {}),
    turnErrorRetryByMessageId,
    ...(options.onRetryTurnError
      ? { onRetryTurnError: options.onRetryTurnError }
      : {}),
    revealLabel: options.revealLabel,
    onOpenFile: options.onOpenFile,
    onRevealFile: options.onRevealFile,
    ...(options.onSaveFile ? { onSaveFile: options.onSaveFile } : {}),
  };
}
