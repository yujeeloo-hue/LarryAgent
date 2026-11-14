/**
 * Session messages → OpenAI wire format. Shared wire-layer serializer used
 * by every compaction strategy and the turn host: compaction/clear markers
 * are skipped, write/append tool args can be stubbed, aged iterations can
 * clear oversized tool outputs, and S3 image attachments can render as
 * multimodal `image_url` parts.
 */
import type {
  OpenAiChatMessage,
  OpenAiContentPart,
} from "../../llm/types.js";
import type {
  JsonObject,
  Message,
  MessagePart,
  ModelResponsePart,
  ToolResultContentPart,
  ToolCallPart,
  ToolResultPart,
} from "../../session/types.js";
import {
  FILE_CONTENT_WIRE_STUB_TOOLS,
  stubFileContentArgsForWire,
  stubPatchArgsForWire,
} from "../../tools/fileWriteLimits.js";
import { parseToolArgumentsRaw } from "../../tools/validateToolArguments.js";
import { isVisionImageRef } from "../../tools/fileMeta.js";
import {
  formatAttachmentImagePathHint,
  formatAttachmentWireStub,
} from "../attachmentWireText.js";

/** Tool results longer than this are cleared on aged iterations (wire-only). */
export const AGED_TOOL_RESULT_MAX_CHARS = 200;
export const AGED_TOOL_RESULT_STUB =
  "[Old tool output cleared to save context space]";
/**
 * A persisted reasoning-only assistant can be left behind when a model
 * stream is interrupted before its first text delta. OpenAI-compatible
 * gateways commonly reject that history when `content` is empty, so keep
 * the reasoning echo and add a wire-only, non-empty final-content marker.
 */
export const REASONING_ONLY_ASSISTANT_CONTENT =
  "[Assistant response ended before producing a final answer]";

export type MessagesToOpenAiOptions = {
  /** When supplied, unverified or foreign reasoning is never replayed. */
  reasoningScope?: string;
  /**
   * When true, stub write_file `content` and V4A `patch` bulk text
   * on the wire. Only aged iterations should set this; raw iterations keep
   * original args. Replace-mode old_string/new_string are not stubbed.
   */
  stubWriteArgs?: boolean;
  /**
   * When true, replace tool results longer than
   * {@link AGED_TOOL_RESULT_MAX_CHARS} with {@link AGED_TOOL_RESULT_STUB}.
   */
  ageToolResults?: boolean;
  /**
   * When true, user messages with raster image attachments carrying `s3.url`
   * render as multimodal `image_url` content parts instead of the
   * read_image path stub. SVG is excluded (XML markup — read_file stub).
   * Only set for chat providers that accept URL-based image input.
   */
  imageUrls?: boolean;
  /**
   * When true, tool results carrying raster image attachments with `s3.url`
   * render the tool message `content` as a multimodal array
   * `[text, {image_url}]` (read_image direct — provider accepts tool-role
   * images). SVG and aged iterations keep the plain string form.
   */
  toolRoleImages?: boolean;
};

/**
 * Replace write/patch bulk text (`content` / V4A `patch`) with a
 * non-callable size stub on the model wire. Session/UI keep the full
 * tool_call arguments for the card preview.
 */
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
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.type === "text") {
      // UI-only payloads (full file body / full-file diff JSON) must not be
      // replayed to the model — they blow context and trip provider 500s.
      if (part.id === "file_body" || part.id === "file_diff") continue;
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(formatAttachmentWireStub(part));
    } else if (part.type === "hosted_tool") {
      chunks.push(`[Hosted ${part.name}: ${part.status}]`);
    }
  }
  return chunks.join("\n");
}

/**
 * Multimodal body for a user message: text part + `image_url` content parts
 * for image attachments that carry an S3/COS URL. Image attachments with a
 * URL are excluded from the text (they are already image_url parts); other
 * attachments keep their read_image / read_file stubs. SVG is never an
 * image_url part (XML markup — read_file stub). Returns null when
 * there is no S3-backed raster image attachment (callers fall back to the
 * plain string body).
 */
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
  // Keep image file paths model-visible: the image_url parts below carry the
  // pixels, but tools that take a file path (generate_image reference images)
  // only learn it from these hint lines.
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

/** Provider CoT for wire echo (`reasoning_content`); never mixed into `content`. */
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
  // patch failure excerpts (and legacy edit_file excerpts) must stay on the
  // wire so the next round can rebuild old_string / the V4A hunk; aging would
  // replace them with a stub once they exceed AGED_TOOL_RESULT_MAX_CHARS.
  if (toolName === "patch" || toolName === "edit_file") return raw;
  if (ageToolResults && raw.length > AGED_TOOL_RESULT_MAX_CHARS) {
    return AGED_TOOL_RESULT_STUB;
  }
  return raw;
}

/** Wire-safe tool arguments JSON (never send truncated / invalid raw to the model). */
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
    // Prefer the original raw when it parses, to preserve key order / formatting.
    const trimmed = tc.argumentsRaw.trim();
    return trimmed.length > 0 ? trimmed : "{}";
  }
  // Invalid / truncated streams (common on large write_file) poison some
  // providers with HTTP 500 "model engine error" if replayed as-is.
  // Prefer structured args when available (may still hold full content).
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

/** /clear marker message (system message carrying a context_clear part). */
export function isClearMessage(message: Message): boolean {
  return (
    message.role === "system" &&
    message.parts.some((p) => p.type === "context_clear")
  );
}

/** Index of the latest context_clear marker; -1 when absent. */
export function findLatestClearIndex(messages: Message[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isClearMessage(messages[i]!)) return i;
  }
  return -1;
}

/** Map a slice of session messages to OpenAI wire format (skips compaction markers). */
export function messagesToOpenAi(
  messages: Message[],
  options?: MessagesToOpenAiOptions,
): OpenAiChatMessage[] {
  const stubWriteArgs = options?.stubWriteArgs === true;
  const ageToolResults = options?.ageToolResults === true;
  const out: OpenAiChatMessage[] = [];
  const toolNameByCallId = new Map<string, string>();

  for (const message of messages) {
    if (isCompactionMessage(message) || isClearMessage(message)) continue;

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
        // Interrupted/crashed streams can persist an empty assistant shell.
        // It has no conversational meaning and some providers reject it.
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
        // DeepSeek thinking + tools: every tool-call assistant must carry
        // reasoning_content (including synthetic injects with empty CoT).
        wire.reasoning_content = reasoning;
      } else if (reasoning.length > 0) {
        wire.reasoning_content = reasoning;
      }
      out.push(wire);
      continue;
    }

    // role === "tool"
    const resultPart = message.parts.find(
      (p): p is ToolResultPart => p.type === "tool_result",
    );
    // read_image direct: promote S3-backed raster images in the tool result
    // to image_url parts (chat-style content array). Aged iterations and
    // non-raster attachments keep the string form.
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
    out.push({
      role: "tool",
      tool_call_id: message.toolCallId,
      content: wireImages.length > 0 && resultPart
        ? [
            {
              type: "text" as const,
              // Promoted attachments leave the text path entirely — the
              // handler's hint line already names the file path.
              text: toolResultText(
                {
                  ...resultPart,
                  content: resultPart.content.filter(
                    (p) => !wireImages.some((w) => w === p),
                  ),
                },
                ageToolResults,
                message.toolCallId
                  ? toolNameByCallId.get(message.toolCallId)
                  : undefined,
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
            message.toolCallId
              ? toolNameByCallId.get(message.toolCallId)
              : undefined,
          )
        : "",
    });
  }

  return out;
}
