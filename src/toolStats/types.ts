import type { JsonObject } from "../session/types.js";
import type { ToolInvocationStatus } from "../session/db/toolInvocationRepository.js";

export type ToolInvocationReason =
  | "ok"
  | "unknown_tool"
  | "invalid_arguments_json"
  | "invalid_arguments_schema"
  | "bridge_resolve_failed"
  | "bridge_scope_denied"
  | "hook_denied"
  | "hook_ask_denied"
  | "full_permissions_required"
  | "user_denied"
  | "risk_blocked"
  | "ask_mode_denied"
  | "allowlist_denied"
  | "phase_disabled"
  | "exception"
  | "abort_before_start"
  | "abort_during_permission"
  | "abort_during_hook"
  | "abort_after_execute"
  | "abort_on_exception"
  | "abort_tool_call"
  | "handler";

export type ToolInvocationScene = {
  arguments?: JsonObject;
  argumentsRaw?: string;
  resultText?: string;
  errorMessage?: string;
  hookMessage?: string;
  permissionLevel?: 0 | 1 | 2;
};

export type RecordToolInvocationInput = {
  sessionId: string;
  parentSessionId?: string;
  subagentId?: string;
  toolCallId: string;
  name: string;
  status: ToolInvocationStatus;
  reason: ToolInvocationReason;
  returnCode?: number;
  startedAt: number;
  durationMs: number;
  scene?: ToolInvocationScene;
};

export { type ToolInvocationStatus };
