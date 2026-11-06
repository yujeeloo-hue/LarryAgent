import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { kimiBalanceAdapter } from "./kimi.js";
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
  id: "kimi-k3",
  name: "KIMI K3",
  baseUrl: "https://api.moonshot.cn/v1",
  modelId: "kimi-k3",
};

/** Real-shape payload from api.moonshot.cn/v1/users/me/balance. */
const BALANCE_PAYLOAD = {
  code: 0,
  data: {
    available_balance: 110.5061,
    voucher_balance: 10.5061,
    cash_balance: 100,
  },
  scode: "0x0",
  status: true,
};

describe("kimiBalanceAdapter.matches", () => {
  it("matches moonshot.cn and moonshot.ai hosts", () => {
    assert.equal(kimiBalanceAdapter.matches(PROFILE), true);
    assert.equal(
      kimiBalanceAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.moonshot.ai/v1",
      }),
      true,
    );
  });

  it("rejects other hosts", () => {
    assert.equal(
      kimiBalanceAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.deepseek.com",
      }),
      false,
    );
    assert.equal(
      kimiBalanceAdapter.matches({ ...PROFILE, baseUrl: "not a url" }),
      false,
    );
  });
});

describe("kimiBalanceAdapter.query", () => {
  it("shows remaining balance in CNY for moonshot.cn", async () => {
    stubFetch(async () => jsonResponse(BALANCE_PAYLOAD));
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      "Remaining balance: 110.51 CNY",
    );
  });

  it("shows remaining balance in USD for moonshot.ai", async () => {
    stubFetch(async () => jsonResponse(BALANCE_PAYLOAD));
    assert.equal(
      await kimiBalanceAdapter.query({
        ...PROFILE,
        baseUrl: "https://api.moonshot.ai/v1",
        apiKey: "sk-test",
      }),
      "Remaining balance: 110.51 USD",
    );
  });

  it("queries /v1/users/me/balance even when baseUrl lacks the /v1 suffix", async () => {
    let requested: string | null = null;
    stubFetch(async (input) => {
      requested = String(input);
      return jsonResponse(BALANCE_PAYLOAD);
    });
    await kimiBalanceAdapter.query({
      ...PROFILE,
      baseUrl: "https://api.moonshot.cn",
      apiKey: "sk-test",
    });
    assert.equal(requested, "https://api.moonshot.cn/v1/users/me/balance");
  });

  it("trims trailing .00 from whole amounts", async () => {
    stubFetch(async () =>
      jsonResponse({
        code: 0,
        status: true,
        data: { available_balance: 100 },
      }),
    );
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      "Remaining balance: 100 CNY",
    );
  });

  it("returns null on api error / http error / network failure / bad shape", async () => {
    stubFetch(async () => jsonResponse({ code: 401, status: false }));
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );

    stubFetch(async () => jsonResponse({}, 500));
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );

    stubFetch(async () => {
      throw new Error("network down");
    });
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );

    stubFetch(async () => jsonResponse({ code: 0, status: true, data: null }));
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: "sk-test" }),
      null,
    );
  });

  it("skips the request without an api key", async () => {
    let called = false;
    stubFetch(async () => {
      called = true;
      return jsonResponse(BALANCE_PAYLOAD);
    });
    assert.equal(
      await kimiBalanceAdapter.query({ ...PROFILE, apiKey: " " }),
      null,
    );
    assert.equal(called, false);
  });
});
