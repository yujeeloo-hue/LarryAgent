import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageQueryInput,
  ProviderUsageSnapshot,
  UsageBar,
} from "./types.js";
import { clampPercent, formatCount, formatMoney, lenientNumber } from "./util.js";

/**
 * OpenRouter quota — two endpoints on the same host:
 *
 * - GET {origin}/api/v1/key — any API key. `limit` / `limit_remaining` are
 *   the key's own USD cap (null = unlimited). `usage_*` is spend. Optional
 *   `effective_budget` and `free_model_daily_requests`.
 * - GET {origin}/api/v1/credits — management keys only. Account balance is
 *   `total_credits - total_usage`. 403 here is normal for a regular key
 *   and does not fail the snapshot.
 *
 * The popup does not render `UsageBar.detail`, so amounts also go in `lines`.
 */

const OPENROUTER_ORIGIN = "https://openrouter.ai";

function isOpenRouterHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "openrouter.ai" || host.endsWith(".openrouter.ai");
}

function openRouterOrigin(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isOpenRouterHost(url.hostname)) return null;
    return OPENROUTER_ORIGIN;
  } catch {
    return null;
  }
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "openrouter",
    title: "OpenRouter",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

function titleCase(raw: string): string {
  const text = raw.trim();
  if (!text) return text;
  return text.charAt(0).toUpperCase() + text.slice(1);
}

type FetchJson =
  | { ok: true; payload: unknown }
  | { ok: false; status: number }
  | { ok: false; reason: "timeout" | "network" };

async function fetchJson(url: string, apiKey: string): Promise<FetchJson> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: withLlmUserAgent({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return { ok: false, status: response.status };
    try {
      return { ok: true, payload: await response.json() };
    } catch {
      return { ok: false, status: response.status };
    }
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "timeout"
        : "network";
    return { ok: false, reason };
  }
}

function dataRecord(payload: unknown): Record<string, unknown> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const data = (payload as { data?: unknown }).data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return null;
  }
  return data as Record<string, unknown>;
}

function usedPercent(used: number, total: number): number {
  if (total <= 0) return 0;
  return clampPercent(Math.round((used / total) * 1000) / 10);
}

function readCredits(payload: unknown): { purchased: number; used: number } | null {
  const data = dataRecord(payload);
  if (!data) return null;
  const purchased = lenientNumber(data.total_credits);
  const used = lenientNumber(data.total_usage);
  if (purchased === null || used === null) return null;
  return { purchased, used };
}

function snapshotFromKey(
  keyData: Record<string, unknown>,
  credits: { purchased: number; used: number } | null,
): ProviderUsageSnapshot | null {
  const bars: UsageBar[] = [];
  const lines: string[] = [];

  if (credits) {
    lines.push(`Balance: ${formatMoney(credits.purchased - credits.used)} USD`);
    lines.push(
      `Purchased: ${formatMoney(credits.purchased)} · Used: ${formatMoney(credits.used)}`,
    );
  }

  const limit = lenientNumber(keyData.limit);
  const remaining = lenientNumber(keyData.limit_remaining);
  const limitFieldPresent = "limit" in keyData || "limit_remaining" in keyData;
  if (limit !== null && limit > 0 && remaining !== null) {
    const used = Math.max(0, limit - remaining);
    const reset =
      typeof keyData.limit_reset === "string" ? keyData.limit_reset : "";
    bars.push({
      label: reset.trim() ? titleCase(reset) : "Limit",
      percent: usedPercent(used, limit),
    });
    lines.push(
      `Remaining: ${formatMoney(remaining)} / ${formatMoney(limit)} USD`,
    );
  } else if (
    limitFieldPresent &&
    limit === null &&
    remaining === null &&
    !credits
  ) {
    lines.push("Limit: unlimited");
  }

  const budget = keyData.effective_budget;
  if (typeof budget === "object" && budget !== null) {
    const record = budget as Record<string, unknown>;
    const budgetLimit = lenientNumber(record.limit_usd);
    const budgetRemaining = lenientNumber(record.remaining_usd);
    if (budgetLimit !== null && budgetLimit > 0 && budgetRemaining !== null) {
      const used = Math.max(0, budgetLimit - budgetRemaining);
      const interval =
        typeof record.reset_interval === "string"
          ? record.reset_interval.trim()
          : "";
      bars.push({
        label: "Budget",
        percent: usedPercent(used, budgetLimit),
      });
      const window = interval ? ` (${interval})` : "";
      // No " USD" here: the section's Balance line already states the
      // currency, and the caption column fits only so many glyphs.
      lines.push(
        `Budget: ${formatMoney(budgetRemaining)}/${formatMoney(budgetLimit)} left${window}`,
      );
    }
  }

  const daily = lenientNumber(keyData.usage_daily);
  const weekly = lenientNumber(keyData.usage_weekly);
  const monthly = lenientNumber(keyData.usage_monthly);
  if (daily !== null || weekly !== null || monthly !== null) {
    // One rotating line has ~212px of column at the Windows card width;
    // "today/week/month" spelled out overflowed it, the day/week/month
    // initials keep all three numbers and the currency.
    lines.push(
      `d/w/m: ${formatMoney(daily ?? 0)}/${formatMoney(weekly ?? 0)}/${formatMoney(monthly ?? 0)} USD`,
    );
  } else {
    const usage = lenientNumber(keyData.usage);
    if (usage !== null) lines.push(`Used: ${formatMoney(usage)} USD`);
  }

  const free = keyData.free_model_daily_requests;
  if (typeof free === "object" && free !== null) {
    const record = free as Record<string, unknown>;
    const freeLimit = lenientNumber(record.limit);
    const freeRemaining = lenientNumber(record.remaining);
    if (freeLimit !== null && freeLimit > 0 && freeRemaining !== null) {
      const used =
        lenientNumber(record.used) ?? Math.max(0, freeLimit - freeRemaining);
      bars.push({
        label: "Free",
        percent: usedPercent(used, freeLimit),
      });
      lines.push(
        `Free models today: ${formatCount(freeRemaining)} / ${formatCount(freeLimit)}`,
      );
    }
  }

  if (bars.length === 0 && lines.length === 0) return null;
  return {
    key: "openrouter",
    title: "OpenRouter",
    // Conditional spread: `badge?: string` under exactOptionalPropertyTypes
    // rejects an explicit undefined.
    ...(keyData.is_free_tier === true ? { badge: "Free" } : {}),
    bars,
    lines,
    fetchedAt: Date.now(),
  };
}

export const openrouterUsageAdapter: ProviderUsageAdapter = {
  key: "openrouter",
  matches(provider: ProviderUsageProfile): boolean {
    return openRouterOrigin(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const origin = openRouterOrigin(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!origin || !apiKey) return errorSnapshot("Not configured");
    const keyUrl = `${origin}/api/v1/key`;
    const creditsUrl = `${origin}/api/v1/credits`;
    const [keyResult, creditsResult] = await Promise.all([
      fetchJson(keyUrl, apiKey),
      fetchJson(creditsUrl, apiKey),
    ]);
    if (!keyResult.ok) {
      if ("reason" in keyResult) {
        return errorSnapshot(
          keyResult.reason === "timeout" ? "Request timed out" : "Request failed",
        );
      }
      return errorSnapshot(`Request failed (HTTP ${keyResult.status})`);
    }
    const keyData = dataRecord(keyResult.payload);
    if (!keyData) return errorSnapshot("No balance data");
    const credits = creditsResult.ok ? readCredits(creditsResult.payload) : null;
    return snapshotFromKey(keyData, credits) ?? errorSnapshot("No balance data");
  },
};
