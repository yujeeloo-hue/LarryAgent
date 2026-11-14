/**
 * Shared helpers for Host-backed NodeActions.
 */

import type { RoleContext, RoleKind } from "../../roles/types.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { NodeContext, TurnContext } from "../types.js";
import type { TurnScope } from "../turnScope.js";

export function scopeOf(turnContext: TurnContext): TurnScope {
  const scope = turnContext.turnScope as TurnScope | undefined;
  if (!scope || typeof scope !== "object") {
    throw new Error("Missing turnScope on TurnContext");
  }
  return scope;
}

export function roleContextOf(
  host: FsmHostCapabilities,
  turnContext: TurnContext,
): RoleContext {
  const scope = scopeOf(turnContext);
  return {
    state: scope.turnState,
    session: host.session,
    gate: host.gate,
    plan: scope.plan,
    createId: host.createId,
    resolveProviderBinding: (providerId) => {
      const trimmed = providerId.trim();
      if (!trimmed) return null;
      return scope.llmBundle.byProviderId[trimmed] ?? null;
    },
    resetTurnBudgetsAfterPlanProgress: (reason) =>
      host.resetTurnBudgets(reason),
    ...(host.signal ? { signal: host.signal } : {}),
    ...(host.onEvent ? { onEvent: host.onEvent } : {}),
  };
}

export function roleKindFromContext(nodeContext: NodeContext): RoleKind {
  const raw = nodeContext.roleKind;
  if (typeof raw === "string" && raw.trim().length > 0) {
    return raw.trim();
  }
  return "agent";
}

export function asToolCalls(value: unknown): import("../../../session/types.js").ToolCallPart[] {
  return Array.isArray(value)
    ? (value as import("../../../session/types.js").ToolCallPart[])
    : [];
}
