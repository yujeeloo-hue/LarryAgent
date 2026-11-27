import {
  CONTEXT_USAGE_CATEGORIES,
  parseContextInputTokens,
  parseContextUsageBreakdown,
  type ContextUsageBreakdown,
  type ContextUsageCategory,
} from "../../../shared/contextUsageBreakdown.js";

export type ContextUsageSource = "provider" | "estimate";

export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  cachedTokens?: number;
  inputTokens?: number | null;
  breakdown?: ContextUsageBreakdown;
  source?: ContextUsageSource;
};

export function isValidUsedTokens(
  value: unknown,
): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function shouldAcceptUsedTokens(
  previousUsed: number,
  incomingUsed: unknown,
): incomingUsed is number {
  if (!isValidUsedTokens(incomingUsed)) return false;
  if (incomingUsed === 0 && previousUsed > 0) return false;
  return true;
}

export function shouldAcceptContextUsage(previousUsed: number, incoming: Partial<ContextUsage>): boolean {
  return (incoming.source === "estimate" && incoming.usedTokens === 0) ||
    shouldAcceptUsedTokens(previousUsed, incoming.usedTokens);
}

export function normalizeContextUsage(usage: ContextUsage): ContextUsage {
  const limitTokens =
    typeof usage.limitTokens === "number" && usage.limitTokens > 0
      ? usage.limitTokens
      : 128_000;
  const usedTokens = isValidUsedTokens(usage.usedTokens)
    ? Math.max(0, usage.usedTokens)
    : 0;
  const normalized: ContextUsage = { usedTokens, limitTokens };
  if (
    typeof usage.cachedTokens === "number" &&
    Number.isFinite(usage.cachedTokens)
  ) {
    normalized.cachedTokens = Math.max(0, usage.cachedTokens);
  }
  if (usage.source === "provider" || usage.source === "estimate") {
    normalized.source = usage.source;
  }
  const inputTokens = parseContextInputTokens(usage.inputTokens);
  if (inputTokens !== undefined) normalized.inputTokens = inputTokens;
  const breakdown = parseContextUsageBreakdown(usage.breakdown);
  if (breakdown) normalized.breakdown = breakdown;
  return normalized;
}

export function mergeContextUsage(
  previous: ContextUsage,
  incoming: Partial<ContextUsage>,
): ContextUsage {
  const limitTokens =
    typeof incoming.limitTokens === "number" && incoming.limitTokens > 0
      ? incoming.limitTokens
      : previous.limitTokens > 0
        ? previous.limitTokens
        : 128_000;
  if (incoming.usedTokens !== undefined && !shouldAcceptContextUsage(previous.usedTokens, incoming)) {
    return { ...previous, limitTokens };
  }
  const replaceSnapshot = incoming.usedTokens !== undefined &&
    (incoming.source !== undefined || incoming.usedTokens !== previous.usedTokens);
  return normalizeContextUsage({
    ...(replaceSnapshot ? {} : previous),
    ...incoming,
    usedTokens: incoming.usedTokens ?? previous.usedTokens,
    limitTokens,
  });
}

export function contextUsageRatio(usage: ContextUsage): number {
  const normalized = normalizeContextUsage(usage);
  return Math.min(
    1,
    Math.max(0, normalized.usedTokens / normalized.limitTokens),
  );
}

export function formatTokenCount(tokens: number): string {
  const n = Math.max(0, tokens);
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function contextCacheHitRatio(usage: ContextUsage): number | undefined {
  if (usage.source === "estimate" || usage.inputTokens === null || usage.cachedTokens === undefined) {
    return undefined;
  }
  const input = usage.inputTokens ?? usage.usedTokens;
  return input > 0 ? Math.min(1, usage.cachedTokens / input) : undefined;
}

const contextUsageLabels: Record<ContextUsageCategory, string> = {
  toolActivity: "Tool calls & results",
  conversation: "Conversation",
  systemPrefix: "System prefix",
  compactedHistory: "Compacted history",
  toolDefinitions: "Tool definitions",
  skillPrompts: "Skill prompts",
  turnInjections: "Turn injections",
};

export type ContextUsageRow = {
  label: string;
  tokens: number;
};

export function contextUsageRows(usage: ContextUsage): { occupied: ContextUsageRow[]; estimated: boolean } {
  const used = Math.round(usage.usedTokens);
  if (used <= 0) return { occupied: [], estimated: false };
  if (!usage.breakdown || usage.inputTokens === null) {
    return { occupied: [{ label: "Used", tokens: used }], estimated: usage.source === "estimate" };
  }
  const categories = CONTEXT_USAGE_CATEGORIES.map((category) => ({
    label: contextUsageLabels[category],
    tokens: usage.breakdown?.[category] ?? 0,
  })).filter((row) => row.tokens > 0);
  const total = categories.reduce((sum, row) => sum + row.tokens, 0);
  if (!total) return { occupied: [{ label: "Used", tokens: used }], estimated: usage.source === "estimate" };
  // Scale the local proportions to the measured input, keeping the rounded rows additive.
  let weight = 0;
  let assigned = 0;
  const occupied = categories.map((row) => {
    weight += row.tokens;
    const next = Math.round(weight / total * used);
    const tokens = next - assigned;
    assigned = next;
    return { label: row.label, tokens };
  }).filter((row) => row.tokens > 0).sort((first, second) => second.tokens - first.tokens);
  return { occupied, estimated: true };
}

export function formatContextUsageLabel(usage: ContextUsage): string {
  const normalized = normalizeContextUsage(usage);
  const pct = Math.round(contextUsageRatio(normalized) * 100);
  const used = formatTokenCount(normalized.usedTokens);
  const limit = formatTokenCount(normalized.limitTokens);
  const parts = [`${pct}% · ${used} / ${limit} context used`];
  const cacheRatio = contextCacheHitRatio(normalized);
  if (cacheRatio) parts.push(`${Math.round(cacheRatio * 100)}% cached`);
  if (normalized.source === "estimate") {
    parts.push("estimated");
  }
  return parts.join(" · ");
}
