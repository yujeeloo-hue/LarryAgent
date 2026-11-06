import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageQueryInput,
  ProviderUsageSnapshot,
} from "./types.js";
import { formatMoney, lenientNumber } from "./util.js";

/**
 * Kimi / Moonshot AI platform balance — GET {base}/users/me/balance.
 *
 * URL construction mirrors src/llm/balance/kimi.ts exactly (baseUrl may or
 * may not already end with /v1). Success is `status==true || code==0`.
 * .cn bills CNY, .ai bills USD. A `sk-kimi-` prefixed key here is a Kimi
 * Code membership key and will always 401 on this endpoint — say so.
 */

function isMoonshotHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "api.moonshot.cn" ||
    host.endsWith(".moonshot.cn") ||
    host === "api.moonshot.ai" ||
    host.endsWith(".moonshot.ai")
  );
}

function balanceEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isMoonshotHost(url.hostname)) return null;
    const base = baseUrl.trim().replace(/\/+$/, "");
    return base.endsWith("/v1")
      ? `${base}/users/me/balance`
      : `${url.origin}/v1/users/me/balance`;
  } catch {
    return null;
  }
}

function balanceCurrency(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().endsWith(".cn")
      ? "CNY"
      : "USD";
  } catch {
    return "CNY";
  }
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "kimi",
    title: "Kimi",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

export const kimiUsageAdapter: ProviderUsageAdapter = {
  key: "kimi",
  matches(provider: ProviderUsageProfile): boolean {
    return balanceEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const endpoint = balanceEndpoint(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!endpoint || !apiKey) return errorSnapshot("Not configured");
    if (apiKey.startsWith("sk-kimi-")) {
      return errorSnapshot(
        "This is a Kimi Code key — the balance endpoint needs a platform key",
      );
    }
    const currency = balanceCurrency(input.baseUrl);
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
      const ok = payload?.status === true || payload?.code === 0;
      if (!ok) {
        const code = lenientNumber(payload?.code);
        return errorSnapshot(
          `Unexpected response code ${code !== null ? code : "unknown"}`,
        );
      }
      const data = (payload?.data ?? null) as Record<string, unknown> | null;
      const available = lenientNumber(data?.available_balance);
      if (!data || available === null) return errorSnapshot("No balance data");
      const cash = lenientNumber(data.cash_balance) ?? 0;
      const voucher = lenientNumber(data.voucher_balance) ?? 0;
      return {
        key: "kimi",
        title: "Kimi",
        bars: [],
        lines: [
          `Available: ${formatMoney(available)} ${currency}`,
          `Top-up: ${formatMoney(cash)} · Voucher: ${formatMoney(voucher)}`,
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
