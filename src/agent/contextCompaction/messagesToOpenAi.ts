import type {
  OpenAiChatMessage,
  OpenAiContentPart,
} from "../../llm/types.js";
import { categorizeContextMessage } from "../contextMessageCategory.js";
import type {
  JsonObject,
  Message,
  MessagePart,
  ModelResponsePart,
  ToolResultContentPart,
  ToolCallPart,
  ToolResultPart,
} from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  FILE_CONTENT_WIRE_STUB_TOOLS,
  stubFileContentArgsForWire,
  stubPatchArgsForWire,
} from "../../tools/fileWriteLimits.js";
import { parseToolArgumentsRaw } from "../../tools/validateToolArguments.js";
import { isVisionImageRef } from "../../tools/fileMeta.js";
import { isShellToolName } from "../../tools/shellToolName.js";
import {
  formatAttachmentImagePathHint,
  formatAttachmentWireStub,
} from "../attachmentWireText.js";
import { formatTurnContextForWire } from "../turnContextWire.js";

export const AGED_TOOL_RESULT_MAX_CHARS = 200;
export const AGED_TOOL_RESULT_STUB =
  "[Old tool output cleared to save context space]";
export const REASONING_ONLY_ASSISTANT_CONTENT =
  "[Assistant response ended before producing a final answer]";

export type MessagesToOpenAiOptions = {
  reasoningScope?: string;
  stubWriteArgs?: boolean;
  ageToolResults?: boolean;
  imageUrls?: boolean;
  toolRoleImages?: boolean;
};

function stubWriteArgsIfNeeded(
  name: string,
  args: JsonObject,
): JsonObject | null {
  if (!FILE_CONTENT_WIRE_STUB_TOOLS.has(name)) return null;
  if (name === "patch") {
    if (typeof args.patch === "string" || typeof args.patch_text === "string") {
      return stubPatchArgsForWire(args) as JsonObject;
    }
    return null;
  }
  const content = args.content;
  if (typeof content !== "string") return null;
  return stubFileContentArgsForWire({
    path: args.path,
    content,
  }) as JsonObject;
}

function textFromParts(parts: MessagePart[]): string {
  const context: string[] = [];
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      if (part.id === "file_body" || part.id === "file_diff") continue;
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(formatAttachmentWireStub(part));
    } else if (part.type === "hosted_tool") {
      chunks.push(`[Hosted ${part.name}: ${part.status}]`);
    } else if (part.type === "turn_context" && part.text.trim()) {
      context.push(formatTurnContextForWire(part));
    }
  }
  return [context.join("\n\n"), chunks.join("\n")]
    .filter((block) => block.length > 0)
    .join("\n\n");
}

function multimodalContentFromParts(
  parts: MessagePart[],
): OpenAiContentPart[] | null {
  const s3Images = parts.filter(
    (p): p is Extract<MessagePart, { type: "attachment" }> =>
      p.type === "attachment" &&
      p.kind === "image" &&
      !!p.s3?.url?.trim() &&
      isVisionImageRef(p.uri, p.mimeType),
  );
  if (s3Images.length === 0) return null;
  const s3Set = new Set<MessagePart>(s3Images);
  const textParts = parts.filter((p) => !s3Set.has(p));
  const text = textFromParts(textParts);
  const imageHints = s3Images.map((p) => formatAttachmentImagePathHint(p));
  const body: OpenAiContentPart[] = [];
  const textBody = [text, ...imageHints].filter(Boolean).join("\n");
  if (textBody.length > 0) {
    body.push({ type: "text", text: textBody });
  }
  for (const part of s3Images) {
    body.push({
      type: "image_url",
      image_url: { url: part.s3!.url!.trim() },
    });
  }
  return body;
}

function reasoningFromParts(parts: MessagePart[], scope?: string): string {
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "reasoning" && part.text.length > 0 &&
        (scope === undefined || part.providerScope === scope)) {
      chunks.push(part.text);
    }
  }
  return chunks.join("");
}

