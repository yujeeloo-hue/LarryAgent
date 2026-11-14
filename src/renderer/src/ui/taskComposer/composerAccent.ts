/**
 * Composer identity colors: the selected run mode / custom graph tints the
 * composer border while it holds focus (CSS `:focus-within` gate), so the
 * active mode is readable without recoloring the resting frame. Auto keeps
 * the dynamic app tint (no override); custom graphs fall back to violet when
 * the stored color is absent or invalid. Values mirror the main-process
 * palette (src/agent/fsm/graphLibrary/types.ts) — keep them in sync.
 */
export const COMPOSER_MODE_COLORS = {
  ask: "#4c9dff",
  plan: "#f5a623",
} as const;

/** Fallback for custom graphs without a stored color. */
export const DEFAULT_CUSTOM_GRAPH_COLOR = "#a78bfa";

/** Resolve the composer border accent hex; null = keep the app tint (Auto). */
export function composerAccentColor(
  mode: "agent" | "ask" | "plan" | "custom",
  customGraphColor?: string | null,
): string | null {
  if (mode === "ask") return COMPOSER_MODE_COLORS.ask;
  if (mode === "plan") return COMPOSER_MODE_COLORS.plan;
  if (mode === "custom") {
    return normalizeHexColor(customGraphColor) ?? DEFAULT_CUSTOM_GRAPH_COLOR;
  }
  return null;
}

/** Normalize a color to lowercase `#rrggbb`, or null. */
export function normalizeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}
