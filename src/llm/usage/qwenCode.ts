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
  formatResetTimeSmart,
  lenientNumber,
  parseIsoDate,
} from "./util.js";

/**
 * Qwen / Alibaba Bailian Coding Plan quota.
 *
 * There is no quota route on the inference host (`coding.dashscope.aliyuncs.com`).
 * The console gateway exposes it:
 * POST {console}/data/api.json?action=...queryCodingPlanInstanceInfoV2
 * Auth reuses the plan key (`sk-sp-`) as Bearer + x-api-key + X-DashScope-API-Key.
 *
 * Two commodity codes show up in the wild (`broadscope-bailian*` and
 * `sfm_codingplan_public_*`). China is tried before international when the
 * provider base URL is the China coding host, and the reverse for
 * `coding-intl`. `ConsoleNeedLogin` means this combination wants a browser
 * session — keep trying the other combinations. A 401/403 stops the sweep.
 */

const QUOTA_ACTION =
  "zeldaEasy.broadscope-bailian.codingPlan.queryCodingPlanInstanceInfoV2";

/** Console gateways reject a non-browser User-Agent on this RPC. */
const CONSOLE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

type Region = "cn" | "intl";

type Attempt = {
  origin: string;
  regionId: string;
  referer: string;
  commodity: string;
};

const CN_ATTEMPTS: readonly Attempt[] = [
  {
    origin: "https://bailian.console.aliyun.com",
    regionId: "cn-beijing",
    referer:
      "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan",
    commodity: "broadscope-bailian",
  },
  {
    origin: "https://bailian.console.aliyun.com",
    regionId: "cn-beijing",
    referer:
      "https://bailian.console.aliyun.com/cn-beijing/?tab=model#/efm/coding_plan",
    commodity: "sfm_codingplan_public_cn",
  },
];

const INTL_ATTEMPTS: readonly Attempt[] = [
  {
    origin: "https://modelstudio.console.alibabacloud.com",
    regionId: "ap-southeast-1",
    referer:
      "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan",
    commodity: "broadscope-bailian-intl",
  },
  {
    origin: "https://modelstudio.console.alibabacloud.com",
    regionId: "ap-southeast-1",
    referer:
      "https://modelstudio.console.alibabacloud.com/ap-southeast-1/?tab=coding-plan#/efm/coding_plan",
    commodity: "sfm_codingplan_public_intl",
  },
];

type WindowSpec = {
  label: string;
  usedKeys: readonly string[];
  totalKeys: readonly string[];
  resetKeys: readonly string[];
};

const WINDOWS: readonly WindowSpec[] = [
  {
    label: "5h",
    usedKeys: ["per5HourUsedQuota", "perFiveHourUsedQuota"],
    totalKeys: ["per5HourTotalQuota", "perFiveHourTotalQuota"],
    resetKeys: ["per5HourQuotaNextRefreshTime", "perFiveHourQuotaNextRefreshTime"],
  },
  {
    label: "Weekly",
    usedKeys: ["perWeekUsedQuota"],
    totalKeys: ["perWeekTotalQuota"],
    resetKeys: ["perWeekQuotaNextRefreshTime"],
  },
  {
    label: "Monthly",
    usedKeys: ["perBillMonthUsedQuota", "perMonthUsedQuota"],
    totalKeys: ["perBillMonthTotalQuota", "perMonthTotalQuota"],
    resetKeys: [
      "perBillMonthQuotaNextRefreshTime",
      "perMonthQuotaNextRefreshTime",
    ],
  },
];

function qwenRegion(baseUrl: string): Region | null {
  try {
    const host = new URL(baseUrl.trim()).hostname.toLowerCase();
    if (
      host === "coding-intl.dashscope.aliyuncs.com" ||
      host.endsWith(".coding-intl.dashscope.aliyuncs.com")
    ) {
      return "intl";
    }
    if (
      host === "coding.dashscope.aliyuncs.com" ||
      host.endsWith(".coding.dashscope.aliyuncs.com")
    ) {
      return "cn";
    }
    return null;
  } catch {
    return null;
  }
}

