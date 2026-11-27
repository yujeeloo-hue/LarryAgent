import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { kimiUsageAdapter } from "./kimi.js";
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
  id: "kimi",
  name: "Kimi",
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k2",
};

const BALANCE_PAYLOAD = {
  code: 0,
  status: true,
  data: { available_balance: 110.5061, voucher_balance: 10.5061, cash_balance: 100 },
};

describe("kimiUsageAdapter.matches", () => {
  it("matches moonshot .cn / .ai hosts", () => {
    assert.equal(kimiUsageAdapter.matches(PROFILE), true);
    assert.equal(
      kimiUsageAdapter.matches({ ...PROFILE, baseUrl: "https://api.moonshot.ai/v1" }),
      true,
    );
  });

  it("rejects api.kimi.com (that is the coding adapter)", () => {
    assert.equal(
      kimiUsageAdapter.matches({ ...PROFILE, baseUrl: "https://api.kimi.com" }),
      false,
    );
  });
});

describe("kimiUsageAdapter.query", () => {
  it("builds the endpoint under /v1 whether or not baseUrl has it", async () => {
    const seen: string[] = [];
    stubFetch(async (input) => {
      seen.push(String(input));
      return jsonResponse(BALANCE_PAYLOAD);
    });
    await kimiUsageAdapter.query({ ...PROFILE, apiKey: "sk-test" });
    await kimiUsageAdapter.query({
      ...PROFILE,
      baseUrl: "https://api.moonshot.cn",
      apiKey: "sk-test",
    });
    assert.deepEqual(seen, [
      "https://api.moonshot.cn/v1/users/me/balance",
      "https://api.moonshot.cn/v1/users/me/balance",
    ]);
  });

  it("shows available balance with CNY for .cn and USD for .ai", async () => {
    stubFetch(async () => jsonResponse(BALANCE_PAYLOAD));
    const cn = await kimiUsageAdapter.query({ ...PROFILE, apiKey: "sk-test" });
    assert.equal(cn.error, undefined);
    assert.deepEqual(cn.lines, [
      "Available: 110.51 CNY",
      "Top-up: 100 · Voucher: 10.51",
    ]);
    const ai = await kimiUsageAdapter.query({
      ...PROFILE,
      baseUrl: "https://api.moonshot.ai/v1",
      apiKey: "sk-test",
    });
    assert.match(ai.lines[0]!, /USD$/);
  });

  it("rejects sk-kimi- coding keys with a clear message", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return jsonResponse({});
    });
    const snapshot = await kimiUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-kimi-member",
    });
    assert.equal(called, false);
    assert.match(snapshot.error ?? "", /Kimi Code key/);
  });

  it("fails on unexpected response code", async () => {
    stubFetch(async () =>
      jsonResponse({ code: 5, status: false, data: null }),
    );
    const snapshot = await kimiUsageAdapter.query({ ...PROFILE, apiKey: "sk-test" });
    assert.match(snapshot.error ?? "", /code 5/);
  });
});