function toolResultText(
  part: ToolResultPart,
  ageToolResults: boolean,
  toolName?: string,
): string {
  const body = textFromParts(part.content);
  const raw = body.length > 0 ? body : `returnCode=${part.returnCode}`;
  if (toolName === "patch" || toolName === "edit_file") return raw;
  if (ageToolResults && raw.length > AGED_TOOL_RESULT_MAX_CHARS) {
    return AGED_TOOL_RESULT_STUB;
  }
  return raw;
}

function toolArgumentsForWire(
  tc: ToolCallPart,
  stubWriteArgs: boolean,
): string {
  const parsed = parseToolArgumentsRaw(tc.argumentsRaw);
  if (parsed.ok) {
    if (stubWriteArgs) {
      const stubbed = stubWriteArgsIfNeeded(tc.name, parsed.value);
      if (stubbed) {
        return JSON.stringify(stubbed);
      }
    }
    const trimmed = tc.argumentsRaw.trim();
    return trimmed.length > 0 ? trimmed : "{}";
  }
  if (tc.arguments && typeof tc.arguments === "object") {
    if (stubWriteArgs) {
      const stubbed = stubWriteArgsIfNeeded(
        tc.name,
        tc.arguments as JsonObject,
      );
      if (stubbed) return JSON.stringify(stubbed);
    }
    try {
      return JSON.stringify(tc.arguments);
    } catch {
      return "{}";
    }
  }
  return "{}";
}

function toolCallsFromParts(
  parts: MessagePart[],
  stubWriteArgs: boolean,
): OpenAiChatMessage["tool_calls"] {
  const calls: NonNullable<OpenAiChatMessage["tool_calls"]> = [];
  for (const part of parts) {
    if (part.type !== "tool_call") continue;
    const tc = part as ToolCallPart;
    calls.push({
      id: tc.id,
      type: "function",
      function: {
        name: tc.name,
        arguments: toolArgumentsForWire(tc, stubWriteArgs),
      },
    });
  }
  return calls.length > 0 ? calls : undefined;
}

export function isCompactionMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_compaction")
  );
}

export function isClearMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_clear")
  );
}

export function isNewTaskMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_new_task")
  );
}

export function findLatestModelWindowFloor(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!;
    if (isClearMessage(message) || isNewTaskMessage(message)) return i;
  }
  return -1;
}

export function messagesAfterModelWindowFloor(messages: Message[]): Message[] {
  const floor = findLatestModelWindowFloor(messages);
  return floor >= 0 ? messages.slice(floor + 1) : messages;
}

export function findLatestClearIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isClearMessage(messages[i]!)) return i;
  }
  return -1;
}

