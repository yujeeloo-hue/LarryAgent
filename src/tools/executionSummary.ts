import { ToolReturnCode } from "../session/returnCodes.js";
import type { JsonObject, ToolResultContentPart } from "../session/types.js";
import type {
  RegisteredTool,
  ToolExecutionSummarizer,
  ToolExecutionSummaryInput,
} from "./types.js";

/** Map returnCode → short English outcome word for templates. */
export function outcomeWord(returnCode: number): string {
  switch (returnCode) {
    case ToolReturnCode.Success:
      return "succeeded";
    case ToolReturnCode.PermissionDenied:
      return "permission denied";
    case ToolReturnCode.NotFound:
      return "not found";
    case ToolReturnCode.Timeout:
      return "timed out";
    case ToolReturnCode.InvalidArguments:
      return "invalid arguments";
    case ToolReturnCode.Cancelled:
      return "cancelled";
    default:
      return "failed";
  }
}

/** Join text parts from a tool result (skips UI-only ids when callers filter). */
export function textBody(
  content: ToolResultContentPart[],
  options?: { skipIds?: ReadonlySet<string> },
): string {
  const skip = options?.skipIds;
  const parts: string[] = [];
  for (const part of content) {
    if (part.type !== "text") continue;
    if (skip && part.id && skip.has(part.id)) continue;
    parts.push(part.text);
  }
  return parts.join("\n");
}

/** UTF-8 byte length without node:Buffer (renderer-safe). */
export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function argString(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function argNumber(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && /^\d+$/.test(value.trim())) {
    return Number(value.trim());
  }
  return undefined;
}

/** Last path segment without node:path (renderer-safe). */
function basenameOf(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx >= 0 ? path.slice(idx + 1) : path;
}

/** Prefer basename for long absolute paths; keep short paths intact. */
export function shortPath(path: string | undefined, max = 48): string {
  if (!path) return "(unknown path)";
  const normalized = path.replace(/\\/g, "/");
  if (normalized.length <= max) return normalized;
  const base = basenameOf(normalized);
  if (base.length > 0 && base.length < normalized.length) {
    return `…/${base}`;
  }
  return `${normalized.slice(0, max - 1)}…`;
}

export function clipOneLine(text: string, max = 40): string {
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= max) return one;
  return `${one.slice(0, max - 1)}…`;
}

/** First non-empty line of result text. */
export function firstResultLine(content: ToolResultContentPart[]): string {
  const body = textBody(content).trim();
  if (!body) return "";
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0);
  return line?.trim() ?? "";
}

/**
 * Generic fallback for MCP / unknown tools.
 * Example: `mcp__foo__bar completed: succeeded.`
 */
export function summarizeGenericTool(
  name: string,
  input: ToolExecutionSummaryInput,
): string {
  const outcome = outcomeWord(input.returnCode);
  const label = name.trim() || "unknown_tool";
  return `${label} completed: ${outcome}.`;
}

export function resolveToolExecutionSummary(
  tool: RegisteredTool | undefined,
  name: string,
  input: ToolExecutionSummaryInput,
): string {
  const summarizer: ToolExecutionSummarizer | undefined =
    tool?.summarizeExecution;
  if (summarizer) {
    try {
      const text = summarizer(input).trim();
      if (text.length > 0) return text;
    } catch {
      // Fall through to generic.
    }
  }
  return summarizeGenericTool(name, input);
}
