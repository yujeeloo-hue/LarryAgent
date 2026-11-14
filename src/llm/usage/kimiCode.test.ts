import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { kimiCodeUsageAdapter } from "./kimiCode.js";
import type { ProviderUsageProfile } from "./types.js";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(
  handler: (input: string | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = ((input: string | URL, init?: RequestInit) =>
    handler(input, init)) as typeof fetch;
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const PROFILE: ProviderUsageProfile = {
  id: "kimi-code",
  name: "Kimi Code",
  baseUrl: "https://api.kimi.com/coding/v1",
  modelId: "kimi-for-coding",
};

/**
 * `/coding/v1/me` carries the membership name — and account PII (nickname,
 * masked phone, user ids, avatar). Only `user_level_name` may be read; the
 * fixture stays PII-free on purpose.
 */
const ME_PAYLOAD = {
  user_level_name: "Pro",
  user_level: 25,
  status: "USER_STATUS_NORMAL",
  region: "REGION_CN",
};

/**
 * Byte-for-byte live shape (measured 2026-10-14 on a Pro account): the window
 * is expressed in MINUTES, `detail` has no `used` key, and this plan emits no
 * `limit_7d` entry at all.
 */
const LIVE_USAGES_PAYLOAD = {
  limits: [
    {
      window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
      detail: {
        limit: "100",
        remaining: "100",
        resetTime: "2026-10-14T07:51:25.973986Z",
      },
    },
  ],
  usages: {
    limit_5h: { used_ratio: 0, reset_time: "2026-10-14T07:51:25Z" },
    limit_month_total: {
      used_ratio: 0.1133,
      reset_time: "2026-11-12T00:00:00Z",
    },
    limit_month_code: {
      used_ratio: 0.1133,
      reset_time: "2026-11-12T00:00:00Z",
    },
  },
};

/** Real-shape payload: used_ratio as number, reset_time with microseconds. */
const USAGES_PAYLOAD = {
  usages: {
    limit_5h: { used_ratio: 0.42, reset_time: "2026-10-12T15:51:25.973986Z" },
    limit_7d: { used_ratio: 0.1, reset_time: "2026-10-19T00:00:00Z" },
    limit_month_total: { used_ratio: 0.55, reset_time: "2026-11-01T00:00:00Z" },
    limit_month_code: { used_ratio: 0.35, reset_time: "2026-11-01T00:00:00Z" },
  },
  limits: [
    {
      window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
      // detail numbers drift to strings in the wild
      detail: { limit: "100", used: "42", remaining: "58" },
    },
    {
      window: { duration: 1, timeUnit: "TIME_UNIT_WEEK" },
      detail: { limit: "500", used: "50", remaining: "450" },
    },
  ],
};

describe("kimiCodeUsageAdapter.matches", () => {
  it("matches api.kimi.com hosts", () => {
    assert.equal(kimiCodeUsageAdapter.matches(PROFILE), true);
    assert.equal(
      kimiCodeUsageAdapter.matches({ ...PROFILE, baseUrl: "https://api.kimi.com" }),
      true,
    );
  });

  it("rejects moonshot platform hosts (that is the balance adapter)", () => {
    assert.equal(
      kimiCodeUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.moonshot.cn/v1",
      }),
      false,
    );
    assert.equal(
      kimiCodeUsageAdapter.matches({ ...PROFILE, baseUrl: "not a url" }),
      false,
    );
  });
});

describe("kimiCodeUsageAdapter.query", () => {
  it("rejects non sk-kimi- keys before any request", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-platform-key",
    });
    assert.equal(called, false);
    assert.match(snapshot.error ?? "", /sk-kimi-/);
  });

  it("parses 5h/weekly/monthly bars with absolute details and reset lines", async () => {
    const seen: string[] = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      seen.push(url);
      const auth = (init?.headers as Record<string, string>).Authorization;
      assert.equal(auth, "Bearer sk-kimi-test");
      return jsonResponse(url.endsWith("/coding/v1/me") ? ME_PAYLOAD : USAGES_PAYLOAD);
    });
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.key, "kimi-code");
    assert.deepEqual(seen.sort(), [
      "https://api.kimi.com/coding/v1/me",
      "https://api.kimi.com/coding/v1/usages",
    ]);
    assert.equal(snapshot.badge, "Pro");
    assert.deepEqual(
      snapshot.bars.map((bar) => bar.label),
      ["5h", "Weekly", "Monthly"],
    );
    assert.equal(snapshot.bars[0]!.percent, 42);
    assert.equal(snapshot.bars[0]!.detail, "42 / 100");
    assert.equal(snapshot.bars[1]!.percent, 10);
    assert.equal(snapshot.bars[1]!.detail, "50 / 500");
    assert.equal(snapshot.bars[2]!.percent, 55);
    // reset lines for each window (microseconds timestamp parsed, not NaN)
    assert.equal(snapshot.lines.length, 4);
    assert.match(snapshot.lines[0]!, /^5h resets /);
    assert.ok(!snapshot.lines[0]!.includes("Invalid"));
    // month split: total 55% − code 35% = other 20%
    assert.match(snapshot.lines[3]!, /code 35% · other 20%/);
  });

  it("reports an error when no usage windows exist", async () => {
    stubFetch(async (input) =>
      jsonResponse(
        String(input).endsWith("/coding/v1/me") ? ME_PAYLOAD : { usages: {}, limits: [] },
      ),
    );
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.match(snapshot.error ?? "", /No usage windows/);
  });

  it("keeps bars and lines when the membership lookup fails", async () => {
    stubFetch(async (input) => {
      if (String(input).endsWith("/coding/v1/me")) throw new Error("network down");
      return jsonResponse(USAGES_PAYLOAD);
    });
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, undefined);
    assert.equal(snapshot.bars.length, 3);
  });

  it("drops the badge but not the section when /me has no plan name", async () => {
    stubFetch(async (input) =>
      jsonResponse(String(input).endsWith("/coding/v1/me") ? { status: "X" } : USAGES_PAYLOAD),
    );
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.equal(snapshot.badge, undefined);
    assert.equal(snapshot.error, undefined);
  });

  it("derives absolute details from limit − remaining (live shape, no `used`)", async () => {
    stubFetch(async (input) =>
      jsonResponse(
        String(input).endsWith("/coding/v1/me") ? ME_PAYLOAD : LIVE_USAGES_PAYLOAD,
      ),
    );
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, "Pro");
    // No `limit_7d` on this plan → the weekly bar is simply absent.
    assert.deepEqual(
      snapshot.bars.map((bar) => bar.label),
      ["5h", "Monthly"],
    );
    assert.equal(snapshot.bars[0]!.percent, 0);
    assert.equal(snapshot.bars[0]!.detail, "0 / 100");
    assert.equal(snapshot.bars[1]!.percent, 11.3);
    // 5h + Monthly reset lines, plus the month code/other split.
    assert.equal(snapshot.lines.length, 3);
    assert.match(snapshot.lines[0]!, /^5h resets /);
    assert.ok(!snapshot.lines[0]!.includes("Invalid"));
    assert.match(snapshot.lines[2]!, /code 11\.3% · other 0%/);
  });

  it("reports HTTP errors", async () => {
    stubFetch(async () => jsonResponse({}, 401));
    const snapshot = await kimiCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-test",
    });
    assert.match(snapshot.error ?? "", /HTTP 401/);
  });
});
