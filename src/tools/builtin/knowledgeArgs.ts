import { knowledgeBase } from "../../knowledge/store.js";
import { KNOWLEDGE_KEYWORDS_MAX, KNOWLEDGE_KEYWORDS_MIN } from "../../knowledge/limits.js";
import type { KnowledgeDeleteResult, KnowledgeMutationResult } from "../../knowledge/types.js";
import { agentLogInfo } from "../../logging/agentLog.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { JsonObject, ToolExecuteResult } from "../types.js";
import { failureResult, textResult } from "../pathUtil.js";

const REASON_MAX = 300;

export function stringArg(args: JsonObject, key: string): string | undefined {
  const value = args[key];
  return typeof value === "string" ? value : undefined;
}

export function stringListArg(args: JsonObject, key: string): string[] | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string");
    } catch {
      return trimmed.slice(1, -1).split(",").map((s) => s.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

export function intArg(args: JsonObject, key: string): number | undefined {
  const value = args[key];
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}

export const KNOWLEDGE_REASON_PROPERTY = {
  type: "string",
  description: "Why this change is needed (≤300 chars), e.g. the mistake it prevents.",
} as const;

export const KNOWLEDGE_KEYWORDS_PROPERTY = {
  type: "array",
  items: { type: "string" },
  minItems: KNOWLEDGE_KEYWORDS_MIN,
  maxItems: KNOWLEDGE_KEYWORDS_MAX,
  description: `${KNOWLEDGE_KEYWORDS_MIN}–${KNOWLEDGE_KEYWORDS_MAX} search terms a model would type (English, plus Chinese if useful), incl. tool names.`,
} as const;

export function knowledgeReason(args: JsonObject): string | null {
  const reason = stringArg(args, "reason")?.replace(/\s+/g, " ").trim() ?? "";
  return reason ? reason.slice(0, REASON_MAX) : null;
}

export function knowledgeUnavailable(): ToolExecuteResult | null {
  return knowledgeBase.isConfigured()
    ? null
    : failureResult("The knowledge base is not available in this host.", ToolReturnCode.NotFound);
}

export const missingReasonResult = (): ToolExecuteResult =>
  failureResult('Invalid arguments: "reason" is required.', ToolReturnCode.InvalidArguments);

function failureCode(code: "invalid" | "not_found" | "denied"): number {
  if (code === "not_found") return ToolReturnCode.NotFound;
  if (code === "denied") return ToolReturnCode.PermissionDenied;
  return ToolReturnCode.InvalidArguments;
}

export function knowledgeMutationResult(
  tool: string,
  reason: string,
  sessionId: string | undefined,
  result: KnowledgeMutationResult,
): ToolExecuteResult {
  if (!result.ok) return failureResult(result.message, failureCode(result.code));
  const { doc } = result;
  agentLogInfo("knowledge.write", {
    tool,
    id: doc.id,
    source: doc.source,
    version: doc.version,
    reason,
    ...(sessionId ? { sessionId } : {}),
  });
  const what =
    doc.source === "override" && result.created ? "Created override of built-in" : result.created ? "Created" : "Updated";
  const guide = doc.guideFor.length > 0 ? ` Guide for: ${doc.guideFor.join(", ")}.` : "";
  return textResult(`${what} ${doc.id} (version ${doc.version}, ${doc.body.length} chars).${guide}`, ToolReturnCode.Success);
}

export function knowledgeDeleteResult(
  reason: string,
  sessionId: string | undefined,
  result: KnowledgeDeleteResult,
): ToolExecuteResult {
  if (!result.ok) return failureResult(result.message, failureCode(result.code));
  agentLogInfo("knowledge.delete", {
    id: result.id,
    reverted: result.reverted,
    reason,
    ...(sessionId ? { sessionId } : {}),
  });
  return textResult(
    result.reverted ? `Deleted the override; ${result.id} is back to the built-in version.` : `Deleted ${result.id}.`,
    ToolReturnCode.Success,
  );
}
