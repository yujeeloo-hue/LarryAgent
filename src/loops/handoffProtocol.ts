
import {
  isReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";

export const LOOPS_HANDOFF_SOCKET_NAME = "loops-handoff.sock";

export function loopsHandoffSocketPath(appDataRoot: string): string {
  return `${appDataRoot.replace(/\/+$/, "")}/${LOOPS_HANDOFF_SOCKET_NAME}`;
}

export type HandoffRequest =
  | { type: "ping" }
  | {
      type: "run";
      loopId: string;
      prompt: string;
      workspaceId: string;
      providerId: string;
      runMode: "agent" | "plan" | "ask";
      fullPermissions: boolean;
      reasoningEffort: ReasoningEffort;
    }
  | { type: "status"; sessionId: string }
  | { type: "watch"; sessionId: string }
  | { type: "cancel"; sessionId: string };

export type HandoffResponse =
  | { ok: true; ready: true }
  | { ok: true; sessionId: string; pid: number }
  | { ok: true; status: string; error?: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string };

export function parseHandoffResponse(text: string): HandoffResponse | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.ok !== true) {
    return typeof obj.error === "string"
      ? { ok: false, error: obj.error }
      : { ok: false, error: "handoff response error without message" };
  }
  if (obj.ready === true) return { ok: true, ready: true };
  if (typeof obj.sessionId === "string" && typeof obj.pid === "number") {
    return { ok: true, sessionId: obj.sessionId, pid: obj.pid };
  }
  if (obj.cancelled === true) return { ok: true, cancelled: true };
  if (typeof obj.status === "string") {
    return typeof obj.error === "string"
      ? { ok: true, status: obj.status, error: obj.error }
      : { ok: true, status: obj.status };
  }
  return null;
}

export function parseHandoffRequest(text: string): HandoffRequest | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  switch (obj.type) {
    case "ping":
      return { type: "ping" };
    case "run":
      if (
        typeof obj.loopId === "string" &&
        typeof obj.prompt === "string" &&
        typeof obj.workspaceId === "string" &&
        typeof obj.providerId === "string" &&
        (obj.runMode === "agent" ||
          obj.runMode === "plan" ||
          obj.runMode === "ask") &&
        typeof obj.fullPermissions === "boolean" &&
        (isReasoningEffort(obj.reasoningEffort) ||
          typeof obj.reasoningMax === "boolean")
      ) {
        return {
          type: "run",
          loopId: obj.loopId,
          prompt: obj.prompt,
          workspaceId: obj.workspaceId,
          providerId: obj.providerId,
          runMode: obj.runMode,
          fullPermissions: obj.fullPermissions,
          reasoningEffort: isReasoningEffort(obj.reasoningEffort)
            ? obj.reasoningEffort
            : obj.reasoningMax
              ? "max"
              : "low",
        };
      }
      return null;
    case "status":
    case "watch":
    case "cancel":
      return typeof obj.sessionId === "string"
        ? ({ type: obj.type, sessionId: obj.sessionId } as HandoffRequest)
        : null;
    default:
      return null;
  }
}
