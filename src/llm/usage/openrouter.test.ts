import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { openrouterUsageAdapter } from "./openrouter.js";
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
  id: "openrouter",
  name: "OpenRouter",
  baseUrl: "https://openrouter.ai/api/v1",
  modelId: "openai/gpt-4o",
};

const KEY_PAYLOAD = {
  data: {
    limit: 100,
    limit_remaining: 74.5,
    limit_reset: "monthly",
    usage: 25.5,
    usage_daily: 1.2,
    usage_weekly: 8.4,
    usage_monthly: 25.5,
    is_free_tier: false,
    effective_budget: {
      limit_usd: 50,
      remaining_usd: 17.5,
      reset_interval: "weekly",
    },
    free_model_daily_requests: { limit: 50, remaining: 38, used: 12 },
  },
};

const CREDITS_PAYLOAD = {
  data: { total_credits: 100.5, total_usage: 25.75 },
};

describe("openrouterUsageAdapter.matches", () => {
  it("matches openrouter.ai and rejects other hosts", () => {
    assert.equal(openrouterUsageAdapter.matches(PROFILE), true);
    assert.equal(
      openrouterUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://www.openrouter.ai",
      }),
      true,
    );
    assert.equal(
      openrouterUsageAdapter.matches({
        ...PROFILE,
        baseUrl: "https://api.deepseek.com",
      }),
      false,
    );
  });
});

describe("openrouterUsageAdapter.query", () => {
  it("shows account balance, key cap, budget, and free-model quota", async () => {
    const urls: string[] = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      urls.push(url);
      assert.equal(
        (init?.headers as Record<string, string>).Authorization,
        "Bearer sk-or-test",
      );
      if (url.endsWith("/api/v1/key")) return jsonResponse(KEY_PAYLOAD);
      if (url.endsWith("/api/v1/credits")) return jsonResponse(CREDITS_PAYLOAD);
      return jsonResponse({}, 404);
    });
    const snapshot = await openrouterUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-or-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, undefined);
    assert.deepEqual(
      snapshot.bars.map((bar) => bar.label),
      ["Monthly", "Budget", "Free"],
    );
    assert.equal(snapshot.bars[0]!.percent, 25.5);
    assert.equal(snapshot.bars[1]!.percent, 65);
    assert.equal(snapshot.bars[2]!.percent, 24);
    assert.deepEqual(snapshot.lines, [
      "Balance: 74.75 USD",
      "Purchased: 100.5 · Used: 25.75",
      "Remaining: 74.5 / 100 USD",
      // Currency stated once per section; the day/week/month triple keeps
      // all three numbers inside the single-line caption column.
      "Budget: 17.5/50 left (weekly)",
      "d/w/m: 1.2/8.4/25.5 USD",
      "Free models today: 38 / 50",
    ]);
    assert.deepEqual(urls.sort(), [
      "https://openrouter.ai/api/v1/credits",
      "https://openrouter.ai/api/v1/key",
    ]);
  });

  it("ignores a 403 from credits and still shows the key cap", async () => {
    stubFetch(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/v1/credits")) return jsonResponse({}, 403);
      return jsonResponse({
        data: {
          limit: null,
          limit_remaining: null,
          usage_daily: 0,
          usage_weekly: 0,
          usage_monthly: 0.4,
          is_free_tier: true,
        },
      });
    });
    const snapshot = await openrouterUsageAdapter.query({
      ...PROFILE,
      baseUrl: "https://openrouter.ai",
      apiKey: "sk-or-test",
    });
    assert.equal(snapshot.error, undefined);
    assert.equal(snapshot.badge, "Free");
    assert.deepEqual(snapshot.bars, []);
    assert.deepEqual(snapshot.lines, [
      "Limit: unlimited",
      "d/w/m: 0/0/0.4 USD",
    ]);
  });

  it("reports HTTP errors from the key endpoint", async () => {
    stubFetch(async () => jsonResponse({ error: { message: "User not found." } }, 401));
    const snapshot = await openrouterUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-or-test",
    });
    assert.match(snapshot.error ?? "", /HTTP 401/);
  });

  it("reports missing balance data", async () => {
    stubFetch(async () => jsonResponse({ data: {} }));
    const snapshot = await openrouterUsageAdapter.query({
      ...PROFILE,
      apiKey: "sk-or-test",
    });
    assert.match(snapshot.error ?? "", /No balance data/);
  });
});