function quotaUrl(attempt: Attempt): string {
  const params = new URLSearchParams({
    action: QUOTA_ACTION,
    product: "broadscope-bailian",
    api: "queryCodingPlanInstanceInfoV2",
    currentRegionId: attempt.regionId,
  });
  return `${attempt.origin}/data/api.json?${params.toString()}`;
}

function errorSnapshot(error: string): ProviderUsageSnapshot {
  return {
    key: "qwen-code",
    title: "Qwen Code",
    bars: [],
    lines: [],
    error,
    fetchedAt: Date.now(),
  };
}

function expand(value: unknown, depth = 0): unknown {
  if (depth > 8) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return expand(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => expand(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = expand(child, depth + 1);
    }
    return out;
  }
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    const value = lenientNumber(record[key]);
    if (value !== null) return value;
  }
  return null;
}

function parseReset(raw: unknown): Date | null {
  const numeric = lenientNumber(raw);
  if (numeric !== null && numeric > 0) {
    const ms = numeric > 1e12 ? numeric : numeric > 1e9 ? numeric * 1000 : numeric;
    return new Date(ms);
  }
  return parseIsoDate(raw);
}

function firstReset(
  record: Record<string, unknown>,
  keys: readonly string[],
): Date | null {
  for (const key of keys) {
    const date = parseReset(record[key]);
    if (date) return date;
  }
  return null;
}

function stringField(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function instanceListAt(root: unknown, path: readonly string[]): unknown[] {
  let current: unknown = root;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return [];
    current = record[key];
  }
  return Array.isArray(current) ? current : [];
}

function findInstances(payload: Record<string, unknown>): Record<string, unknown>[] {
  const lists = [
    ...instanceListAt(payload, ["data", "codingPlanInstanceInfos"]),
    ...instanceListAt(payload, [
      "data",
      "DataV2",
      "data",
      "data",
      "codingPlanInstanceInfos",
    ]),
    ...instanceListAt(payload, ["codingPlanInstanceInfos"]),
  ];
  return lists
    .map(asRecord)
    .filter((item): item is Record<string, unknown> => item !== null);
}

function pickInstance(
  instances: readonly Record<string, unknown>[],
): Record<string, unknown> | null {
  return (
    instances.find((item) => item.status === "VALID") ?? instances[0] ?? null
  );
}

function planName(instance: Record<string, unknown>): string | null {
  return stringField(instance, ["planName", "instanceName", "packageName"]);
}

type Envelope =
  | { kind: "login" }
  | { kind: "auth" }
  | { kind: "error"; message: string }
  | { kind: "ok" };

function envelopeOf(payload: Record<string, unknown>): Envelope {
  const code = payload.code;
  const codeText =
    typeof code === "string"
      ? code.trim()
      : typeof code === "number"
        ? String(code)
        : "";
  const message = stringField(payload, ["message", "msg"]) ?? "";
  const lowered = `${codeText} ${message}`.toLowerCase();
  if (
    codeText === "ConsoleNeedLogin" ||
    lowered.includes("needlogin") ||
    lowered.includes("请登录") ||
    lowered.includes("log in")
  ) {
    return { kind: "login" };
  }
  if (codeText === "401" || codeText === "403") return { kind: "auth" };
  const data = asRecord(payload.data);
  const ret = asRecord(data?.DataV2)?.ret;
  if (Array.isArray(ret)) {
    const joined = ret
      .filter((item): item is string => typeof item === "string")
      .join(";")
      .toLowerCase();
    if (joined.includes("no authority")) return { kind: "auth" };
    if (joined.includes("needlogin")) return { kind: "login" };
  }
  if (codeText && codeText !== "200" && codeText !== "0") {
    return { kind: "error", message: message || codeText };
  }
  return { kind: "ok" };
}

