/**
 * Wire protocol for the Loops App-handoff unix socket
 * (`{appData}/loops-handoff.sock`).
 *
 * Daemon → App, one newline-delimited JSON request per connection, one JSON
 * response, then the App closes the socket. Security relies on filesystem
 * permissions of the app-data directory (same-user only); no token.
 *
 * Shared by the daemon-side client (src/loops/appHandoff.ts) and the App-side
 * server (src/main/loops/handoffServer.ts). Pure types + parsing — no I/O.
 */

import {
  isReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";

export const LOOPS_HANDOFF_SOCKET_NAME = "loops-handoff.sock";

export function loopsHandoffSocketPath(appDataRoot: string): string {
  // POSIX-only feature (macOS); forward join is correct.
  return `${appDataRoot.replace(/\/+$/, "")}/${LOOPS_HANDOFF_SOCKET_NAME}`;
}

/** Request the daemon sends. */
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
  | { type: "cancel"; sessionId: string };

/** Response the App sends back. `ok:false` never implies a run started. */
export type HandoffResponse =
  | { ok: true; ready: true }
  | { ok: true; sessionId: string; pid: number }
  | { ok: true; status: string; error?: string }
  | { ok: true; cancelled: true }
  | { ok: false; error: string };

/** Parse one wire line into a HandoffResponse; null when malformed. */
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

/** Parse one wire line into a HandoffRequest; null when malformed. */
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
          // Legacy daemons still send the Max boolean — map it onto the dial.
          reasoningEffort: isReasoningEffort(obj.reasoningEffort)
            ? obj.reasoningEffort
            : obj.reasoningMax
              ? "max"
              : "low",
        };
      }
      return null;
    case "status":
    case "cancel":
      return typeof obj.sessionId === "string"
        ? ({ type: obj.type, sessionId: obj.sessionId } as HandoffRequest)
        : null;
    default:
      return null;
  }
}
