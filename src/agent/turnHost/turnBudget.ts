import type { StreamEvent } from "../../llm/streamEvents.js";
import {
  agentLogError,
  agentLogInfo,
  agentLogWarn,
} from "../../logging/agentLog.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { HEADLESS_ASK_CANCELLED_TEXT } from "../../session/headlessAsk.js";
import type {
  AssistantMessage,
  Session,
  ToolCallPart,
  ToolMessage,
} from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import { toolAskProgressText } from "../../tools/displayMeta.js";
import { emit } from "./emit.js";
import { touch } from "./touch.js";

export type TurnLimitKind = "tokens" | "iterations";

export function turnLimitQuestion(
  kind: TurnLimitKind,
  detail: {
    maxTurnTokens: number;
    turnBillableTokens: number;
    maxModelIterations: number;
    modelIterations: number;
  },
): string {
  if (kind === "tokens") {
    return (
      `This turn reached the token budget ` +
      `(${detail.turnBillableTokens.toLocaleString()} / ${detail.maxTurnTokens.toLocaleString()} billable tokens). ` +
      `Continue with another budget, or stop here?`
    );
  }
  return (
    `This turn reached the model-iteration limit ` +
    `(${detail.modelIterations} / ${detail.maxModelIterations}). ` +
    `Continue with another ${detail.maxModelIterations} iterations, or stop here?`
  );
}

/**
 * Synthetic ask_user Continue / Stop when a turn hard limit is hit.
 * Returns continue | stop | unavailable (no gate / abort).
 */
export async function promptTurnLimitContinue(input: {
  session: Session;
  gate: PermissionGateState;
  createId: () => string;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
  kind: TurnLimitKind;
  question: string;
}): Promise<"continue" | "stop" | "unavailable"> {
  const { session, gate, createId, onEvent, signal, kind, question } = input;
  if (!gate.requestUserAsk) {
    return "unavailable";
  }
  if (signal?.aborted) {
    return "stop";
  }

  const toolCallId = createId();
  const args = {
    question,
    options: ["Continue", "Stop"],
    allow_custom: false,
  };
  const argumentsRaw = JSON.stringify(args);
  const toolCall: ToolCallPart = {
    type: "tool_call",
    id: toolCallId,
    name: "ask_user",
    status: "running",
    arguments: args,
    argumentsRaw,
  };
  const assistant: AssistantMessage = {
    id: createId(),
    role: "assistant",
    createdAt: Date.now(),
    parts: [toolCall],
  };
  session.messages.push(assistant);
  touch(session, toolAskProgressText("ask_user"));
  emit(onEvent, { type: "status", status: "tool_running" });
  emit(onEvent, {
    type: "tool_call",
    id: toolCallId,
    name: "ask_user",
    arguments: args,
    argumentsRaw,
    messageId: assistant.id,
  });
  emit(onEvent, { type: "progress", text: toolAskProgressText("ask_user") });

  agentLogInfo("turn.limit_ask", {
    sessionId: session.id,
    kind,
    toolCallId,
  });

  let answer: Awaited<ReturnType<NonNullable<typeof gate.requestUserAsk>>> =
    null;
  try {
    answer = await gate.requestUserAsk({
      toolCallId,
      question,
      options: ["Continue", "Stop"],
      allowCustom: false,
    });
  } catch {
    answer = null;
  }

  const selected = answer?.selected?.trim() ?? "";
  const continued =
    selected.toLowerCase() === "continue" || selected === "Continue";
  const returnCode = answer
    ? ToolReturnCode.Success
    : ToolReturnCode.Cancelled;
  const resultText = answer
    ? continued
      ? "Selected: Continue"
      : `Selected: ${selected || "Stop"}`
    : gate.headless === true
      ? HEADLESS_ASK_CANCELLED_TEXT
      : "Cancelled";

  toolCall.status = answer ? "done" : "cancelled";
  const toolMessage: ToolMessage = {
    id: createId(),
    role: "tool",
    toolCallId,
    createdAt: Date.now(),
    parts: [
      {
        type: "tool_result",
        toolCallId,
        content: [{ type: "text", text: resultText }],
        returnCode,
      },
    ],
  };
  session.messages.push(toolMessage);
  touch(session);
  emit(onEvent, {
    type: "tool_finished",
    id: toolCallId,
    name: "ask_user",
    messageId: assistant.id,
  });

  if (!answer || signal?.aborted) {
    agentLogWarn("turn.limit_stop", {
      sessionId: session.id,
      kind,
      reason: signal?.aborted ? "aborted" : "no_answer",
    });
    return "stop";
  }
  if (continued) {
    agentLogInfo("turn.limit_continue", { sessionId: session.id, kind });
    return "continue";
  }
  agentLogWarn("turn.limit_stop", {
    sessionId: session.id,
    kind,
    selected,
  });
  return "stop";
}

export async function handleTurnLimit(input: {
  kind: TurnLimitKind;
  session: Session;
  gate: PermissionGateState;
  createId: () => string;
  onEvent?: (event: StreamEvent) => void;
  signal?: AbortSignal;
  isSubagentTurn: boolean;
  maxTurnTokens: number;
  turnBillableTokens: number;
  maxModelIterations: number;
  modelIterations: number;
  resetIterations: () => void;
  resetTokens: () => void;
  finish: (
    status: "idle" | "error" | "cancelled",
    progressText: string,
    doneReason: "completed" | "cancelled" | "paused" | "error",
  ) => Promise<{ status: string; modelIterations: number }>;
}): Promise<"resume" | Awaited<ReturnType<typeof input.finish>>> {
  const question = turnLimitQuestion(input.kind, {
    maxTurnTokens: input.maxTurnTokens,
    turnBillableTokens: input.turnBillableTokens,
    maxModelIterations: input.maxModelIterations,
    modelIterations: input.modelIterations,
  });
  if (input.isSubagentTurn) {
    emit(input.onEvent, { type: "error", message: question });
    agentLogError("turn.limit_subagent", {
      sessionId: input.session.id,
      kind: input.kind,
      turnBillableTokens: input.turnBillableTokens,
      modelIterations: input.modelIterations,
      maxModelIterations: input.maxModelIterations,
      maxTurnTokens: input.maxTurnTokens,
    });
    return input.finish("error", question, "error");
  }
  const decision = await promptTurnLimitContinue({
    session: input.session,
    gate: input.gate,
    createId: input.createId,
    ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    kind: input.kind,
    question,
  });
  if (decision === "continue") {
    if (input.kind === "iterations") {
      input.resetIterations();
    } else {
      input.resetTokens();
    }
    const note =
      input.kind === "iterations"
        ? `Continuing after model-iteration limit (+${input.maxModelIterations} iterations).`
        : `Continuing after token budget (+${input.maxTurnTokens.toLocaleString()} billable tokens).`;
    input.session.messages.push({
      id: input.createId(),
      role: "system",
      createdAt: Date.now(),
      parts: [{ type: "text", text: note }],
    });
    touch(input.session, "Continuing…");
    emit(input.onEvent, { type: "status", status: "running" });
    emit(input.onEvent, { type: "progress", text: "Continuing…" });
    agentLogInfo("turn.limit_continue_resume", {
      sessionId: input.session.id,
      kind: input.kind,
      maxModelIterations: input.maxModelIterations,
      maxTurnTokens: input.maxTurnTokens,
    });
    return "resume";
  }
  if (decision === "unavailable") {
    emit(input.onEvent, { type: "error", message: question });
    return input.finish("error", question, "error");
  }
  return input.finish("cancelled", "Stopped at turn limit", "cancelled");
}
