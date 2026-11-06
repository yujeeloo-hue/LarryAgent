import type { JsonObject, ToolResultContentPart } from "../session/types.js";
import type {
  HookDecision,
  HookPermission,
  MergedHookResult,
} from "./types.js";

export function emptyMergedResult(): MergedHookResult {
  return {
    permission: "allow",
    denied: false,
  };
}

function normalizePermission(
  value: unknown,
): HookPermission | undefined {
  if (value === "allow" || value === "deny" || value === "ask") {
    return value;
  }
  return undefined;
}

/**
 * Parse stdout / in-process return into a HookDecision (unknown fields ignored).
 */
export function parseHookDecision(raw: unknown): HookDecision {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  const obj = raw as Record<string, unknown>;
  const decision: HookDecision = {};

  const permission = normalizePermission(obj.permission);
  if (permission) decision.permission = permission;

  if (
    obj.updated_input &&
    typeof obj.updated_input === "object" &&
    !Array.isArray(obj.updated_input)
  ) {
    decision.updated_input = obj.updated_input as JsonObject;
  }

  if (typeof obj.updated_prompt === "string") {
    decision.updated_prompt = obj.updated_prompt;
  }

  if (typeof obj.additional_context === "string") {
    decision.additional_context = obj.additional_context;
  }

  if (typeof obj.updated_mcp_tool_output === "string") {
    decision.updated_mcp_tool_output = obj.updated_mcp_tool_output;
  } else if (Array.isArray(obj.updated_mcp_tool_output)) {
    decision.updated_mcp_tool_output =
      obj.updated_mcp_tool_output as ToolResultContentPart[];
  }

  if (typeof obj.user_message === "string") {
    decision.user_message = obj.user_message;
  }
  if (typeof obj.agent_message === "string") {
    decision.agent_message = obj.agent_message;
  }

  return decision;
}

/**
 * Merge one decision into the accumulator.
 * - deny stops further hooks (caller checks `denied`)
 * - ask wins over allow
 * - rewrites / context: last-write-wins for scalars; context strings concatenate
 */
export function mergeHookDecision(
  acc: MergedHookResult,
  decision: HookDecision,
): MergedHookResult {
  const next: MergedHookResult = { ...acc };

  if (decision.permission === "deny") {
    next.permission = "deny";
    next.denied = true;
  } else if (decision.permission === "ask" && next.permission !== "deny") {
    next.permission = "ask";
  }

  if (decision.updated_input) {
    next.updatedInput = decision.updated_input;
  }
  if (typeof decision.updated_prompt === "string") {
    next.updatedPrompt = decision.updated_prompt;
  }
  if (typeof decision.additional_context === "string") {
    const piece = decision.additional_context.trim();
    if (piece) {
      next.additionalContext = next.additionalContext
        ? `${next.additionalContext}\n${piece}`
        : piece;
    }
  }
  if (decision.updated_mcp_tool_output !== undefined) {
    next.updatedMcpToolOutput = decision.updated_mcp_tool_output;
  }
  if (typeof decision.user_message === "string") {
    next.userMessage = decision.user_message;
  }
  if (typeof decision.agent_message === "string") {
    next.agentMessage = decision.agent_message;
  }

  return next;
}

export function applyDenyFailure(
  acc: MergedHookResult,
  message?: string,
): MergedHookResult {
  return mergeHookDecision(acc, {
    permission: "deny",
    ...(message ? { agent_message: message } : {}),
  });
}
