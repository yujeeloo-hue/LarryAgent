import type {
  HostedToolPart,
  JsonObject,
  Message,
  ToolCallPart,
  ToolResultPart,
} from "../../../../session/types.js";
import {
  argNumber,
  argString,
  clipOneLine,
  resolveToolExecutionSummary,
  shortPath,
} from "../../../../tools/executionSummary.js";
import { getTool } from "../../../../tools/registry.js";
import { formatAttachmentWireStub } from "../../../attachmentWireText.js";
import { estimateTokensFromText } from "../../../estimateTokens.js";
import type { ProtectIteration } from "./splitIterations.js";
import { iterationAllMessages } from "./splitIterations.js";

/** Per USER/ASSISTANT block soft cap (tokens). */
export const ROUND_PROTECT_TEXT_BLOCK_MAX_TOKENS = 1200;
/**
 * Soft cap for assistant prose when the same block also lists tool calls.
 * Intent matter; long “let me read more…” narration does not.
 */
export const ROUND_PROTECT_ASSISTANT_PROSE_MAX_CHARS = 200;
/**
 * Soft cap for clipped `[reasoning]:` lines in summarize input (chars).
 * Head+tail truncate so durable decisions near either end can survive.
 */
export const ROUND_PROTECT_REASONING_MAX_CHARS = 800;
/** Fraction of context limit for the whole summarize payload. */
export const ROUND_PROTECT_PAYLOAD_RATIO = 0.7;

const TEXT_HEAD_RATIO = 0.45;
const TEXT_TAIL_RATIO = 0.5;
const PAYLOAD_HEAD_RATIO = 0.4;
const PAYLOAD_TAIL_RATIO = 0.55;
const REASONING_HEAD_RATIO = 0.45;
const REASONING_TAIL_RATIO = 0.5;

const TEXT_TRUNCATE_MARK = "\n[...truncated...]\n";
const PAYLOAD_TRUNCATE_MARK = "\n[...conversation truncated...]\n";
const REASONING_TRUNCATE_MARK = "\n[...truncated...]\n";

function textFromMessage(message: Message): string {
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      if (part.id === "file_body" || part.id === "file_diff") continue;
      chunks.push(part.text);
    } else if (part.type === "attachment") {
      chunks.push(formatAttachmentWireStub(part));
    }
  }
  return chunks.join("\n").trim();
}

/** Only the summarizer's own binding may receive provider reasoning. */
export function reasoningFromMessage(message: Message, reasoningScope?: string): string {
  if (!reasoningScope) return "";
  const chunks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "reasoning" && part.providerScope === reasoningScope && part.text.trim().length > 0) {
      chunks.push(part.text.trim());
    }
  }
  return chunks.join("\n").trim();
}

/** Head+tail char clip for reasoning snippets in compact LLM payloads. */
export function clipReasoningForSummary(
  text: string,
  maxChars = ROUND_PROTECT_REASONING_MAX_CHARS,
): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const mark = REASONING_TRUNCATE_MARK;
  const headChars = Math.max(
    1,
    Math.floor((maxChars - mark.length) * REASONING_HEAD_RATIO),
  );
  const tailChars = Math.max(
    1,
    Math.floor((maxChars - mark.length) * REASONING_TAIL_RATIO),
  );
  if (headChars + tailChars + mark.length >= text.length) return text;
  return `${text.slice(0, headChars)}${mark}${text.slice(text.length - tailChars)}`;
}

/**
 * Truncate by token budget: head + mark + tail.
 * Uses char-proportional slices as a fast approximation of token cuts.
 */
export function truncateByTokenBudget(
  text: string,
  maxTokens: number,
  headRatio: number,
  tailRatio: number,
  mark: string,
): string {
  if (maxTokens <= 0 || text.length === 0) return text;
  const tokens = estimateTokensFromText(text);
  if (tokens <= maxTokens) return text;

  const headTokens = Math.max(1, Math.floor(maxTokens * headRatio));
  const tailTokens = Math.max(1, Math.floor(maxTokens * tailRatio));
  // Approximate chars-per-token from the full string.
  const cpt = Math.max(1, text.length / Math.max(1, tokens));
  const headChars = Math.max(1, Math.floor(headTokens * cpt));
  const tailChars = Math.max(1, Math.floor(tailTokens * cpt));
  if (headChars + tailChars >= text.length) return text;
  return `${text.slice(0, headChars)}${mark}${text.slice(text.length - tailChars)}`;
}

/**
 * Compact tool-call line for summarize input: name + key args only.
 * Avoids dumping full JSON (patterns / absolute paths) that TOOL lines already cover.
 */
