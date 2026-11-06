import type { JsonObject, ToolApprovalRisk, ToolConfirmationSource } from "../tools/types.js";

/**
 * Supervisory tool approvals: the question CoCo's decide model answers for a
 * pending confirmation, and the verdict parse. Fatal Shell findings never
 * reach the model — they always go to the user.
 */

export const TOOL_APPROVAL_OPTIONS = ["Approve", "Deny"] as const;

export type ToolApprovalRequest = {
  toolName: string;
  arguments: JsonObject;
  risk?: ToolApprovalRisk | undefined;
  source?: ToolConfirmationSource | undefined;
};

const ARGUMENTS_CHARS = 2500;
const GOAL_CHARS = 600;

const SOURCE_LINES: Record<ToolConfirmationSource, string> = {
  ask_level: "The user set this tool to ask before every run.",
  shell_risk: "Shell Safe Mode flagged this command as high risk.",
  hook_ask: "A user-configured hook asked for confirmation.",
};

/** True when the request must go to the user, never to the supervisor. */
export function requiresUserApproval(request: ToolApprovalRequest): boolean {
  return request.risk?.fatal === true;
}

export function toolApprovalQuestion(request: ToolApprovalRequest, goal?: string): string {
  const source = request.source ?? (request.risk ? "shell_risk" : "ask_level");
  const args = JSON.stringify(request.arguments);
  const lines = [
    `Tool approval: the supervised session wants to run "${request.toolName}". Approve only if it serves the delegated goal and stays within it; Deny lets the session continue without it.`,
    `Why confirmation is needed: ${SOURCE_LINES[source]}`,
    ...(request.risk?.reason ? [`Risk: ${request.risk.reason}`] : []),
    ...(request.risk?.trashRewrite ? ["Deletions run as a move to the Trash (recoverable)."] : []),
    ...(goal?.trim() ? [`Saved goal: ${goal.trim().slice(0, GOAL_CHARS)}`] : []),
    `Arguments: ${args.length > ARGUMENTS_CHARS ? `${args.slice(0, ARGUMENTS_CHARS)}…` : args}`,
  ];
  return lines.join("\n");
}

/** Approve → true, Deny → false, anything else → "needs-user". */
export function parseToolApproval(result: unknown): boolean | "needs-user" {
  const r = result && typeof result === "object" ? result as { action?: unknown; answer?: unknown; selections?: unknown } : {};
  if (r.action !== "answer") return "needs-user";
  const picked = Array.isArray(r.selections) ? String(r.selections[0] ?? "") : typeof r.answer === "string" ? r.answer : "";
  if (picked === "Approve") return true;
  if (picked === "Deny") return false;
  return "needs-user";
}
