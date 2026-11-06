import { ToolReturnCode } from "../session/returnCodes.js";
import { resolvePermissionLevel } from "./config.js";
import { getShellSafetyConfig } from "./policy/shellSafetyConfig.js";
import type {
  PermissionGateState,
  PermissionLevel,
  JsonObject,
  ToolRiskAssessment,
  ToolRiskAssessor,
  ToolRiskRewrite,
} from "./types.js";

/**
 * Level-2 confirmation timeout; deny on expiry (agent-turn rule).
 * Enforced by the gate implementation (session runtime) so the UI card dismisses.
 */
export const LEVEL2_CONFIRMATION_TIMEOUT_MS = 30_000;

export type PermissionDenialReason =
  | "full_permissions_required"
  | "user_denied"
  | "risk_blocked";

/** Human/model-facing detail attached to a denial (risk reason + hint). */
export type PermissionDenialDetail = {
  reason: string;
  hint?: string;
};

export type PermissionDecision =
  | {
      allowed: true;
      level: PermissionLevel;
      /** Trash rewrite instruction from an allow assessment, if any. */
      rewrite?: ToolRiskRewrite;
    }
  | {
      allowed: false;
      level: PermissionLevel;
      reason: PermissionDenialReason;
      detail?: PermissionDenialDetail;
    };

export async function checkToolPermission(input: {
  toolName: string;
  defaultLevel: PermissionLevel;
  arguments: JsonObject;
  gate: PermissionGateState;
  /** Optional content-aware assessor (Shell Safe Mode). */
  assessRisk?: ToolRiskAssessor;
  /** Workspace root forwarded to assessors for path resolution. */
  workspacePath?: string;
}): Promise<PermissionDecision> {
  const level = resolvePermissionLevel(input.toolName, input.defaultLevel);

  // --- Shell Safe Mode: content-aware assessment runs before level logic ---
  if (input.assessRisk && getShellSafetyConfig().enabled) {
    const assessment: ToolRiskAssessment = input.assessRisk({
      arguments: input.arguments,
      fullPermissionsEnabled: input.gate.fullPermissionsEnabled,
      ...(input.gate.reviewHighRisk ? { reviewHighRisk: true } : {}),
      ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    });
    if (assessment.action === "allow") {
      // Honor an explicit per-tool "Ask" override: the user chose to approve
      // every run of this tool, so no fast path — confirm, keep the rewrite.
      if (level === 2) {
        const approved = await input.gate.requestConfirmation({
          toolName: input.toolName,
          arguments: input.arguments,
          source: "ask_level",
        });
        if (!approved) {
          return {
            allowed: false,
            level,
            reason: "user_denied",
            detail: { reason: `${input.toolName} is set to Ask before every run` },
          };
        }
        return {
          allowed: true,
          level,
          ...(assessment.rewrite ? { rewrite: assessment.rewrite } : {}),
        };
      }
      return {
        allowed: true,
        level,
        ...(assessment.rewrite ? { rewrite: assessment.rewrite } : {}),
      };
    }
    if (assessment.action === "defer") {
      // fall through to the legacy matrix below
    } else if (assessment.action === "block") {
      return {
        allowed: false,
        level,
        reason: "risk_blocked",
        detail: {
          reason: assessment.reason,
          ...(assessment.hint ? { hint: assessment.hint } : {}),
        },
      };
    } else {
      // confirm — gate owns the 30s timeout + UI dismiss
      const approved = await input.gate.requestConfirmation({
        toolName: input.toolName,
        arguments: input.arguments,
        risk: {
          fatal: assessment.fatal,
          reason: assessment.reason,
          trashRewrite: assessment.rewrite?.type === "trash",
        },
        source: "shell_risk",
      });
      if (!approved) {
        return {
          allowed: false,
          level,
          reason: "user_denied",
          detail: {
            reason: assessment.reason,
            ...(assessment.hint ? { hint: assessment.hint } : {}),
          },
        };
      }
      return {
        allowed: true,
        level,
        ...(assessment.rewrite ? { rewrite: assessment.rewrite } : {}),
      };
    }
  }

  // --- Legacy level matrix (no assessor / Safe Mode disabled) ---
  if (level === 0) {
    return { allowed: true, level };
  }

  if (level === 1) {
    if (!input.gate.fullPermissionsEnabled) {
      return { allowed: false, level, reason: "full_permissions_required" };
    }
    return { allowed: true, level };
  }

  // level === 2 — gate owns the 30s timeout + UI dismiss
  const approved = await input.gate.requestConfirmation({
    toolName: input.toolName,
    arguments: input.arguments,
    source: "ask_level",
  });
  if (!approved) {
    return { allowed: false, level, reason: "user_denied" };
  }
  return { allowed: true, level };
}

export function permissionDeniedReturnCode(
  reason: PermissionDenialReason,
): number {
  if (reason === "user_denied") return ToolReturnCode.Cancelled;
  return ToolReturnCode.PermissionDenied;
}

/** Denial message for the model: base line + risk detail (reason — hint). */
export function permissionDeniedMessage(
  toolName: string,
  decision: Extract<PermissionDecision, { allowed: false }>,
): string {
  if (decision.reason === "full_permissions_required") {
    return `Permission denied: enable Bypass permissions to run ${toolName}. Call request_full_permissions to ask the user — the composer Permissions toggle alone does not update this in-flight turn.`;
  }
  const detail =
    decision.detail?.reason ??
    (decision.reason === "risk_blocked"
      ? "blocked by Shell Safe Mode"
      : "was not approved");
  const hint = decision.detail?.hint ? ` — ${decision.detail.hint}` : "";
  const base =
    decision.reason === "risk_blocked"
      ? `Permission denied: ${toolName} was blocked by Shell Safe Mode`
      : `Permission denied: ${toolName} was not approved`;
  return `${base} (${detail}${hint})`;
}
