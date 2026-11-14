export type ContextUsageSource = "provider" | "estimate";

export type ContextUsage = {
  usedTokens: number;
  limitTokens: number;
  /** Provider prompt-cache hit tokens when reported. */
  cachedTokens?: number;
  /** Whether usedTokens is from provider usage or a local estimate.
   * Display is provider-only: the composer ring never shows estimates. */
  source?: ContextUsageSource;
};

export function isValidUsedTokens(
  value: unknown,
): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Whether an incoming used-token count should replace the displayed value.
 * Treat bare 0 as "unknown / unset" when we already have a positive reading,
 * so mid-stream zero usage events (or unset session fields) do not clear the ring.
 */
export function shouldAcceptUsedTokens(
  previousUsed: number,
  incomingUsed: unknown,
): incomingUsed is number {
  if (!isValidUsedTokens(incomingUsed)) return false;
  if (incomingUsed === 0 && previousUsed > 0) return false;
  return true;
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
  return normalized;
}

/** Keep the last displayed used-token count when the incoming value is missing or a stale 0. */
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
  const usedTokens = shouldAcceptUsedTokens(
    previous.usedTokens,
    incoming.usedTokens,
  )
    ? Math.max(0, incoming.usedTokens)
    : previous.usedTokens;
  const merged: ContextUsage = { usedTokens, limitTokens };

  if (incoming.source === "provider") {
    merged.source = "provider";
    if (
      typeof incoming.cachedTokens === "number" &&
      Number.isFinite(incoming.cachedTokens)
    ) {
      merged.cachedTokens = Math.max(0, incoming.cachedTokens);
    }
  } else if (incoming.source === "estimate") {
    merged.source = "estimate";
    if (
      typeof incoming.cachedTokens === "number" &&
      Number.isFinite(incoming.cachedTokens)
    ) {
      merged.cachedTokens = Math.max(0, incoming.cachedTokens);
    } else if (typeof previous.cachedTokens === "number") {
      merged.cachedTokens = previous.cachedTokens;
    }
  } else {
    if (
      typeof incoming.cachedTokens === "number" &&
      Number.isFinite(incoming.cachedTokens)
    ) {
      merged.cachedTokens = Math.max(0, incoming.cachedTokens);
    } else if (typeof previous.cachedTokens === "number") {
      merged.cachedTokens = previous.cachedTokens;
    }
    if (previous.source) {
      merged.source = previous.source;
    }
  }

  return merged;
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
  // Keep one decimal through the K range so live ring tips move during streaming
  // (whole-K rounding hid ~1–999 token changes above 10K).
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** English hover copy for the context usage ring. */
export function formatContextUsageLabel(usage: ContextUsage): string {
  const normalized = normalizeContextUsage(usage);
  const pct = Math.round(contextUsageRatio(normalized) * 100);
  const used = formatTokenCount(normalized.usedTokens);
  const limit = formatTokenCount(normalized.limitTokens);
  const parts = [`${pct}% · ${used} / ${limit} context used`];
  if (typeof normalized.cachedTokens === "number") {
    const cachePct =
      normalized.usedTokens > 0
        ? Math.round(
            (Math.min(normalized.cachedTokens, normalized.usedTokens) /
              normalized.usedTokens) *
              100,
          )
        : 0;
    if (cachePct > 0) {
      parts.push(`${cachePct}% cached`);
    }
  }
  // Ring values are provider-only (usage events / persisted provider
  // readings) — the one exception is the labeled /compact projection.
  if (normalized.source === "estimate") {
    parts.push("estimated");
  }
  return parts.join(" · ");
}
