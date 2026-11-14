/**
 * Executable decision graph (EDG) — guarded reuse of shell commands the model
 * already decided on (HarnessMM-style, linear chain only).
 *
 * Model round: the shell call carries `then: string[]` → Edg admit stores the
 * bank on turnContext. Reuse rounds: Edg dispatch replays the next command as
 * a synthetic tool call; Edg admit checks the structured receipt before the
 * following one. Any failed guard / exhaustion / steer returns to the model.
 */

import type { JsonObject } from "../../../session/types.js";
import type { ToolCallReceipt } from "../../runTools.js";
import type { NodeContext, TurnContext } from "../types.js";

/** Optional shell-tool argument the model fills with follow-up commands. */
export const EDG_THEN_PARAM = "then";
/** Route event: the next banked command is eligible. */
export const EDG_REUSE_EVENT = "edg_reuse";
export const EDG_DEFAULT_MAX_STEPS = 6;
export const EDG_MAX_STEPS_CAP = 8;
export const EDG_MAX_COMMAND_CHARS = 4_000;

/** turnContext slot — survives node visits within the turn only. */
export type EdgBank = {
  rootCallId: string;
  toolName: string;
  commands: string[];
  /** Index of the next command to dispatch. */
  next: number;
};

/** nodeContext slot written by Edg plan schema on model rounds. */
export type EdgPlanOffered = { toolName: string; maxSteps: number };

/** nodeContext slot written by Edg dispatch on reuse rounds. */
export type EdgDispatched = { callId: string; index: number; command: string };

export function readEdgBank(turnContext: TurnContext): EdgBank | null {
  const raw = turnContext.edgBank as EdgBank | null | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (!Array.isArray(raw.commands) || typeof raw.next !== "number") return null;
  return raw;
}

export function readEdgPlanOffered(nodeContext: NodeContext): EdgPlanOffered | null {
  const raw = nodeContext.edgPlanOffered as EdgPlanOffered | undefined;
  return raw && typeof raw.toolName === "string" ? raw : null;
}

export function readEdgDispatched(nodeContext: NodeContext): EdgDispatched | null {
  const raw = nodeContext.edgDispatched as EdgDispatched | undefined;
  return raw && typeof raw.callId === "string" ? raw : null;
}

export function clampEdgMaxSteps(value: number): number {
  if (!Number.isFinite(value)) return EDG_DEFAULT_MAX_STEPS;
  return Math.min(EDG_MAX_STEPS_CAP, Math.max(1, Math.floor(value)));
}

/** Non-empty trimmed commands from a `then` argument, capped at maxSteps. */
export function parseEdgThen(value: unknown, maxSteps: number): string[] {
  if (!Array.isArray(value)) return [];
  const commands: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const command = item.trim();
    if (!command || command.length > EDG_MAX_COMMAND_CHARS) continue;
    commands.push(command);
    if (commands.length >= maxSteps) break;
  }
  return commands;
}

export function asToolReceipts(value: unknown): ToolCallReceipt[] {
  return Array.isArray(value)
    ? (value as ToolCallReceipt[]).filter(
        (r) => r && typeof r === "object" && typeof r.toolCallId === "string",
      )
    : [];
}

export type EdgGuardResult =
  | { pass: true }
  | { pass: false; reason: "receipt_missing" | "tool_failed" | "exit_code" | "timed_out" };

/** Deterministic guard on one call's structured shell receipt. */
export function checkEdgGuard(
  receipt: ToolCallReceipt | undefined,
  expectedExitCode: number,
): EdgGuardResult {
  if (!receipt) return { pass: false, reason: "receipt_missing" };
  const facts = receipt.receipt as JsonObject | undefined;
  if (!facts) return { pass: false, reason: "receipt_missing" };
  if (facts.timedOut === true) return { pass: false, reason: "timed_out" };
  if (facts.exitCode !== expectedExitCode) return { pass: false, reason: "exit_code" };
  if (receipt.returnCode !== 0 && expectedExitCode === 0) {
    return { pass: false, reason: "tool_failed" };
  }
  return { pass: true };
}

/** Schema for the `then` argument added to the shell tool. */
export function edgThenSchema(maxSteps: number): JsonObject {
  return {
    type: "array",
    maxItems: maxSteps,
    items: { type: "string" },
    description:
      `Optional. Up to ${maxSteps} NEXT steps the runtime runs for you, one at a time, after this ` +
      "command — each ONLY if the previous one exited 0 (success). It is not a fallback or retry " +
      "list: entries never run when this command fails, so never put alternatives, `||` recovery " +
      "chains, or a retry of this command here. Use it only when every command is fully known now " +
      "and you would run it no matter what the earlier output says (e.g. build → test → git diff " +
      "--stat). On any non-zero exit, timeout, or the end of the list you get control back with " +
      "every result. Omit it when the next step depends on reading output.",
  };
}
