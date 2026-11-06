import { formatAskAnswerText, normalizeAskOptions } from "../shared/askUser.js";
import { ToolReturnCode } from "./returnCodes.js";
import type {
  AssistantMessage,
  Session,
  ToolCallPart,
  ToolMessage,
  ToolResultContentPart,
} from "./types.js";
import type { UserAskAnswer } from "../tools/types.js";
import { getTool } from "../tools/registry.js";
import { resolveToolExecutionSummary } from "../tools/executionSummary.js";
import type { ComposerRunMode } from "../agent/ipcTypes.js";
import { isReasoningEffort, type ReasoningEffort } from "../llm/reasoningEffort.js";

/** Persisted ask_user pause — survives turn idle and app restart. */
export type SessionPendingUserAsk = {
  requestId: string;
  toolCallId: string;
  question: string;
  /** Empty array = open-ended ask (free-form input only). */
  options: string[];
  optionDetails?: import("../shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
  assistantMessageId: string;
  /** Same-batch tool calls not yet executed when the turn paused. */
  remainingToolCallIds: string[];
  runMode: ComposerRunMode;
  fullPermissions: boolean;
  autoSkillSummarize: boolean;
  reasoningEffort?: ReasoningEffort;
  createdAt: number;
};

export { formatAskAnswerText } from "../shared/askUser.js";

export function parseSessionPendingUserAsk(
  raw: string | null | undefined,
): SessionPendingUserAsk | null {
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const requestId =
      typeof parsed.requestId === "string" ? parsed.requestId.trim() : "";
    const toolCallId =
      typeof parsed.toolCallId === "string" ? parsed.toolCallId.trim() : "";
    const question =
      typeof parsed.question === "string" ? parsed.question.trim() : "";
    if (!requestId || !toolCallId || !question) return null;
    const options = Array.isArray(parsed.options)
      ? parsed.options
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim())
          .filter((item) => item.length > 0)
      : [];
    const assistantMessageId =
      typeof parsed.assistantMessageId === "string"
        ? parsed.assistantMessageId.trim()
        : "";
    if (!assistantMessageId) return null;
    const remainingToolCallIds = Array.isArray(parsed.remainingToolCallIds)
      ? parsed.remainingToolCallIds.filter(
          (item): item is string =>
            typeof item === "string" && item.trim().length > 0,
        )
      : [];
    const runMode = parsed.runMode;
    const validRunMode =
      runMode === "agent" ||
      runMode === "ask" ||
      runMode === "plan" ||
      runMode === "custom"
        ? runMode
        : "agent";
    return {
      requestId,
      toolCallId,
      question,
      options,
      ...(Array.isArray(parsed.optionDetails) ? { optionDetails: normalizeAskOptions(parsed.optionDetails).filter(option => options.includes(option.label)) } : {}),
      allowCustom:
        typeof parsed.allowCustom === "boolean" ? parsed.allowCustom : true,
      allowMultiple:
        typeof parsed.allowMultiple === "boolean"
          ? parsed.allowMultiple
          : false,
      assistantMessageId,
      remainingToolCallIds,
      runMode: validRunMode,
      fullPermissions: parsed.fullPermissions === true,
      autoSkillSummarize: parsed.autoSkillSummarize === true,
      ...(isReasoningEffort(parsed.reasoningEffort)
        ? { reasoningEffort: parsed.reasoningEffort }
        : {}),
      createdAt:
        typeof parsed.createdAt === "number" ? parsed.createdAt : Date.now(),
    };
  } catch {
    return null;
  }
}

function findToolCall(
  session: Session,
  pending: SessionPendingUserAsk,
): { call: ToolCallPart; assistantIndex: number; answered: boolean } | null {
  const assistantIndex = session.messages.findIndex(
    (message) => message.role === "assistant" && message.id === pending.assistantMessageId,
  );
  if (assistantIndex < 0) return null;
  const call = session.messages[assistantIndex]!.parts.find(
    (part): part is ToolCallPart => part.type === "tool_call" && part.id === pending.toolCallId,
  );
  if (!call) return null;
  for (let i = assistantIndex + 1; i < session.messages.length; i += 1) {
    const message = session.messages[i]!;
    if (message.role === "assistant") break;
    if (message.role === "tool" && message.toolCallId === call.id) {
      return { call, assistantIndex, answered: true };
    }
  }
  return { call, assistantIndex, answered: false };
}

function insertAskResult(session: Session, assistantIndex: number, result: ToolMessage): void {
  let index = assistantIndex + 1;
  while (session.messages[index]?.role === "tool") index += 1;
  session.messages.splice(index, 0, result);
}

function toolMessageFromAsk(
  createId: () => string,
  call: ToolCallPart,
  content: ToolResultContentPart[],
  returnCode: number,
): ToolMessage {
  const tool = getTool(call.name);
  const executionSummary = resolveToolExecutionSummary(tool, call.name, {
    args:
      call.arguments &&
      typeof call.arguments === "object" &&
      !Array.isArray(call.arguments)
        ? call.arguments
        : {},
    returnCode,
    content,
  });
  return {
    id: createId(),
    role: "tool",
    toolCallId: call.id,
    createdAt: Date.now(),
    parts: [
      {
        type: "tool_result",
        toolCallId: call.id,
        content,
        returnCode,
        ...(executionSummary ? { executionSummary } : {}),
      },
    ],
  };
}

export function appendAskUserToolResult(
  session: Session,
  pending: SessionPendingUserAsk,
  answer: UserAskAnswer,
  createId: () => string,
): boolean {
  const owner = findToolCall(session, pending);
  if (!owner) return false;
  if (owner.answered) return true;
  const { call, assistantIndex } = owner;
  const text = formatAskAnswerText(answer, pending.options.length === 0);
  call.status = "done";
  insertAskResult(session, assistantIndex,
    toolMessageFromAsk(
      createId,
      call,
      [{ type: "text", text }],
      ToolReturnCode.Success,
    ),
  );
  session.updatedAt = Date.now();
  return true;
}

export function cancelAskUserToolCall(
  session: Session,
  pending: SessionPendingUserAsk,
  createId: () => string,
): boolean {
  const owner = findToolCall(session, pending);
  if (!owner) return false;
  if (owner.answered) return true;
  const { call, assistantIndex } = owner;
  call.status = "cancelled";
  insertAskResult(session, assistantIndex,
    toolMessageFromAsk(
      createId,
      call,
      [{ type: "text", text: "User did not answer (cancelled)." }],
      ToolReturnCode.Cancelled,
    ),
  );
  session.updatedAt = Date.now();
  return true;
}

export function findAssistantMessage(
  session: Session,
  messageId: string,
): AssistantMessage | null {
  for (const message of session.messages) {
    if (message.role === "assistant" && message.id === messageId) {
      return message;
    }
  }
  return null;
}

export function toolCallsByIds(
  assistant: AssistantMessage,
  ids: readonly string[],
): ToolCallPart[] {
  const wanted = new Set(ids);
  const out: ToolCallPart[] = [];
  for (const part of assistant.parts) {
    if (part.type !== "tool_call") continue;
    if (wanted.has(part.id)) out.push(part);
  }
  return out;
}