function formatToolCallBrief(tc: ToolCallPart): string {
  const args = (tc.arguments ?? {}) as JsonObject;
  const bits: string[] = [];
  const path =
    argString(args, "path") ??
    argString(args, "output") ??
    argString(args, "cwd");
  const pattern = argString(args, "pattern");
  const prompt =
    argString(args, "prompt") ??
    argString(args, "question") ??
    argString(args, "query");
  const command = argString(args, "command");

  if (path) bits.push(shortPath(path, 40));
  if (pattern) bits.push(`"${clipOneLine(pattern, 36)}"`);
  if (prompt) bits.push(`"${clipOneLine(prompt, 36)}"`);
  if (command) bits.push(`\`${clipOneLine(command, 40)}\``);

  const offset = argNumber(args, "offset");
  const limit = argNumber(args, "limit");
  if (offset !== undefined || limit !== undefined) {
    bits.push(
      `L${offset ?? 1}${limit !== undefined ? `+${limit}` : ""}`,
    );
  }

  if (bits.length === 0) {
    try {
      const raw = JSON.stringify(args);
      if (raw === "{}") return tc.name;
      if (raw.length <= 48) return `${tc.name}(${raw})`;
      return `${tc.name}(${raw.slice(0, 45)}...)`;
    } catch {
      return tc.name;
    }
  }
  return `${tc.name}(${bits.join(" ")})`;
}

