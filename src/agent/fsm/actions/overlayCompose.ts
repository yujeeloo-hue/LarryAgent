import { joinOverlayParts } from "../../turnHost/phaseOverlayWire.js";
import type { RoleIterationSpec } from "../../roles/types.js";

/**
 * Explicit system placement adds the labeled body after the base persona.
 */
export function planRoleSystemPromptForPrefix(
  spec: Pick<RoleIterationSpec, "roleSystemPrompt" | "promptPlacement">,
): string | undefined {
  if ((spec.promptPlacement ?? "system") !== "system") return undefined;
  const text = spec.roleSystemPrompt.trim();
  return text.length > 0 ? text : undefined;
}

/**
 * Bucket0 extras: explicitly placed prompt body, then injected system blocks.
 */
export function composeBucket0SystemExtras(
  spec: Pick<
    RoleIterationSpec,
    "roleSystemPrompt" | "promptPlacement" | "systemInject"
  >,
): string | undefined {
  const planRole = planRoleSystemPromptForPrefix(spec);
  const inject = spec.systemInject?.trim();
  const joined = joinOverlayParts(planRole, inject);
  return joined.length > 0 ? joined : undefined;
}

/**
 * Explicit overlay placement precedes injected live fields on the wire tail.
 */
export function composeTrailingOverlay(
  spec: Pick<RoleIterationSpec, "roleSystemPrompt" | "promptPlacement" | "phaseOverlay">,
  overlayOverride?: string | null,
): string {
  const phase =
    typeof overlayOverride === "string" && overlayOverride.trim()
      ? overlayOverride
      : spec.phaseOverlay;
  return joinOverlayParts(spec.promptPlacement === "overlay" ? spec.roleSystemPrompt : undefined, phase);
}
