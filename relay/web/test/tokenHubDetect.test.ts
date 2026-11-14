/**
 * TokenHubController.detectModels must be a real round trip.
 *
 * It used to fabricate a catalogue from the base URL's host name after a 650 ms
 * fake delay ("simulated until the relay probes /models"). These tests pin the
 * replacement: one POST to the relay's detect route, the server's model list
 * returned as-is, and every probe reason code rendered into English copy
 * instead of a made-up model.
 *
 * Note: the wizard view itself is not covered here — it borrows the desktop
 * brand icons (`*.svg`), so it cannot be loaded under Node/tsx. Its markup
 * changes are checked against the built console bundle at deploy time.
 */
import assert from "node:assert/strict";
import test from "node:test";

const { TokenHubController } = await import("../src/TokenHubController.js");

const realFetch = globalThis.fetch;

type Call = { url: string; method?: string; body: string; auth?: string; ct?: string };

function controllerWith(
  calls: Call[],
  respond: () => { status: number; payload: unknown },
): TokenHubController {
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({
      url: String(input),
      method: init?.method,
      body: typeof init?.body === "string" ? init.body : "",
      auth: headers["x-auth-token"],
      ct: headers["content-type"],
    });
    const { status, payload } = respond();
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return new TokenHubController({
    apiBase: () => "http://relay.test/",
    sessionToken: () => "sess-1",
  });
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("posts the probe request to the relay and returns the server's list verbatim", async () => {
  const calls: Call[] = [];
  const controller = controllerWith(calls, () => ({
    status: 200,
    payload: {
      ok: true,
      models: [
        { id: "kimi-k2", supportsMultimodal: false },
        { id: "kimi-vision", supportsMultimodal: true },
        { id: "" },
        7,
      ],
    },
  }));

  const models = await controller.detectModels("https://api.moonshot.cn/v1", "sk-live");

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://relay.test/api/console/token-hub/detect-models");
  assert.equal(calls[0]!.method, "POST");
  assert.equal(calls[0]!.auth, "sess-1");
  assert.equal(calls[0]!.ct, "application/json");
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    baseUrl: "https://api.moonshot.cn/v1",
    apiKey: "sk-live",
  });
  // Unusable entries are dropped; nothing is invented to fill the gap.
  assert.deepEqual(models, [
    { id: "kimi-k2", supportsMultimodal: false },
    { id: "kimi-vision", supportsMultimodal: true },
  ]);
});

test("maps each probe reason code to its own copy", async () => {
  const cases: Array<[string, RegExp]> = [
    ["invalid_url", /valid http\(s\) base URL/],
    ["missing_key", /API key required/],
    ["network", /could not reach/],
    ["blocked_target", /off-limits/],
    ["bad_payload", /listed no usable models/],
    ["no_models", /listed no usable models/],
    ["http_401", /HTTP 401 Unauthorized/],
    ["http_403", /HTTP 403 Forbidden/],
    ["http_404", /No \/models route/],
    ["http_405", /No \/models route/],
    ["http_429", /rate limited/],
    ["http_500", /gateway error/],
    ["http_418", /detection failed/],
    ["whatever", /try again or add the model ID/],
  ];
  for (const [reason, pattern] of cases) {
    const calls: Call[] = [];
    const controller = controllerWith(calls, () => ({ status: 200, payload: { ok: false, reason } }));
    await assert.rejects(
      () => controller.detectModels("https://api.moonshot.cn/v1", "sk-live"),
      pattern,
      reason,
    );
  }
});

test("an unavailable detect route is an error, not a fabricated list", async () => {
  const calls: Call[] = [];
  const controller = controllerWith(calls, () => ({ status: 404, payload: { error: "not_found" } }));
  await assert.rejects(
    () => controller.detectModels("https://api.openai.com/v1", "sk-live"),
    /not_found/,
  );
});

test("a missing session surfaces before any request", async () => {
  const calls: Call[] = [];
  const controller = controllerWith(calls, () => ({ status: 200, payload: { ok: true, models: [] } }));
  (controller as unknown as { options: { sessionToken: () => string } }).options.sessionToken = () => "";
  await assert.rejects(
    () => controller.detectModels("https://api.openai.com/v1", "sk-live"),
    /Sign in required/,
  );
  assert.equal(calls.length, 0);
});
