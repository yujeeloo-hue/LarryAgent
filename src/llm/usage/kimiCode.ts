import { withLlmUserAgent } from "../userAgent.js";
import type {
  ProviderUsageAdapter,
  ProviderUsageProfile,
  ProviderUsageQueryInput,
  ProviderUsageSnapshot,
  UsageBar,
} from "./types.js";
import {
  clampPercent,
  formatCount,
  formatResetTime,
  lenientNumber,
  parseIsoDate,
} from "./util.js";

/**
 * Kimi Code (Kimi Coding Plan) usage — GET {origin}/coding/v1/usages.
 *
 * Ported from CursorUsage Sources/Shared/KimiAPI.swift (fetchCodingUsage).
 * Auth: Bearer with the `sk-kimi-` prefixed membership key. Semantics align
 * with the official kimi-code CLI (packages/oauth/src/managed-usage.ts):
 * `usages` carries per-window used_ratio (0...1), `limits[]` carries absolute
 * used/limit/remaining indexed by window minutes (300 = 5h, 10080 = week).
 */

const KIMI_CODE_KEY_PREFIX = "sk-kimi-";
const WINDOW_5H_MINUTES = 300;
const WINDOW_WEEK_MINUTES = 10080;

function isKimiCodeHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "api.kimi.com" || host.endsWith(".kimi.com");
}

function usagesEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isKimiCodeHost(url.hostname)) return null;
    return `${url.origin}/coding/v1/usages`;
  } catch {
    return null;
  }
}

/** Membership endpoint — same origin, same Bearer key. */
function meEndpoint(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    if (!isKimiCodeHost(url.hostname)) return null;
    return `${url.origin}/coding/v1/me`;
  } catch {
    return null;
  }
}

const TIME_UNIT_MINUTES: Readonly<Record<string, number>> = {
  TIME_UNIT_MINUTE: 1,
  TIME_UNIT_HOUR: 60,
  TIME_UNIT_DAY: 1440,
  TIME_UNIT_WEEK: 10080,
};

type WindowDetail = { used: number; limit: number; remaining: number };

type UsagesEntry = {
  usedRatio: number | null;
  resetAt: Date | null;
};

function readEntry(raw: unknown): UsagesEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  return {
    usedRatio: lenientNumber(entry.used_ratio),
    resetAt: parseIsoDate(entry.reset_time),
  };
}

function readWindowMinutes(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null) return null;
  const window = raw as Record<string, unknown>;
  const duration = lenientNumber(window.duration);
  const unit = typeof window.timeUnit === "string" ? window.timeUnit : "";
  const factor = TIME_UNIT_MINUTES[unit];
  if (duration === null || factor === undefined) return null;
  return Math.round(duration * factor);
}

function readWindowDetail(raw: unknown): WindowDetail | null {
  if (typeof raw !== "object" || raw === null) return null;
  const detail = raw as Record<string, unknown>;
  const limit = lenientNumber(detail.limit);
  const used = lenientNumber(detail.used);
  const remaining = lenientNumber(detail.remaining);
  if (limit === null) return null;
  // Live payloads send only {limit, remaining} — no `used` field at all
  // (measured 2026-10-14 against /coding/v1/usages). Derive whichever side is
  // missing instead of dropping the whole absolute detail.
  const resolvedUsed =
    used ?? (remaining === null ? null : Math.max(0, limit - remaining));
  if (resolvedUsed === null) return null;
  return {
    used: resolvedUsed,
    limit,
    remaining: remaining ?? Math.max(0, limit - resolvedUsed),
  };
}

/**
 * Plan badge for the section head. `GET /coding/v1/me` is the only Kimi Code
 * endpoint carrying the membership name — `/coding/v1/usages` has no plan
 * field at all (both measured 2026-10-14). Everything else in the /me payload
 * is account PII (nickname, masked phone, user ids, avatar) and is never read,
 * kept, or logged.
 */
function readLevelName(payload: unknown): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const raw = (payload as Record<string, unknown>).user_level_name;
  if (typeof raw !== "string") return null;
  const name = raw.trim();
  return name ? name : null;
}

