import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageQueryInput,
  ProviderUsageSnapshot,
} from "./types.js";
import {
  clampPercent,
  formatCount,
  formatResetTime,
  lenientNumber,
  parseEpochMs,
} from "./util.js";

/**
 * GLM Coding Plan quota — GET {origin}/api/monitor/usage/quota/limit.
 *
 * Ported from CursorUsage Sources/Shared/GLMCodingAPI.swift. Auth header is
 * the RAW key without a Bearer prefix (that project's measured behavior);
 * on 401 we retry once with `Bearer` as a fallback since JellyBot's balance
 * adapter historically used Bearer.
 *
 * Window identification: 5h = number==5 && unit==3 (hours), weekly =
 * unit==6 || number==1. NEVER sort by nextResetTime — the weekly window can
 * reset before the 5h one in the wild. Fallback: min/max of total credits.
 */

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

type GlmLimit = {
  total: number;
  used: number;
  remaining: number;
  percent: number;
  nextReset: Date | null;
};

type RawLimit = {
  type: string | null;
  unit: number | null;
  number: number | null;
  usage: number | null;
  currentValue: number | null;
  remaining: number | null;
  percentage: number | null;
  nextResetTime: number | null;
};

function readLimit(raw: unknown): RawLimit | null {
  if (typeof raw !== "object" || raw === null) return null;
  const record = raw as Record<string, unknown>;
  return {
    type: typeof record.type === "string" ? record.type : null,
    unit: lenientNumber(record.unit),
    number: lenientNumber(record.number),
    usage: lenientNumber(record.usage),
    currentValue: lenientNumber(record.currentValue),
    remaining: lenientNumber(record.remaining),
    percentage: lenientNumber(record.percentage),
    nextResetTime: lenientNumber(record.nextResetTime),
  };
}

function makeLimit(limit: RawLimit): GlmLimit {
  const total = limit.usage ?? 0;
  const used = limit.currentValue ?? 0;
  // Percent is self-computed — the response `percentage` field has drifted.
  // One decimal place for display (kills float noise).
  const percent = total > 0 ? (used / total) * 100 : (limit.percentage ?? 0);
  return {
    total,
    used,
    remaining: limit.remaining ?? Math.max(0, total - used),
    percent: clampPercent(Math.round(percent * 10) / 10),
    nextReset: parseEpochMs(limit.nextResetTime),
  };
}

/** 5h = number 5 & unit 3 (hours); weekly = unit 6 or number 1. Distinct indexes. */
export function pickGlmWindows(
  credits: RawLimit[],
): { fiveHour: RawLimit; weekly: RawLimit } | null {
  if (credits.length < 2) return null;
  const totals = credits.map((c) => c.usage ?? 0);
  const minTotal = Math.min(...totals);
  const maxTotal = Math.max(...totals);
  const fiveHourIdx =
    credits.findIndex((c) => c.number === 5 && c.unit === 3) >= 0
      ? credits.findIndex((c) => c.number === 5 && c.unit === 3)
      : totals.indexOf(minTotal);
  const weeklyIdx =
    credits.findIndex((c) => c.unit === 6 || c.number === 1) >= 0
      ? credits.findIndex((c) => c.unit === 6 || c.number === 1)
      : totals.indexOf(maxTotal);
  if (fiveHourIdx < 0 || weeklyIdx < 0 || fiveHourIdx === weeklyIdx) return null;
  return { fiveHour: credits[fiveHourIdx]!, weekly: credits[weeklyIdx]! };
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "glm-code",
    title: "GLM Code",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

async function fetchQuota(
  endpoint: string,
  authorization: string,
): Promise<Response> {
  return fetch(endpoint, {
    method: "GET",
    headers: withLlmUserAgent({
      Accept: "application/json",
      Authorization: authorization,
    }),
    signal: AbortSignal.timeout(8_000),
  });
}

export const glmCodeUsageAdapter: ProviderUsageAdapter = {
  key: "glm-code",
  matches(provider: ProviderUsageProfile): boolean {
    return quotaEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const endpoint = quotaEndpoint(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!endpoint || !apiKey) return errorSnapshot("Not configured");
    try {
      // Raw key first (CursorUsage measured behavior); Bearer retry on 401.
      let response = await fetchQuota(endpoint, apiKey);
      if (response.status === 401) {
        response = await fetchQuota(endpoint, `Bearer ${apiKey}`);
      }
      if (!response.ok) {
        return errorSnapshot(`Request failed (HTTP ${response.status})`);
      }
      const payload = (await response.json()) as Record<string, unknown>;
      const success = payload?.success === true || payload?.code === 200;
      if (!success) {
        const msg =
          typeof payload?.msg === "string" && payload.msg.trim()
            ? payload.msg.trim()
            : "Unknown error";
        return errorSnapshot(msg);
      }
      const data = (payload?.data ?? null) as Record<string, unknown> | null;
      const level =
        data && typeof data.level === "string" && data.level.trim()
          ? data.level.trim()
          : null;
      if (!data || !level) {
        const msg =
          typeof payload?.msg === "string" && payload.msg.trim()
            ? payload.msg.trim()
            : "No coding plan on this key";
        return errorSnapshot(msg);
      }
      const rawLimits = Array.isArray(data.limits) ? data.limits : [];
      const credits = rawLimits
        .map(readLimit)
        .filter(
          (item): item is RawLimit =>
            item !== null && item.type === "CREDIT_LIMIT",
        );
      const windows = pickGlmWindows(credits);
      if (!windows) return errorSnapshot("Cannot identify 5h/weekly limits");

      const fiveHour = makeLimit(windows.fiveHour);
      const weekly = makeLimit(windows.weekly);
      const lines: string[] = [];
      if (fiveHour.nextReset) {
        lines.push(`5h resets ${formatResetTime(fiveHour.nextReset)}`);
      }
      if (weekly.nextReset) {
        lines.push(`Weekly resets ${formatResetTime(weekly.nextReset)}`);
      }
      return {
        key: "glm-code",
        title: "GLM Code",
        badge: level.charAt(0).toUpperCase() + level.slice(1),
        bars: [
          {
            label: "5h",
            percent: fiveHour.percent,
            detail: `${formatCount(fiveHour.used)} / ${formatCount(fiveHour.total)} credits`,
          },
          {
            label: "Weekly",
            percent: weekly.percent,
            detail: `${formatCount(weekly.used)} / ${formatCount(weekly.total)} credits`,
          },
        ],
        lines,
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
