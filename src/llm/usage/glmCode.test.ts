import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { glmCodeUsageAdapter, pickGlmWindows } from "./glmCode.js";
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
  id: "glm",
  name: "GLM",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  modelId: "glm-5.3",
};

/** Real-shape payload (mirrors balance/glm.test.ts), plus a TIME_LIMIT decoy. */
const CREDITS_PAYLOAD = {
  code: 200,
  msg: "操作成功",
  success: true,
  data: {
    level: "pro",
    limits: [
      { type: "TIME_LIMIT", percentage: 7, nextResetTime: 1787426535804 },
      {
        type: "CREDIT_LIMIT",
        unit: 3,
        number: 5,
        usage: 12000,
        currentValue: 23,
        remaining: 11976,
        percentage: 1,
        nextResetTime: 1787426535804,
      },
      {
        type: "CREDIT_LIMIT",
        unit: 6,
        number: 1,
        usage: 60000,
        currentValue: 5703,
        remaining: 54296,
        percentage: 9,
        nextResetTime: 1787976897998,
      },
    ],
  },
};

describe("glmCodeUsageAdapter.matches", () => {
  it("matches bigmodel.cn and z.ai hosts", () => {
    assert.equal(glmCodeUsageAdapter.matches(PROFILE), true);
    assert.equal(
      glmCodeUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
      true,
    );
  });

  it("rejects other hosts", () => {
    assert.equal(
      glmCodeUsageAdapter.matches({ ...PROFILE, baseUrl: "https://api.kimi.com" }),
      false,
    );
    assert.equal(
      glmCodeUsageAdapter.matches({ ...PROFILE, baseUrl: "not a url" }),
      false,
    );
  });
});

describe("pickGlmWindows", () => {
  it("identifies 5h by number==5&&unit==3 and weekly by unit==6||number==1", () => {
    const credits = CREDITS_PAYLOAD.data.limits
      .filter((l) => l.type === "CREDIT_LIMIT")
      .map((l) => ({
        type: l.type,
        unit: l.unit ?? null,
        number: l.number ?? null,
        usage: l.usage ?? null,
        currentValue: l.currentValue ?? null,
        remaining: l.remaining ?? null,
        percentage: l.percentage ?? null,
        nextResetTime: l.nextResetTime ?? null,
      }));
    const windows = pickGlmWindows(credits);
    assert.ok(windows);
    assert.equal(windows.fiveHour.usage, 12000);
    assert.equal(windows.weekly.usage, 60000);
  });

  it("never uses nextResetTime ordering: weekly-first reset still maps correctly", () => {
    // Weekly resets BEFORE the 5h window (observed in the wild) — sorting by
    // nextResetTime would swap the two.
    const weeklyFirst = [
      { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 12000, currentValue: 0, remaining: 0, percentage: 0, nextResetTime: 9999999999999 },
      { type: "CREDIT_LIMIT", unit: 6, number: 1, usage: 60000, currentValue: 0, remaining: 0, percentage: 0, nextResetTime: 1 },
    ];
    const windows = pickGlmWindows(weeklyFirst);
    assert.ok(windows);
    assert.equal(windows.fiveHour.usage, 12000);
    assert.equal(windows.weekly.usage, 60000);
  });

  it("falls back to min/max totals when number/unit markers are missing", () => {
    const bare = [
      { type: "CREDIT_LIMIT", unit: null, number: null, usage: 12000, currentValue: 1, remaining: 1, percentage: 1, nextResetTime: 1 },
      { type: "CREDIT_LIMIT", unit: null, number: null, usage: 60000, currentValue: 1, remaining: 1, percentage: 1, nextResetTime: 2 },
    ];
    const windows = pickGlmWindows(bare);
    assert.ok(windows);
    assert.equal(windows.fiveHour.usage, 12000);
    assert.equal(windows.weekly.usage, 60000);
  });

  it("returns null with fewer than two credit windows", () => {
    assert.equal(pickGlmWindows([]), null);
    assert.equal(
      pickGlmWindows([
        { type: "CREDIT_LIMIT", unit: 3, number: 5, usage: 1, currentValue: 0, remaining: 0, percentage: 0, nextResetTime: 1 },
      ]),
      null,
    );
  });
});

describe("glmCodeUsageAdapter.query", () => {
  it("sends the raw key Authorization header (no Bearer)", async () => {
    stubFetch(async (input, init) => {
      assert.equal(
        String(input),
        "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
      );
      const auth = (init?.headers as Record<string, string>).Authorization;
      assert.equal(auth, "glm-test-key");
      return jsonResponse(CREDITS_PAYLOAD);
    });
    const snapshot = await glmCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "glm-test-key",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, "Pro");
    assert.deepEqual(
      snapshot.bars.map((bar) => bar.label),
      ["5h", "Weekly"],
    );
    // percent self-computed, rounded to 1 decimal: 23/12000 → 0.2%, 5703/60000 → 9.5%
    assert.equal(snapshot.bars[0]!.percent, 0.2);
    assert.equal(snapshot.bars[1]!.percent, 9.5);
    assert.equal(snapshot.bars[0]!.detail, "23 / 12000 credits");
    assert.match(snapshot.lines[0]!, /^5h resets /);
    assert.match(snapshot.lines[1]!, /^Weekly resets /);
  });

  it("retries with Bearer on 401", async () => {
    const seenAuth: string[] = [];
    stubFetch(async (_input, init) => {
      const auth = (init?.headers as Record<string, string>).Authorization;
      seenAuth.push(auth ?? "");
      if (seenAuth.length === 1) return jsonResponse({}, 401);
      return jsonResponse(CREDITS_PAYLOAD);
    });
    const snapshot = await glmCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "glm-test-key",
    });
    assert.deepEqual(seenAuth, ["glm-test-key", "Bearer glm-test-key"]);
    assert.equal(snapshot.error, undefined);
  });

  it("reports missing plan level", async () => {
    stubFetch(async () =>
      jsonResponse({ success: true, data: { limits: [] } }),
    );
    const snapshot = await glmCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "glm-test-key",
    });
    assert.match(snapshot.error ?? "", /No coding plan/);
  });

  it("reports api error messages", async () => {
    stubFetch(async () =>
      jsonResponse({ success: false, msg: "key invalid" }),
    );
    const snapshot = await glmCodeUsageAdapter.query({
      ...PROFILE,
      apiKey: "glm-test-key",
    });
    assert.equal(snapshot.error, "key invalid");
  });
});
