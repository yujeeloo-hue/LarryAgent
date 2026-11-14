import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { qwenCodeUsageAdapter } from "./qwenCode.js";
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
  id: "qwen",
  name: "Qwen",
  baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
  modelId: "qwen3.6-plus",
};

const QUOTA = {
  per5HourUsedQuota: 30,
  per5HourTotalQuota: 100,
  per5HourQuotaNextRefreshTime: "2026-07-07T15:00:00Z",
  perWeekUsedQuota: 200,
  perWeekTotalQuota: 1000,
  perWeekQuotaNextRefreshTime: "2026-07-13T00:00:00Z",
  perBillMonthUsedQuota: 500,
  perBillMonthTotalQuota: 5000,
  perBillMonthQuotaNextRefreshTime: "2026-08-01T00:00:00Z",
};

function commodityOf(init?: RequestInit): string {
  const body = JSON.parse(String(init?.body)) as {
    queryCodingPlanInstanceInfoRequest: { commodityCode: string };
  };
  return body.queryCodingPlanInstanceInfoRequest.commodityCode;
}

describe("qwenCodeUsageAdapter.matches", () => {
  it("matches Coding Plan hosts and rejects pay-as-you-go DashScope", () => {
    assert.equal(qwenCodeUsageAdapter.matches(PROFILE), true);
    assert.equal(
      qwenCodeUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://coding.dashscope.aliyuncs.com/apps/anthropic",
      }),
      true,
    );
    assert.equal(
      qwenCodeUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      }),
      true,
    );
    assert.equal(
      qwenCodeUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      }),
      false,
    );
  });
});

describe("qwenCodeUsageAdapter.query", () => {
  it("reads the China console quota and shows remaining counts", async () => {
    const urls: string[] = [];
    stubFetch(async (input, init) => {
      urls.push(String(input));
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers.Authorization, "Bearer sk-sp-test");
      assert.equal(headers["x-api-key"], "sk-sp-test");
      assert.equal(headers["X-DashScope-API-Key"], "sk-sp-test");
      assert.equal(commodityOf(init), "broadscope-bailian");
      return jsonResponse({
        data: {
          codingPlanInstanceInfos: [
            { planName: "Coding Plan Pro", status: "VALID", codingPlanQuotaInfo: QUOTA },
          ],
        },
      });
    });
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-sp-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, "Coding Plan Pro");
    assert.deepEqual(
      snapshot.bars.map((bar) => [bar.label, bar.percent]),
      [
        ["5h", 30],
        ["Weekly", 20],
        ["Monthly", 10],
      ],
    );
    // Caption column is one line wide: `remaining/total` carries no spaces
    // around the slash (measured against the 264px Windows card).
    assert.match(snapshot.lines[0]!, /^5h: 70\/100 left · resets /);
    assert.match(snapshot.lines[1]!, /^Weekly: 800\/1000 left · resets /);
    assert.match(snapshot.lines[2]!, /^Monthly: 4500\/5000 left · resets /);
    assert.equal(urls.length, 1);
    assert.match(urls[0]!, /^https:\/\/bailian\.console\.aliyun\.com\/data\/api\.json\?/);
  });

  it("tries the sfm commodity code after ConsoleNeedLogin", async () => {
    const commodities: string[] = [];
    stubFetch(async (input, init) => {
      const commodity = commodityOf(init);
      commodities.push(`${new URL(String(input)).host}:${commodity}`);
      if (commodity !== "sfm_codingplan_public_cn") {
        return jsonResponse({ code: "ConsoleNeedLogin", message: "请登录" });
      }
      return jsonResponse({
        code: "200",
        data: {
          DataV2: {
            data: {
              data: {
                codingPlanInstanceInfos: [
                  {
                    instanceName: "Coding Plan Pro",
                    status: "VALID",
                    codingPlanQuotaInfo: {
                      per5HourUsedQuota: 0,
                      per5HourTotalQuota: 6000,
                      per5HourQuotaNextRefreshTime: 1780731422000,
                    },
                  },
                ],
              },
            },
          },
        },
      });
    });
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-sp-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.bars[0]!.percent, 0);
    assert.match(snapshot.lines[0]!, /^5h: 6000\/6000 left/);
    assert.deepEqual(commodities.slice(0, 2), [
      "bailian.console.aliyun.com:broadscope-bailian",
      "bailian.console.aliyun.com:sfm_codingplan_public_cn",
    ]);
  });

  it("prefers the VALID instance over an expired one", async () => {
    stubFetch(async () =>
      jsonResponse({
        data: {
          codingPlanInstanceInfos: [
            {
              status: "EXPIRED",
              planName: "Old",
              codingPlanQuotaInfo: {
                per5HourUsedQuota: 100,
                per5HourTotalQuota: 100,
              },
            },
            {
              status: "VALID",
              planName: "Pro",
              codingPlanQuotaInfo: {
                per5HourUsedQuota: 0,
                per5HourTotalQuota: 6000,
              },
            },
          ],
        },
      }),
    );
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-sp-test",
    });
    assert.equal(snapshot.badge, "Pro");
    assert.equal(snapshot.bars[0]!.percent, 0);
  });

  it("stops on HTTP 401 without trying another commodity", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return jsonResponse({}, 401);
    });
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-sp-test",
    });
    assert.match(snapshot.error ?? "", /HTTP 401/);
    assert.equal(calls, 1);
  });

  it("reports console login when every combination requires a session", async () => {
    stubFetch(async () =>
      jsonResponse({ code: "ConsoleNeedLogin", message: "请登录" }),
    );
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-sp-test",
    });
    assert.match(snapshot.error ?? "", /console login/);
  });

  it("starts on the international console for coding-intl hosts", async () => {
    let host = "";
    stubFetch(async (input) => {
      host = new URL(String(input)).host;
      return jsonResponse({
        data: {
          codingPlanInstanceInfos: [
            {
              status: "VALID",
              planName: "Pro",
              codingPlanQuotaInfo: {
                perWeekUsedQuota: 1,
                perWeekTotalQuota: 10,
              },
            },
          ],
        },
      });
    });
    const snapshot = await qwenCodeUsageAdapter.query({
      ...PROFILE,
      baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
      apiKey: "sk-sp-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(host, "modelstudio.console.alibabacloud.com");
    assert.match(snapshot.lines[0]!, /^Weekly: 9\/10 left$/);
  });
});
