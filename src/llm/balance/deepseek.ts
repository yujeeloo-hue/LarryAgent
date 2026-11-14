import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderBalanceAdapter,
  ProviderBalanceProfile,
  ProviderBalanceQueryInput,
} from "./types.js";

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

type DeepSeekBalanceInfo = {
  currency?: unknown;
  total_balance?: unknown;
};

type DeepSeekBalanceResponse = {
  is_available?: unknown;
  balance_infos?: unknown;
};

function pickBalanceInfo(
  infos: DeepSeekBalanceInfo[],
): DeepSeekBalanceInfo | null {
  if (infos.length === 0) return null;
  const cny = infos.find(
    (item) =>
      typeof item.currency === "string" &&
      item.currency.trim().toUpperCase() === "CNY",
  );
  if (cny) return cny;
  const usd = infos.find(
    (item) =>
      typeof item.currency === "string" &&
      item.currency.trim().toUpperCase() === "USD",
  );
  if (usd) return usd;
  return infos[0] ?? null;
}

function formatDeepSeekBalanceText(payload: DeepSeekBalanceResponse): string | null {
  if (!Array.isArray(payload.balance_infos)) return null;
  const infos = payload.balance_infos.filter(
    (item): item is DeepSeekBalanceInfo =>
      typeof item === "object" && item !== null,
  );
  const picked = pickBalanceInfo(infos);
  if (!picked) return null;
  const currency =
    typeof picked.currency === "string" && picked.currency.trim()
      ? picked.currency.trim().toUpperCase()
      : "CNY";
  const raw = picked.total_balance;
  const amount =
    typeof raw === "number" && Number.isFinite(raw)
      ? String(raw)
      : typeof raw === "string" && raw.trim()
        ? raw.trim()
        : null;
  if (!amount) return null;
  return `Remaining balance: ${amount} ${currency}`;
}

export const deepseekBalanceAdapter: ProviderBalanceAdapter = {
  id: "deepseek",
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
      const payload = (await response.json()) as DeepSeekBalanceResponse;
      return formatDeepSeekBalanceText(payload);
    } catch {
      return null;
    }
  },
};
