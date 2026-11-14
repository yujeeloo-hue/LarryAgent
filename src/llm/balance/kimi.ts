import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderBalanceAdapter,
  ProviderBalanceProfile,
  ProviderBalanceQueryInput,
} from "./types.js";

/**
 * Kimi / Moonshot AI balance adapter.
 *
 * Endpoint: GET {base}/users/me/balance (bearer auth). Base URLs are typically
 * `https://api.moonshot.cn/v1` (CNY billing) or `https://api.moonshot.ai/v1`
 * (USD billing); the balance path always lives under /v1.
 *
 * Real response shape:
 *   { "code": 0, "status": true,
 *     "data": { "available_balance": 110.5061,
 *               "voucher_balance": 10.5061, "cash_balance": 100 } }
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

/** Billing currency follows the platform: .cn bills CNY, .ai bills USD. */
function balanceCurrency(baseUrl: string): string {
  try {
    return new URL(baseUrl.trim()).hostname.toLowerCase().endsWith(".cn")
      ? "CNY"
      : "USD";
  } catch {
    return "CNY";
  }
}

type KimiBalanceResponse = {
  code?: unknown;
  status?: unknown;
  data?: {
    available_balance?: unknown;
  } | null;
};

function formatAmount(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    // Trim float noise (110.5061 → "110.51", 100 → "100").
    return String(Math.round(raw * 100) / 100);
  }
  if (typeof raw === "string" && raw.trim()) return raw.trim();
  return null;
}

function formatKimiBalanceText(
  payload: KimiBalanceResponse,
  currency: string,
): string | null {
  if (typeof payload.code === "number" && payload.code !== 0) return null;
  if (payload.status === false) return null;
  const amount = formatAmount(payload.data?.available_balance);
  if (!amount) return null;
  return `Remaining balance: ${amount} ${currency}`;
}

export const kimiBalanceAdapter: ProviderBalanceAdapter = {
  id: "kimi",
  matches(provider: ProviderBalanceProfile): boolean {
    return balanceEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderBalanceQueryInput): Promise<string | null> {
    const endpoint = balanceEndpoint(input.baseUrl);
    if (!endpoint || !input.apiKey.trim()) return null;
    try {
      const response = await fetch(endpoint, {
        method: "GET",
        headers: withLlmUserAgent({
          Accept: "application/json",
          Authorization: `Bearer ${input.apiKey.trim()}`,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!response.ok) return null;
      const payload = (await response.json()) as KimiBalanceResponse;
      return formatKimiBalanceText(payload, balanceCurrency(input.baseUrl));
    } catch {
      return null;
    }
  },
};
