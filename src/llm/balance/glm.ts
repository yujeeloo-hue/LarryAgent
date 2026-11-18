import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderBalanceAdapter,
  ProviderBalanceProfile,
  ProviderBalanceQueryInput,
} from "./types.js";


function isGlmHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "open.bigmodel.cn" ||
    host.endsWith(".bigmodel.cn") ||
    host === "api.z.ai" ||
    host.endsWith(".z.ai")
  );
}

function quotaEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isGlmHost(url.hostname)) return null;
    return `${url.origin}/api/monitor/usage/quota/limit`;
  } catch {
    return null;
  }
}

const QUOTA_WINDOW_TYPES = new Set(["CREDIT_LIMIT", "TOKENS_LIMIT"]);

type GlmQuotaLimit = {
  type?: unknown;
  percentage?: unknown;
  nextResetTime?: unknown;
};

type GlmQuotaResponse = {
  data?: { limits?: unknown } | null;
};

function pickWeeklyLimit(limits: unknown[]): GlmQuotaLimit | null {
  const windows: { limit: GlmQuotaLimit; reset: number }[] = [];
  for (const item of limits) {
    if (typeof item !== "object" || item === null) continue;
    const limit = item as GlmQuotaLimit;
    if (
      typeof limit.type !== "string" ||
      !QUOTA_WINDOW_TYPES.has(limit.type) ||
      typeof limit.nextResetTime !== "number" ||
      !Number.isFinite(limit.nextResetTime)
    ) {
      continue;
    }
    windows.push({ limit, reset: limit.nextResetTime });
  }
  if (windows.length < 2) return null;
  windows.sort((a, b) => b.reset - a.reset);
  return windows[0]?.limit ?? null;
}

function formatGlmWeeklyText(limit: GlmQuotaLimit): string | null {
  const raw = limit.percentage;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const percent = Math.max(0, Math.min(100, Math.round(raw)));
  return `Weekly usage: ${percent}%`;
}

export const glmBalanceAdapter: ProviderBalanceAdapter = {
  id: "glm",
  matches(provider: ProviderBalanceProfile): boolean {
    return quotaEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderBalanceQueryInput): Promise<string | null> {
    const endpoint = quotaEndpoint(input.baseUrl);
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
      const payload = (await response.json()) as GlmQuotaResponse;
      const limits = payload?.data?.limits;
      if (!Array.isArray(limits)) return null;
      const weekly = pickWeeklyLimit(limits);
      if (!weekly) return null;
      return formatGlmWeeklyText(weekly);
    } catch {
      return null;
    }
  },
};
