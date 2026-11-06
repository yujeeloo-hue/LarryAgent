/**
 * Conversation-column display projection.
 *
 * Decides which parts of a turn are painted. Session records, the model
 * window, and the end-of-turn file list stay on the full transcript.
 */
import { STEER_CONTINUATION_PART_ID, RETRY_CONTINUATION_PART_ID } from "../../../../session/types.js";
import { isWireOverlayTranscriptMessage } from "../../../../session/wireOverlay.js";
import { getToolDisplayMeta } from "../../../../tools/displayMeta.js";
import { detectSleepCommand } from "../../../../tools/sleepDetect.js";

/** Part id on a turn's merged Thinking blocks (one per segment between replies). */
export const TURN_REASONING_PART_ID = "turn-reasoning";

/** Most recent hidden-tool hints kept on one Thinking title. */
export const MAX_TURN_TOOL_HINTS = 24;

/** Tools that neither paint a card nor earn a Thinking-title hint. */
const SILENT_TOOLS = new Set(["update_plan", "complete_plan", "fsm_route"]);

/**
 * Tool cards the conversation column paints. Everything else stays in the
 * transcript and the Detail log.
 */
const CONVERSATION_CARD_TOOLS = new Set([
  "coco_job_input",
  "read_coco_context",
  "submit_coco_result",
  "patch",
  "write_file",
  "upload_files",
  "ask_user",
  "request_full_permissions",
  "sleep",
  "create_plan",
  "display_image",
  "display_pdf",
  "present_demo",
  "generate_image",
  "capture_app_window",
  "convert_to_pdf",
  "dispatch_subagent",
  "subagent_batch_result",
  "edit_file",
  "append_file",
  "write_plan_doc",
]);

export type TurnDisplayPart = Record<string, unknown> & {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  arguments?: unknown;
  durationMs?: number;
  tokenCount?: number;
  toolHints?: string[];
  toolRecords?: ReasoningToolRecord[];
};

/**
 * One hidden-tool call on a Thinking block's record (V1 list inside the
 * expanded body). `hint` is the same `${displayName} ${detail}` string the
 * title dock uses; `durationMs`/`failed` ride the tool_call part.
 */
export type ReasoningToolRecord = {
  /** tool_call id — lets the live path upsert duration/status on finish. */
  id: string;
  hint: string;
  durationMs?: number;
  failed?: boolean;
};

export type TurnDisplayMessage = {
  role: string;
  id?: string;
  parts: TurnDisplayPart[];
};


export function unwrapToolCallName(name: string, args: unknown): string {
  if (name !== "tool_call") return name;
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const inner = record.name;
    const innerArgs = record.arguments;
    if (
      typeof inner === "string" &&
      inner.length > 0 &&
      innerArgs !== null &&
      typeof innerArgs === "object" &&
      !Array.isArray(innerArgs)
    ) {
      return inner;
    }
  }
  return name;
}

function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}

/** True when this invocation paints a card (allowlist, or a shell sleep). */
export function isConversationCardVisible(name: string, args?: unknown): boolean {
  if (CONVERSATION_CARD_TOOLS.has(name)) return true;
  if (!isShellToolName(name)) return false;
  const command = (args as { command?: unknown } | null | undefined)?.command;
  if (typeof command !== "string") return false;
  return detectSleepCommand(command).isSleep;
}

function innerToolArgs(name: string, args: unknown): unknown {
  if (name !== "tool_call" || args === null || typeof args !== "object") return args;
  return (args as Record<string, unknown>).arguments ?? args;
}

function clipHint(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

/**
 * Short Thinking-title hint for a tool that paints no card, or null when the
 * tool stays silent (cards, plan bookkeeping, routing).
 */
export function toolHintLabel(rawName: string, rawArgs?: unknown): string | null {
  const name = unwrapToolCallName(rawName, rawArgs);
  const args = innerToolArgs(rawName, rawArgs);
  if (!name || SILENT_TOOLS.has(name) || isConversationCardVisible(name, args)) return null;
  const label = getToolDisplayMeta(name).displayName;
  const record =
    args !== null && typeof args === "object" && !Array.isArray(args)
      ? (args as Record<string, unknown>)
      : {};
  const str = (key: string): string =>
    typeof record[key] === "string" ? (record[key] as string).trim() : "";
  let detail = "";
  if (isShellToolName(name)) detail = clipHint(str("command"), 48);
  else if (str("path")) detail = baseName(str("path"));
  else if (str("pattern")) detail = clipHint(str("pattern"), 40);
  else if (str("query")) detail = clipHint(str("query"), 40);
  return detail ? `${label} ${detail}` : label;
}

function toolNameOf(part: TurnDisplayPart): string | null {
  if (part.type !== "tool_call" || typeof part.name !== "string") return null;
  return unwrapToolCallName(part.name, part.arguments);
}

function isSteer(message: { role: string; parts: TurnDisplayPart[] }): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) => part.type === "text" && part.id === STEER_CONTINUATION_PART_ID,
    )
  );
}

