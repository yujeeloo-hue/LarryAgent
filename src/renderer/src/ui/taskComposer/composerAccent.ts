export const COMPOSER_MODE_COLORS = {
  ask: "#4c9dff",
  plan: "#f5a623",
} as const;

export const DEFAULT_CUSTOM_GRAPH_COLOR = "#a78bfa";

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

export function normalizeHexColor(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : null;
}
