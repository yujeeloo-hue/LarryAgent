import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { glmBalanceAdapter } from "./glm.js";
import type { ProviderBalanceProfile } from "./types.js";

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

const PROFILE: ProviderBalanceProfile = {
  id: "glm-5.1",
  name: "GLM-5.3",
  baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
  modelId: "glm-5.3",
};

/** Real-shape payload: 5h credits window + weekly credits window. */
const CREDITS_PAYLOAD = {
  code: 200,
  msg: "操作成功",
  success: true,
  data: {
    level: "pro",
    limits: [
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

/** Legacy-shape payload: two TOKENS_LIMIT windows (5h + weekly). */
const TOKENS_PAYLOAD = {
  success: true,
  data: {
    level: "pro",
    limits: [
      { type: "TIME_LIMIT", percentage: 7, nextResetTime: 1787426535804 },
      { type: "TOKENS_LIMIT", percentage: 44, nextResetTime: 1787426535804 },
      { type: "TOKENS_LIMIT", percentage: 53, nextResetTime: 1787976897998 },
    ],
  },
};

describe("glmBalanceAdapter.matches", () => {
  it("matches bigmodel.cn and z.ai hosts", () => {
    assert.equal(glmBalanceAdapter.matches(PROFILE), true);
    assert.equal(
      glmBalanceAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
      true,
    );
  });

  it("rejects other hosts", () => {
    assert.equal(
      glmBalanceAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.deepseek.com",
      }),
      false,
    );
    assert.equal(
      glmBalanceAdapter.matches({ ...PROFILE, baseUrl: "not a url" }),
      false,
    );
  });
});

describe("glmBalanceAdapter.query", () => {
  it("shows weekly usage percentage (credits plans)", async () => {
    stubFetch(async () => jsonResponse(CREDITS_PAYLOAD));
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      "Weekly usage: 9%",
    );
  });

  it("shows weekly usage percentage (legacy token plans)", async () => {
    stubFetch(async () => jsonResponse(TOKENS_PAYLOAD));
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      "Weekly usage: 53%",
    );
  });

  it("rounds fractional percentages", async () => {
    stubFetch(async () =>
      jsonResponse({
        success: true,
        data: {
          limits: [
            {
              type: "CREDIT_LIMIT",
              percentage: 9.4,
              nextResetTime: 1787426535804,
            },
            {
              type: "CREDIT_LIMIT",
              percentage: 47.5,
              nextResetTime: 1787976897998,
            },
          ],
        },
      }),
    );
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      "Weekly usage: 48%",
    );
  });

  it("returns null when only a lone 5h window exists", async () => {
    stubFetch(async () =>
      jsonResponse({
        success: true,
        data: {
          limits: [
            {
              type: "TOKENS_LIMIT",
              percentage: 25,
              nextResetTime: 1787426535804,
            },
          ],
        },
      }),
    );
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );
  });

  it("returns null on http error / network failure / bad shape", async () => {
    stubFetch(async () => jsonResponse({}, 500));
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );

    stubFetch(async () => {
      throw new Error("network down");
    });
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );

    stubFetch(async () => jsonResponse({ success: true, data: null }));
    assert.equal(
      await glmBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );
  });

  it("skips the request without an api key", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return jsonResponse(CREDITS_PAYLOAD);
    });
    assert.equal(await glmBalanceAdapter.query({ ...PROFILE, apiKey: " " }), null);
    assert.equal(called, false);
  });
});