export type MergedReasoning = {
  text: string;
  durationMs?: number;
  tokenCount?: number;
};

/** Join every non-empty reasoning part in order. Empty segments are dropped. */
export function mergeReasoningParts(
  parts: readonly TurnDisplayPart[],
): MergedReasoning | null {
  const chunks: string[] = [];
  let durationMs = 0;
  let sawDuration = false;
  let tokenCount = 0;
  let sawTokens = false;
  for (const part of parts) {
    if (part.type !== "reasoning" || typeof part.text !== "string") continue;
    const text = part.text.trim();
    if (!text) continue;
    chunks.push(text);
    if (typeof part.durationMs === "number" && Number.isFinite(part.durationMs)) {
      durationMs += part.durationMs;
      sawDuration = true;
    }
    if (typeof part.tokenCount === "number" && Number.isFinite(part.tokenCount)) {
      tokenCount += part.tokenCount;
      sawTokens = true;
    }
  }
  if (chunks.length === 0) return null;
  const merged: MergedReasoning = { text: chunks.join("\n\n") };
  if (sawDuration) merged.durationMs = durationMs;
  if (sawTokens) merged.tokenCount = tokenCount;
  return merged;
}

/** Keep the newest hints and drop a hint that repeats the one before it. */
export function pushToolHint(hints: string[], hint: string): void {
  if (hints[hints.length - 1] === hint) return;
  hints.push(hint);
  if (hints.length > MAX_TURN_TOOL_HINTS) hints.splice(0, hints.length - MAX_TURN_TOOL_HINTS);
}

/** What one Thinking block collects between two pieces of painted content. */
type ThoughtSegment = {
  chunks: string[];
  toolHints: string[];
  toolRecords: ReasoningToolRecord[];
  reasoningParts: TurnDisplayPart[];
  /** First assistant message that fed this segment (row id anchor). */
  anchorId: string | null;
};

function emptyThoughtSegment(): ThoughtSegment {
  return { chunks: [], toolHints: [], toolRecords: [], reasoningParts: [], anchorId: null };
}

/**
 * Feed a part into the open Thinking segment. True when the part belongs
 * to Thinking (reasoning, hidden-tool hint). Reply text never folds.
 */
function feedThought(
  segment: ThoughtSegment,
  part: TurnDisplayPart,
  message: TurnDisplayMessage,
): boolean {
  let fed = false;
  if (part.type === "reasoning") {
    segment.reasoningParts.push(part);
    const text = typeof part.text === "string" ? part.text.trim() : "";
    if (text) {
      segment.chunks.push(text);
      fed = true;
    }
  } else if (part.type === "tool_call" && typeof part.name === "string") {
    const hint = toolHintLabel(part.name, part.arguments);
    if (hint) {
      pushToolHint(segment.toolHints, hint);
      // The record keeps every call (merge ×N happens at render); duration
      // and failure ride the part's terminal stamp.
      const record: ReasoningToolRecord = { id: typeof part.id === "string" ? part.id : hint, hint };
      if (typeof part.durationMs === "number" && Number.isFinite(part.durationMs)) {
        record.durationMs = part.durationMs;
      }
      if (part.status === "error") record.failed = true;
      segment.toolRecords.push(record);
      fed = true;
    }
  }
  if (fed && !segment.anchorId && typeof message.id === "string" && message.id) {
    segment.anchorId = message.id;
  }
  return part.type === "reasoning" || fed;
}

/** The segment's Thinking part, or null when it collected nothing. */
function thoughtPartOf(segment: ThoughtSegment): TurnDisplayPart | null {
  if (segment.chunks.length === 0 && segment.toolHints.length === 0) return null;
  const part: TurnDisplayPart = {
    type: "reasoning",
    id: TURN_REASONING_PART_ID,
    text: segment.chunks.join("\n\n"),
  };
  if (segment.toolHints.length > 0) part.toolHints = segment.toolHints;
  if (segment.toolRecords.length > 0) part.toolRecords = segment.toolRecords;
  const stats = mergeReasoningParts(segment.reasoningParts);
  if (stats?.durationMs !== undefined) part.durationMs = stats.durationMs;
  if (stats?.tokenCount !== undefined) part.tokenCount = stats.tokenCount;
  return part;
}

/**
 * Assistant parts that belong in the column. Reasoning is omitted here —
 * the turn projection hoists it into Thinking blocks. Non-empty reply text
 * always stays (never folded into Thinking).
 */