export function messagesToOpenAi(
  messages: Message[],
  options?: MessagesToOpenAiOptions,
): OpenAiChatMessage[] {
  const stubWriteArgs = options?.stubWriteArgs === true;
  const ageToolResults = options?.ageToolResults === true;
  const out: OpenAiChatMessage[] = [];
  const toolNameByCallId = new Map<string, string>();
  const localShellCalls = new Map<string, ToolCallPart>();

  for (const message of messages) {
    if (
      isCompactionMessage(message) ||
      isClearMessage(message) ||
      isNewTaskMessage(message)
    ) {
      continue;
    }

    if (message.role === "system" || message.role === "user") {
      const multimodal =
        message.role === "user" && options?.imageUrls === true
          ? multimodalContentFromParts(message.parts)
          : null;
      out.push({
        role: message.role,
        content: multimodal ?? textFromParts(message.parts),
      });
      continue;
    }

    if (message.role === "assistant") {
      // EDG records its local shell calls under assistant.toolCallId for the
      // transcript and recovery. Only the original call came from the model.
      const localShellCall = message.toolCallId && message.parts.find(
        (part): part is ToolCallPart =>
          part.type === "tool_call" && part.id === message.toolCallId && isShellToolName(part.name),
      );
      if (localShellCall) {
        localShellCalls.set(localShellCall.id, localShellCall);
        continue;
      }
      const toolCalls = toolCallsFromParts(message.parts, stubWriteArgs);
      if (toolCalls) {
        for (const call of toolCalls) {
          toolNameByCallId.set(call.id, call.function.name);
        }
      }
      const text = textFromParts(message.parts);
      const reasoning = reasoningFromParts(message.parts, options?.reasoningScope);
      const native = !stubWriteArgs && !ageToolResults && options?.reasoningScope
        ? message.parts.find((part): part is ModelResponsePart => part.type === "model_response"
          && part.providerScope === options.reasoningScope && part.status === "completed" && part.output.length > 0
          && part.contextReplayBlocked !== true)
        : undefined;
      if (
        !toolCalls &&
        !native &&
        text.trim().length === 0 &&
        reasoning.trim().length === 0
      ) {
        continue;
      }
      const wire: OpenAiChatMessage = {
        role: "assistant",
        content:
          text.trim().length > 0
            ? text
            : toolCalls
              ? null
              : REASONING_ONLY_ASSISTANT_CONTENT,
      };
      if (native) {
        const { type: _type, ...state } = native;
        wire.responsesOutput = state;
      }
      if (toolCalls) {
        wire.tool_calls = toolCalls;
        wire.reasoning_content = reasoning;
      } else if (reasoning.length > 0) {
        wire.reasoning_content = reasoning;
      }
      out.push(wire);
      continue;
    }

    const resultPart = message.parts.find(
      (p): p is ToolResultPart => p.type === "tool_result",
    );
    const localShellCall = localShellCalls.get(message.toolCallId);
    if (localShellCall) {
      if (!resultPart) continue;
      const output = toolResultText(resultPart, ageToolResults, localShellCall.name);
      const command = JSON.stringify(localShellCall.arguments.command);
      const label = `Local shell follow-up ${command} (returnCode=${resultPart.returnCode})`;
      const previous = out.at(-1);
      if (previous?.role === "tool" && typeof previous.content === "string" &&
          previous.tool_call_id && toolNameByCallId.get(previous.tool_call_id) === localShellCall.name) {
        previous.content += `\n\n${label}:\n${output}`;
      } else {
        // A compacted window can begin after the original call.
        out.push(categorizeContextMessage({
          role: "user",
          content: `${label}. Recorded tool output for context:\n${JSON.stringify(output)}`,
        }, "toolActivity"));
      }
      continue;
    }
    const wireImages =
      options?.toolRoleImages === true && !ageToolResults && resultPart
        ? resultPart.content.filter(
            (p): p is Extract<ToolResultContentPart, { type: "attachment" }> =>
              p.type === "attachment" &&
              p.kind === "image" &&
              !!p.s3?.url?.trim() &&
              isVisionImageRef(p.uri, p.mimeType),
          )
        : [];
    const toolName = toolNameByCallId.get(message.toolCallId);
    const wire: OpenAiChatMessage = {
      role: "tool",
      tool_call_id: message.toolCallId,
      content: wireImages.length > 0 && resultPart
        ? [
            {
              type: "text" as const,
              text: toolResultText(
                {
                  ...resultPart,
                  content: resultPart.content.filter(
                    (p) => !wireImages.some((w) => w === p),
                  ),
                },
                ageToolResults,
                toolName,
              ),
            },
            ...wireImages.map((p): OpenAiContentPart => ({
              type: "image_url",
              image_url: { url: p.s3!.url!.trim() },
            })),
          ]
        : resultPart
        ? toolResultText(
            resultPart,
            ageToolResults,
            toolName,
          )
        : "",
    };
    if (toolName === "read_skill" && resultPart?.returnCode === ToolReturnCode.Success) {
      categorizeContextMessage(wire, "skillPrompts");
    }
    out.push(wire);
  }

  return out;
}
