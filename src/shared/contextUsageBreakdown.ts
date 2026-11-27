export const CONTEXT_USAGE_CATEGORIES = [
  "toolActivity",
  "conversation",
  "systemPrefix",
  "compactedHistory",
  "toolDefinitions",
  "skillPrompts",
  "turnInjections",
] as const;

export type ContextUsageCategory = (typeof CONTEXT_USAGE_CATEGORIES)[number];
export type ContextUsageBreakdown = Partial<Record<ContextUsageCategory, number>>;

export function parseContextInputTokens(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  return undefined;
}

export function parseContextUsageBreakdown(value: unknown): ContextUsageBreakdown | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const breakdown: ContextUsageBreakdown = {};
  for (const category of CONTEXT_USAGE_CATEGORIES) {
    const tokens = record[category];
    if (typeof tokens === "number" && Number.isFinite(tokens) && tokens > 0) {
      breakdown[category] = tokens;
    }
  }
  return Object.keys(breakdown).length ? breakdown : undefined;
}