function snapshotFromPayload(
  payload: Record<string, unknown>,
): ProviderUsageSnapshot | null {
  const instance = pickInstance(findInstances(payload));
  const quota = asRecord(instance?.codingPlanQuotaInfo);
  if (!instance || !quota) return null;
  const bars: UsageBar[] = [];
  const lines: string[] = [];
  for (const spec of WINDOWS) {
    const total = firstNumber(quota, spec.totalKeys);
    if (total === null || total <= 0) continue;
    const used = firstNumber(quota, spec.usedKeys) ?? 0;
    const remaining = Math.max(0, total - used);
    bars.push({
      label: spec.label,
      percent: clampPercent(Math.round((used / total) * 1000) / 10),
    });
    const reset = firstReset(quota, spec.resetKeys);
    const resetText = reset ? ` · resets ${formatResetTimeSmart(reset)}` : "";
    lines.push(
      `${spec.label}: ${formatCount(remaining)}/${formatCount(total)} left${resetText}`,
    );
  }
  if (bars.length === 0) return null;
  const badge = planName(instance);
  return {
    key: "qwen-code",
    title: "Qwen Code",
    // Conditional spread: `badge?: string` under exactOptionalPropertyTypes
    // rejects an explicit undefined.
    ...(badge ? { badge } : {}),
    bars,
    lines,
    fetchedAt: Date.now(),
  };
}

type AttemptResult =
  | { kind: "ok"; snapshot: ProviderUsageSnapshot }
  | { kind: "next"; reason: string }
  | { kind: "fatal"; reason: string };

async function queryAttempt(
  attempt: Attempt,
  apiKey: string,
): Promise<AttemptResult> {
  let response: Response;
  try {
    response = await fetch(quotaUrl(attempt), {
      method: "POST",
      headers: withLlmUserAgent({
        Accept: "application/json",
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
        "x-api-key": apiKey,
        "X-DashScope-API-Key": apiKey,
        Origin: attempt.origin,
        Referer: attempt.referer,
        "User-Agent": CONSOLE_USER_AGENT,
      }),
      body: JSON.stringify({
        queryCodingPlanInstanceInfoRequest: { commodityCode: attempt.commodity },
      }),
      signal: AbortSignal.timeout(8_000),
    });
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "TimeoutError"
        ? "Request timed out"
        : "Request failed";
    return { kind: "next", reason };
  }
  if (response.status === 401 || response.status === 403) {
    return { kind: "fatal", reason: `Request failed (HTTP ${response.status})` };
  }
  if (!response.ok) {
    return { kind: "next", reason: `Request failed (HTTP ${response.status})` };
  }
  let payload: unknown;
  try {
    payload = expand(await response.json());
  } catch {
    return { kind: "next", reason: "No quota data" };
  }
  const record = asRecord(payload);
  if (!record) return { kind: "next", reason: "No quota data" };
  const envelope = envelopeOf(record);
  if (envelope.kind === "auth") {
    return { kind: "fatal", reason: "Request failed (HTTP 401)" };
  }
  if (envelope.kind === "login") {
    return {
      kind: "next",
      reason: "Coding Plan quota needs a console login for this key",
    };
  }
  if (envelope.kind === "error") {
    return { kind: "next", reason: envelope.message };
  }
  const snapshot = snapshotFromPayload(record);
  if (!snapshot) return { kind: "next", reason: "No quota data" };
  return { kind: "ok", snapshot };
}

export const qwenCodeUsageAdapter: ProviderUsageAdapter = {
  key: "qwen-code",
  matches(provider: ProviderUsageProfile): boolean {
    return qwenRegion(provider.baseUrl) !== null;
  },
  async query(input: ProviderUsageQueryInput): Promise<ProviderUsageSnapshot> {
    const region = qwenRegion(input.baseUrl);
    const apiKey = input.apiKey.trim();
    if (!region || !apiKey) return errorSnapshot("Not configured");
    const attempts =
      region === "cn"
        ? [...CN_ATTEMPTS, ...INTL_ATTEMPTS]
        : [...INTL_ATTEMPTS, ...CN_ATTEMPTS];
    let lastReason = "No quota data";
    for (const attempt of attempts) {
      const result = await queryAttempt(attempt, apiKey);
      if (result.kind === "ok") return result.snapshot;
      lastReason = result.reason;
      if (result.kind === "fatal") break;
    }
    return errorSnapshot(lastReason);
  },
};