/** Never rejects: a failed plan lookup costs the badge, never the section. */
async function fetchLevelName(
  endpoint: string | null,
  apiKey: string,
): Promise<string | null> {
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      headers: withLlmUserAgent({
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return null;
    return readLevelName(await response.json());
  } catch {
    return null;
  }
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "kimi-code",
    title: "Kimi Code",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

function buildBar(
  label: string,
  entry: UsagesEntry | null,
  detail: WindowDetail | undefined,
): { bar: UsageBar; resetAt: Date | null } | null {
  if (!entry || entry.usedRatio === null) return null;
  const bar: UsageBar = {
    label,
    // One decimal place — mirrors CursorUsage's %.1f display and kills
    // float noise (0.55 * 100 = 55.00000000000001).
    percent: clampPercent(Math.round(entry.usedRatio * 1000) / 10),
  };
  if (detail) {
    bar.detail = `${formatCount(detail.used)} / ${formatCount(detail.limit)}`;
  }
  return { bar, resetAt: entry.resetAt };
}

export const kimiCodeUsageAdapter: ProviderUsageAdapter = {
  key: "kimi-code",
  matches(provider: ProviderUsageProfile): boolean {
    return usagesEndpoint(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const endpoint = usagesEndpoint(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!endpoint || !apiKey) return errorSnapshot("Not configured");
    if (!apiKey.startsWith(KIMI_CODE_KEY_PREFIX)) {
      return errorSnapshot(
        `Configured key is not a Kimi Code key (expects ${KIMI_CODE_KEY_PREFIX} prefix)`,
      );
    }
    // Parallel: the usage request owns the section's error state, the
    // membership request only ever contributes the badge.
    const levelName = fetchLevelName(meEndpoint(input.baseUrl), apiKey);
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
      const usages = (payload?.usages ?? null) as Record<string, unknown> | null;
      const limits = Array.isArray(payload?.limits) ? payload.limits : [];

      // Absolute details indexed by window minutes.
      const details = new Map<number, WindowDetail>();
      for (const item of limits) {
        if (typeof item !== "object" || item === null) continue;
        const record = item as Record<string, unknown>;
        const minutes = readWindowMinutes(record.window);
        const detail = readWindowDetail(record.detail);
        if (minutes !== null && detail) details.set(minutes, detail);
      }
      const monthlyDetail = [...details.entries()]
        .filter(([minutes]) => minutes > WINDOW_WEEK_MINUTES)
        .sort((a, b) => a[0] - b[0])[0]?.[1];

      const fiveHour = buildBar(
        "5h",
        usages ? readEntry(usages.limit_5h) : null,
        details.get(WINDOW_5H_MINUTES),
      );
      const weekly = buildBar(
        "Weekly",
        usages ? readEntry(usages.limit_7d) : null,
        details.get(WINDOW_WEEK_MINUTES),
      );
      const monthly = buildBar(
        "Monthly",
        usages ? readEntry(usages.limit_month_total) : null,
        monthlyDetail,
      );

      const built = [
        { label: "5h", value: fiveHour },
        { label: "Weekly", value: weekly },
        { label: "Monthly", value: monthly },
      ].filter((item) => item.value !== null);
      if (built.length === 0) {
        return errorSnapshot("No usage windows in response");
      }

      const bars = built.map((item) => item.value!.bar);
      const lines: string[] = [];
      for (const item of built) {
        if (item.value!.resetAt) {
          lines.push(`${item.label} resets ${formatResetTime(item.value!.resetAt!)}`);
        }
      }
      // Month split: limit_month_code is the code-lane share of the monthly
      // quota; the kimi (chat) share is total − code.
      const monthCode = usages ? readEntry(usages.limit_month_code) : null;
      if (monthly && monthCode?.usedRatio !== null && monthCode?.usedRatio !== undefined) {
        const codePercent = clampPercent(monthCode.usedRatio * 100);
        const totalPercent = monthly.bar.percent;
        const otherPercent = clampPercent(totalPercent - codePercent);
        lines.push(
          `Month split — code ${formatCount(Math.round(codePercent * 10) / 10)}% · other ${formatCount(Math.round(otherPercent * 10) / 10)}%`,
        );
      }

      const badge = await levelName;
      return {
        key: "kimi-code",
        title: "Kimi Code",
        ...(badge ? { badge } : {}),
        bars,
        lines,
        fetchedAt: Date.now(),
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === "TimeoutError"
        ? "Request timed out"
        : "Request failed";
      return errorSnapshot(reason);
    }
  },
};
