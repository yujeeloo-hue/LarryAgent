import { ToolReturnCode } from "../session/returnCodes.js";
import type {
  Message,
  Session,
  ToolCallPart,
  ToolMessage,
  ToolResultContentPart,
} from "../session/types.js";
import { getTool } from "../tools/registry.js";
import { resolveToolExecutionSummary } from "../tools/executionSummary.js";

function answeredToolCallIds(messages: Message[], assistantIndex: number): Set<string> {
  const answered = new Set<string>();
  for (let i = assistantIndex + 1; i < messages.length; i += 1) {
    const message = messages[i]!;
    if (message.role === "assistant") break;
    if (message.role === "tool" && message.toolCallId) {
      answered.add(message.toolCallId);
    }
    for (const part of message.parts) {
      if (part.type === "tool_result") {
        answered.add(part.toolCallId);
      }
    }
  }
  return answered;
}

function interruptedToolMessage(
  createId: () => string,
  call: ToolCallPart,
  note: string,
): ToolMessage {
  const uncertain = call.status === "running" || call.status === "done" || call.status === "error";
  const content: ToolResultContentPart[] = [{ type: "text", text: uncertain
    ? "Execution outcome is unknown after interruption. This action may have completed; it was not automatically retried. Verify its external result before repeating it."
    : note }];
  const returnCode = uncertain ? ToolReturnCode.GenericFailure : ToolReturnCode.Cancelled;
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

/**
 * Ensure every `tool_call` in `calls` has a following tool_result in the
 * session transcript. Pending calls get a Cancelled result; started calls
 * without a result are marked outcome-unknown and are never retried here.
 * Results are inserted into the owning assistant's tool block.
 */
export function sealToolCallsWithCancelledResults(
  session: Session,
  createId: () => string,
  calls: ToolCallPart[],
  note = "Cancelled",
  assistantMessageId?: string,
): ToolCallPart[] {
  const sealed: ToolCallPart[] = [];
  for (const call of calls) {
    const owner = session.messages.findIndex((message) => message.role === "assistant" &&
      (assistantMessageId ? message.id === assistantMessageId : message.parts.includes(call)));
    if (owner < 0) continue;
    const answered = answeredToolCallIds(session.messages, owner);
    if (answered.has(call.id)) continue;
    const recorded = session.messages[owner]!.parts.find(
      (part): part is ToolCallPart => part.type === "tool_call" && part.id === call.id,
    );
    const toolMessage = interruptedToolMessage(createId, recorded ?? call, note);
    call.status = toolMessage.parts.some((part) => part.type === "tool_result" &&
      part.returnCode === ToolReturnCode.GenericFailure) ? "error" : "cancelled";
    for (const part of session.messages[owner]!.parts) {
      if (part.type === "tool_call" && part.id === call.id) part.status = call.status;
    }
    let insertAt = owner + 1;
    while (session.messages[insertAt]?.role === "tool") insertAt += 1;
    session.messages.splice(insertAt, 0, toolMessage);
    answered.add(call.id);
    sealed.push(call);
  }
  if (sealed.length > 0) {
    session.updatedAt = Date.now();
  }
  return sealed;
}

/**
 * Repair historical orphans: assistant tool_calls with no tool_result
 * (e.g. cancel mid-tool). Inserts a cancelled or outcome-unknown result into
 * the owning assistant's tool block, preserving resumable pending ask siblings.
 */
export function sealOrphanToolCallsInSession(
  session: Session,
  createId: () => string,
  options?: { resumeToolBatch?: { assistantMessageId: string; toolCallIds: readonly string[] } },
): number {
  let sealed = 0;

  for (let i = 0; i < session.messages.length; i += 1) {
    const message = session.messages[i]!;
    if (message.role !== "assistant") continue;
    const answered = answeredToolCallIds(session.messages, i);
    const pendingAsk = session.pendingUserAsk;
    const resumableIds = new Set<string>();
    if (pendingAsk?.assistantMessageId === message.id) {
      resumableIds.add(pendingAsk.toolCallId);
      for (const id of pendingAsk.remainingToolCallIds) resumableIds.add(id);
    }
    if (options?.resumeToolBatch?.assistantMessageId === message.id) {
      for (const id of options.resumeToolBatch.toolCallIds) resumableIds.add(id);
    }

    const orphans: ToolCallPart[] = [];
    for (const part of message.parts) {
      if (part.type !== "tool_call") continue;
      if (answered.has(part.id)) continue;
      if (pendingAsk?.assistantMessageId === message.id && part.id === pendingAsk.toolCallId) continue;
      if (part.status === "pending" && resumableIds.has(part.id)) continue;
      orphans.push(part);
    }
    if (orphans.length === 0) continue;

    let insertAt = i + 1;
    while (
      insertAt < session.messages.length &&
      session.messages[insertAt]!.role === "tool"
    ) {
      insertAt += 1;
    }

    for (const call of orphans) {
      if (answered.has(call.id)) continue;
      const toolMessage = interruptedToolMessage(createId, call, "Cancelled — not executed");
      call.status = toolMessage.parts.some((part) => part.type === "tool_result" &&
        part.returnCode === ToolReturnCode.GenericFailure) ? "error" : "cancelled";
      for (const part of message.parts) {
        if (part.type === "tool_call" && part.id === call.id) part.status = call.status;
      }
      session.messages.splice(insertAt, 0, toolMessage);
      answered.add(call.id);
      insertAt += 1;
      sealed += 1;
    }
    // Skip over the tool block we just extended so we don't re-scan inserts.
    i = insertAt - 1;
  }

  if (sealed > 0) {
    session.updatedAt = Date.now();
  }
  return sealed;
}
