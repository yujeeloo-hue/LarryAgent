import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageQueryInput,
  ProviderUsageSnapshot,
} from "./types.js";

/**
 * DeepSeek balance — GET {origin}/user/balance (Bearer).
 * balance_infos[] amounts are strings; CNY entry preferred, then USD.
 * Ported from CursorUsage Sources/Shared/DeepSeekAPI.swift.
 */

function isDeepSeekHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "api.deepseek.com" || host.endsWith(".deepseek.com");
}

function balanceEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isDeepSeekHost(url.hostname)) return null;
    return `${url.origin}/user/balance`;
  } catch {
    return null;
  }
}

type BalanceInfo = {
  currency: string;
  total: string;
  granted: string;
  toppedUp: string;
};

function readBalanceInfo(raw: unknown): BalanceInfo | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  const total =
    typeof record.total_balance === "string" ? record.total_balance.trim() : "";
  if (!total) return null;
  return {
    currency:
      typeof record.currency === "string" && record.currency.trim()
        ? record.currency.trim().toUpperCase()
        : "CNY",
    total,
    granted:
      typeof record.granted_balance === "string"
        ? record.granted_balance.trim()
        : "0",
    toppedUp:
      typeof record.topped_up_balance === "string"
        ? record.topped_up_balance.trim()
        : "0",
  };
}

function pickBalanceInfo(infos: BalanceInfo[]): BalanceInfo | null {
  if (infos.length === 0) return null;
  return (
    infos.find((info) => info.currency === "CNY") ??
    infos.find((info) => info.currency === "USD") ??
    infos[0] ??
    null
  );
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "deepseek",
    title: "DeepSeek",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

export const deepseekUsageAdapter: ProviderUsageAdapter = {
  key: "deepseek",
  matches(provider: ProviderUsageProfile): boolean {
    return balanceEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const endpoint = balanceEndpoint(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!endpoint || !apiKey) return errorSnapshot("Not configured");
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: withLlmUserAgent({
          Accept: "application/json",
          Authorization: `Bearer ${apiKey}`,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) {
        return errorSnapshot(`Request failed (HTTP ${response.status})`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const rawInfos = Array.isArray(payload?.balance_infos)
        ? payload.balance_infos
        : [];
      const infos = rawInfos
        .map(readBalanceInfo)
        .filter((info): info is BalanceInfo => info !== null);
      const picked = pickBalanceInfo(infos);
      if (!picked) return errorSnapshot("No balance data");
      return {
        key: "deepseek",
        title: "DeepSeek",
        bars: [],
        lines: [
          `Balance: ${picked.total} ${picked.currency}`,
          `Top-up: ${picked.toppedUp} · Granted: ${picked.granted}`,
        ],
        fetchedAt: Date.now(),
      };
    } catch (error) {
      const reason =
        error instanceof Error && error.name === "TimeoutError"
          ? "Request timed out"
          : "Request failed";
      return errorSnapshot(reason);
    }
  },
};
