import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { deepseekUsageAdapter } from "./deepseek.js";
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
  id: "deepseek",
  name: "DeepSeek",
  baseUrl: "https://api.deepseek.com",
  modelId: "deepseek-chat",
};

/** Real shape: amounts are strings, both currencies present. */
const BALANCE_PAYLOAD = {
  is_available: true,
  balance_infos: [
    {
      currency: "USD",
      total_balance: "1.20",
      granted_balance: "0.00",
      topped_up_balance: "1.20",
    },
    {
      currency: "CNY",
      total_balance: "12.34",
      granted_balance: "2.34",
      topped_up_balance: "10.00",
    },
  ],
};

describe("deepseekUsageAdapter.matches", () => {
  it("matches api.deepseek.com", () => {
    assert.equal(deepseekUsageAdapter.matches(PROFILE), true);
    assert.equal(
      deepseekUsageAdapter.matches({ ...PROFILE, baseUrl: "https://api.kimi.com" }),
      false,
    );
  });
});

describe("deepseekUsageAdapter.query", () => {
  it("prefers the CNY entry and splits top-up/granted", async () => {
    stubFetch(async (input, init) => {
      assert.equal(String(input), "https://api.deepseek.com/user/balance");
      const auth = (init?.headers as Record<string, string>).Authorization;
      assert.equal(auth, "Bearer sk-test");
      return jsonResponse(BALANCE_PAYLOAD);
    });
    const snapshot = await deepseekUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.deepEqual(snapshot.lines, [
      "Balance: 12.34 CNY",
      "Top-up: 10.00 · Granted: 2.34",
    ]);
  });

  it("falls back to USD when no CNY entry exists", async () => {
    stubFetch(async () =>
      jsonResponse({
        is_available: true,
        balance_infos: [BALANCE_PAYLOAD.balance_infos[0]],
      }),
    );
    const snapshot = await deepseekUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-test",
    });
    assert.match(snapshot.lines[0]!, /USD$/);
  });

  it("reports missing balance data", async () => {
    stubFetch(async () => jsonResponse({ is_available: false }));
    const snapshot = await deepseekUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-test",
    });
    assert.match(snapshot.error ?? "", /No balance data/);
  });

  it("reports HTTP errors", async () => {
    stubFetch(async () => jsonResponse({}, 403));
    const snapshot = await deepseekUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-test",
    });
    assert.match(snapshot.error ?? "", /HTTP 403/);
  });
});