function clipAssistantProse(text: string, hasToolCalls: boolean): string {
  if (!hasToolCalls || text.length <= ROUND_PROTECT_ASSISTANT_PROSE_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, ROUND_PROTECT_ASSISTANT_PROSE_MAX_CHARS - 1)}…`;
}

function formatAssistantBlock(message: Message, reasoningScope?: string): string {
  const toolCalls = message.parts.filter(
    (p): p is ToolCallPart => p.type === "tool_call",
  );
  const prose = clipAssistantProse(
    textFromMessage(message),
    toolCalls.length > 0 || message.parts.some((part) => part.type === "hosted_tool"),
  );
  let body = prose;
  if (toolCalls.length > 0) {
    const lines = toolCalls.map((tc) => `  ${formatToolCallBrief(tc)}`);
    const tcBlock = `[tools:\n${lines.join("\n")}\n]`;
    body = body ? `${body}\n${tcBlock}` : tcBlock;
  }
  const reasoning = clipReasoningForSummary(reasoningFromMessage(message, reasoningScope));
  if (reasoning.length > 0) {
    const reasoningLine = `[reasoning]: ${reasoning}`;
    body = body ? `${body}\n${reasoningLine}` : reasoningLine;
  }
  const capped = truncateByTokenBudget(
    body,
    ROUND_PROTECT_TEXT_BLOCK_MAX_TOKENS,
    TEXT_HEAD_RATIO,
    TEXT_TAIL_RATIO,
    TEXT_TRUNCATE_MARK,
  );
  return `[ASSISTANT]: ${capped}`;
}

function hostedObject(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as JsonObject
    : undefined;
}

/** Summarize public activity fields, never opaque replay or large binary output. */
function formatHostedToolBlock(part: HostedToolPart): string {
  const details: string[] = [];
  const item = part.item;
  if (item) {
    const action = hostedObject(item.action);
    const query = action?.query ?? item.queries ?? action?.queries;
    if (typeof query === "string") details.push(`query=${clipOneLine(query, 140)}`);
    else if (Array.isArray(query)) {
      const queries = query.filter((value): value is string => typeof value === "string").slice(0, 3);
      if (queries.length) details.push(`queries=${clipOneLine(queries.join("; "), 140)}`);
    }
    if (typeof item.server_label === "string") details.push(`server=${clipOneLine(item.server_label, 80)}`);
    if (typeof item.name === "string") details.push(`name=${clipOneLine(item.name, 80)}`);
    const error = hostedObject(item.error);
    const errorText = typeof item.error === "string" ? item.error : error?.message ?? error?.code;
    if (typeof errorText === "string") details.push(`error=${clipOneLine(errorText, 180)}`);
    if (Array.isArray(action?.sources)) {
      const urls = action.sources.slice(0, 3).map(hostedObject)
        .map((source) => source?.url).filter((url): url is string => typeof url === "string");
      if (urls.length) details.push(`sources=${clipOneLine(urls.join(" "), 240)}`);
    }
    const outputs = Array.isArray(item.outputs) ? item.outputs.slice(0, 3) : [];
    const results = Array.isArray(item.results) ? item.results.slice(0, 3) : [];
    const fileIds: string[] = [];
    for (const raw of [item, ...results, ...outputs]) {
      const entry = hostedObject(raw);
      if (!entry) continue;
      if (typeof entry.file_id === "string") fileIds.push(entry.file_id);
      if (Array.isArray(entry.files)) {
        for (const file of entry.files.slice(0, 3)) {
          const fileId = hostedObject(file)?.file_id;
          if (typeof fileId === "string") fileIds.push(fileId);
        }
      }
      if (entry.type === "logs" && typeof entry.logs === "string") {
        details.push(`output=${clipOneLine(entry.logs, 180)}`);
      }
    }
    if (fileIds.length) details.push(`files=${clipOneLine([...new Set(fileIds)].join(" "), 180)}`);
  }
  return `[TOOL]: ${clipOneLine(part.name, 80)} (hosted, ${part.status})${details.length ? ` ${details.join("; ")}` : ""}`;
}

function formatUserBlock(message: Message): string {
  const text = textFromMessage(message);
  const capped = truncateByTokenBudget(
    text,
    ROUND_PROTECT_TEXT_BLOCK_MAX_TOKENS,
    TEXT_HEAD_RATIO,
    TEXT_TAIL_RATIO,
    TEXT_TRUNCATE_MARK,
  );
  return `[USER]: ${capped}`;
}

function toolCallsByIdFromIterations(iterations: ProtectIteration[]): Map<string, ToolCallPart> {
  const map = new Map<string, ToolCallPart>();
  for (const round of iterations) {
    for (const message of iterationAllMessages(round)) {
      if (message.role !== "assistant") continue;
      for (const part of message.parts) {
        if (part.type === "tool_call") {
          map.set(part.id, part);
        }
      }
    }
  }
  return map;
}

function formatToolBlock(
  message: Extract<Message, { role: "tool" }>,
  toolCallsById: Map<string, ToolCallPart>,
): string {
  const resultPart = message.parts.find(
    (p): p is ToolResultPart => p.type === "tool_result",
  );
  const call = toolCallsById.get(message.toolCallId);
  const name = call?.name ?? "unknown_tool";
  const args = (call?.arguments ?? {}) as JsonObject;
  const returnCode = resultPart?.returnCode ?? 1;
  const content = resultPart?.content ?? [];

  // Always prefer the one-line execution summary for compact payloads.
  // Raw bodies (list_dir dumps, grep hits) are noise for the summarizer and
  // duplicate what Completed Actions needs at a higher level.
  let body = resolveToolExecutionSummary(getTool(name), name, {
    args,
    returnCode,
    content,
  }).trim();
  if (!body) {
    body = `returnCode=${returnCode}`;
  }

  // Summarizers already prefix with the tool name — avoid `read_file read_file …`.
  if (body === name || body.startsWith(`${name} `) || body.startsWith(`${name}:`)) {
    return `[TOOL]: ${body}`;
  }
  return `[TOOL]: ${name} ${body}`;
}

/**
 * Serialize iterations (oldest-first) to Hermes-style [USER]/[ASSISTANT]/[TOOL] text.
 */
export function serializeIterationsForSummary(
  iterationsOldestFirst: ProtectIteration[],
  options: { reasoningScope?: string } = {},
): string {
  const toolCallsById = toolCallsByIdFromIterations(iterationsOldestFirst);
  const parts: string[] = [];

  for (const round of iterationsOldestFirst) {
    for (const message of round.userPrefix) {
      if (message.role === "user") {
        parts.push(formatUserBlock(message));
      }
    }
    for (const message of round.messages) {
      if (message.role === "assistant") {
        parts.push(formatAssistantBlock(message, options.reasoningScope));
        for (const part of message.parts) {
          if (part.type === "hosted_tool") parts.push(formatHostedToolBlock(part));
        }
      } else if (message.role === "tool") {
        parts.push(formatToolBlock(message, toolCallsById));
      } else if (message.role === "user") {
        parts.push(formatUserBlock(message));
      }
    }
  }

  return parts.join("\n\n");
}

/** Cap the full summarize payload under limit * 0.7 tokens. */
export function fitSummaryPayload(
  text: string,
  contextLimitTokens: number,
): string {
  const budget = Math.floor(contextLimitTokens * ROUND_PROTECT_PAYLOAD_RATIO);
  return truncateByTokenBudget(
    text,
    budget,
    PAYLOAD_HEAD_RATIO,
    PAYLOAD_TAIL_RATIO,
    PAYLOAD_TRUNCATE_MARK,
  );
}