export function visibleAssistantParts(
  parts: readonly TurnDisplayPart[],
): TurnDisplayPart[] {
  const visible: TurnDisplayPart[] = [];
  for (const part of parts) {
    if (part.type === "reasoning" || part.type === "model_response" || part.type === "tool_result") {
      continue;
    }
    if (part.type === "tool_call") {
      const name = toolNameOf(part);
      if (name && isConversationCardVisible(name, part.arguments)) visible.push(part);
      continue;
    }
    if (part.type === "text") {
      if (typeof part.text !== "string" || part.text.trim().length === 0) continue;
      visible.push(part);
      continue;
    }
    if (
      part.type === "attachment" ||
      part.type === "context_compaction" ||
      part.type === "context_clear"
    ) {
      visible.push(part);
    }
  }
  return visible;
}

/** Filter one assistant message the way a live slice refresh paints it. */
export function projectAssistantMessage<T extends TurnDisplayMessage>(message: T): T {
  if (message.role !== "assistant") return message;
  return {
    ...message,
    parts: visibleAssistantParts(message.parts),
  };
}

/**
 * Project one turn. User prompts, steer, and system rows stay. Assistant
 * reasoning and hidden-tool hints collapse into Thinking blocks. Painted
 * content (reply text, a steer, an attachment, a tool card) closes the open
 * block above it; thinking after that opens a new block, matching the live
 * column. Tool cards follow the allowlist. The input messages are not
 * mutated.
 */
export function projectTurnMessages<T extends TurnDisplayMessage>(
  messages: readonly T[],
): T[] {
  const out: T[] = [];
  let segment = emptyThoughtSegment();
  let segmentIndex = 0;

  /** Emit the open block into `hostParts`, or as its own row when omitted. */
  const closeSegment = (hostParts?: TurnDisplayPart[]): void => {
    const part = thoughtPartOf(segment);
    const anchor = segment.anchorId ?? "turn";
    segment = emptyThoughtSegment();
    if (!part) return;
    if (hostParts) {
      hostParts.push(part);
    } else {
      const suffix = segmentIndex > 0 ? `:${segmentIndex}` : "";
      out.push({ role: "assistant", id: `turn-reasoning:${anchor}${suffix}`, parts: [part] } as T);
    }
    segmentIndex += 1;
  };

  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex]!;
    if (message.role !== "assistant") {
      if (paintsRow(message)) closeSegment();
      out.push(message);
      continue;
    }
    const parts: TurnDisplayPart[] = [];
    for (const part of message.parts) {
      if (feedThought(segment, part, message)) continue;
      if (!keepAssistantPart(part)) continue;
      if (parts.length > 0) closeSegment(parts);
      else closeSegment();
      parts.push(part);
    }
    if (parts.length > 0) out.push({ ...message, parts });
  }
  closeSegment();
  return out;
}

/**
 * Non-assistant rows that paint something. Tool results and empty system
 * markers render nothing, so they must not split a Thinking block.
 */
function paintsRow(message: TurnDisplayMessage): boolean {
  if (message.role === "tool") return false;
  if (message.role !== "system") return true;
  return message.parts.some(
    (part) =>
      part.type === "context_compaction" ||
      part.type === "context_clear" ||
      (part.type === "text" && typeof part.text === "string" && part.text.trim().length > 0),
  );
}

function keepAssistantPart(part: TurnDisplayPart): boolean {
  if (part.type === "reasoning" || part.type === "model_response" || part.type === "tool_result") {
    return false;
  }
  if (part.type === "tool_call") {
    const name = toolNameOf(part);
    return Boolean(name && isConversationCardVisible(name, part.arguments));
  }
  if (part.type === "text") {
    return typeof part.text === "string" && part.text.trim().length > 0;
  }
  return (
    part.type === "attachment" ||
    part.type === "context_compaction" ||
    part.type === "context_clear"
  );
}

/** Hidden retry-continuation user message (Retry click) — model-facing only. */
function isRetryContinuation(message: { role: string; parts: TurnDisplayPart[] }): boolean {
  return (
    message.role === "user" &&
    message.parts.some(
      (part) => part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
    )
  );
}

/**
 * Project a transcript, one turn at a time. Wire overlays are omitted.
 * Retry-continuation prompts are dropped entirely — the model sees them on
 * the wire, no conversation UI does.
 */
export function projectTranscriptMessages<T extends TurnDisplayMessage>(
  messages: readonly T[],
): T[] {
  const out: T[] = [];
  let current: T[] = [];
  const flush = (): void => {
    if (current.length === 0) return;
    out.push(...projectTurnMessages(current));
    current = [];
  };
  for (const message of messages) {
    if (isWireOverlayTranscriptMessage(message)) continue;
    if (isRetryContinuation(message)) continue;
    if (message.role === "system") {
      if (current.length === 0) out.push(message);
      else current.push(message);
      continue;
    }
    if (message.role === "user" && !isSteer(message)) {
      flush();
      current = [message];
      continue;
    }
    if (current.length === 0) current = [message];
    else current.push(message);
  }
  flush();
  return out;
}
