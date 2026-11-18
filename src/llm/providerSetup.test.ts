import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  hasUsableLlmProvider,
  probeLlmModels,
} from "./providerSetup.js";

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

function textResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "Content-Type": "text/html" } });
}

describe("probeLlmModels", () => {
  it("uses the models route beside either pasted endpoint and preserves query parameters", async () => {
    for (const suffix of ["responses", "chat/completions"]) {
      const urls: string[] = [];
      stubFetch(async (input) => { urls.push(String(input)); return jsonResponse({ data: [{ id: "gpt-example" }] }); });
      assert.equal((await probeLlmModels({ baseUrl: `https://example.com/v1/${suffix}?tenant=a`, apiKey: "test" })).ok, true);
      assert.deepEqual(urls, ["https://example.com/v1/models?tenant=a"]);
    }
  });
  it("lists and sorts models from a standard { data: [{ id }] } payload", async () => {
    stubFetch(async () =>
      jsonResponse({
        object: "list",
        data: [{ id: "kimi-k3" }, { id: "deepseek-chat" }, { id: "deepseek-chat" }],
      }),
    );
    const result = await probeLlmModels({
      baseUrl: "https://api.moonshot.cn/v1",
      apiKey: "sk-test",
    });
    assert.deepEqual(result, {
      ok: true,
      models: ["deepseek-chat", "kimi-k3"],
    });
  });

  it("accepts a bare-array payload with string and object items", async () => {
    stubFetch(async () => jsonResponse(["llama-3", { id: "qwen-max" }, 42, ""]));
    const result = await probeLlmModels({
      baseUrl: "https://gw.example.com/v1",
      apiKey: "k",
    });
    assert.deepEqual(result, { ok: true, models: ["llama-3", "qwen-max"] });
  });

  it("retries /v1/models when /models 404s on a versionless base URL", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://api.deepseek.com/models") {
        return jsonResponse({ error: "not found" }, 404);
      }
      return jsonResponse({ data: [{ id: "deepseek-reasoner" }] });
    });
    const result = await probeLlmModels({
      baseUrl: "https://api.deepseek.com",
      apiKey: "sk-test",
    });
    assert.deepEqual(result, { ok: true, models: ["deepseek-reasoner"] });
    assert.deepEqual(urls, [
      "https://api.deepseek.com/models",
      "https://api.deepseek.com/v1/models",
    ]);
  });

  it("does not append /v1 when the base URL already has a version segment", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({}, 404);
    });
    const result = await probeLlmModels({
      baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
      apiKey: "k",
    });
    assert.deepEqual(result, { ok: false, reason: "http_404" });
    assert.deepEqual(urls, ["https://open.bigmodel.cn/api/paas/v4/models"]);
  });

  it("fails fast on 401 without the /v1 retry", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({ error: "bad key" }, 401);
    });
    const result = await probeLlmModels({
      baseUrl: "https://api.example.com",
      apiKey: "wrong",
    });
    assert.deepEqual(result, { ok: false, reason: "http_401" });
    assert.equal(urls.length, 1);
  });

  it("returns network when the host is unreachable (single attempt)", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      throw new Error("ECONNREFUSED");
    });
    const result = await probeLlmModels({
      baseUrl: "https://down.example.com",
      apiKey: "k",
    });
    assert.deepEqual(result, { ok: false, reason: "network" });
    assert.equal(urls.length, 1);
  });

  it("reports bad_payload when 200 answers non-JSON on every attempt", async () => {
    stubFetch(async () => textResponse("<html>login page</html>"));
    const result = await probeLlmModels({
      baseUrl: "https://proxy.example.com",
      apiKey: "k",
    });
    assert.deepEqual(result, { ok: false, reason: "bad_payload" });
  });

  it("reports no_models when the payload carries zero usable ids", async () => {
    stubFetch(async () => jsonResponse({ data: [] }));
    const result = await probeLlmModels({
      baseUrl: "https://api.example.com/v1",
      apiKey: "k",
    });
    assert.deepEqual(result, { ok: false, reason: "no_models" });
  });

  it("rejects non-http URLs without any fetch", async () => {
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return jsonResponse({});
    });
    assert.deepEqual(
      await probeLlmModels({ baseUrl: "file:///etc", apiKey: "k" }),
      { ok: false, reason: "invalid_url" },
    );
    assert.deepEqual(
      await probeLlmModels({ baseUrl: "not a url", apiKey: "k" }),
      { ok: false, reason: "invalid_url" },
    );
    assert.equal(called, 0);
  });

  it("requires an API key for non-local hosts", async () => {
    assert.deepEqual(
      await probeLlmModels({ baseUrl: "https://api.example.com/v1" }),
      { ok: false, reason: "missing_key" },
    );
  });

  it("probes local servers without a key and without an Authorization header", async () => {
    let authHeader: string | undefined;
    stubFetch(async (_input, init) => {
      authHeader = (init?.headers as Record<string, string> | undefined)?.[
        "Authorization"
      ];
      return jsonResponse({ data: [{ id: "qwen3:8b" }] });
    });
    const result = await probeLlmModels({ baseUrl: "http://localhost:11434" });
    assert.deepEqual(result, { ok: true, models: ["qwen3:8b"] });
    assert.equal(authHeader, undefined);
  });

  it("finds OpenRouter models from the site root via /api/v1/models", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://openrouter.ai/api/v1/models") {
        return jsonResponse({ data: [{ id: "openai/gpt-4o" }, { id: "anthropic/claude" }] });
      }
      return textResponse("<html>openrouter</html>");
    });
    const result = await probeLlmModels({
      baseUrl: "https://openrouter.ai",
      apiKey: "sk-or-test",
    });
    assert.deepEqual(result, {
      ok: true,
      models: ["anthropic/claude", "openai/gpt-4o"],
    });
    assert.deepEqual(urls, [
      "https://openrouter.ai/models",
      "https://openrouter.ai/v1/models",
      "https://openrouter.ai/api/v1/models",
    ]);
  });

  it("probes OpenRouter's documented base URL once", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({ data: [{ id: "openai/gpt-4o" }] });
    });
    const result = await probeLlmModels({
      baseUrl: "https://openrouter.ai/api/v1",
      apiKey: "sk-or-test",
    });
    assert.deepEqual(result, { ok: true, models: ["openai/gpt-4o"] });
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models"]);
  });

  it("tries OpenCode Go after Zen rejects a bare-host key", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://opencode.ai/zen/v1/models") {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      if (url === "https://opencode.ai/zen/go/v1/models") {
        return jsonResponse({ data: [{ id: "deepseek-v4-flash" }] });
      }
      return jsonResponse({}, 404);
    });
    const result = await probeLlmModels({
      baseUrl: "https://opencode.ai",
      apiKey: "sk-go",
    });
    assert.deepEqual(result, { ok: true, models: ["deepseek-v4-flash"] });
    assert.deepEqual(urls, [
      "https://opencode.ai/models",
      "https://opencode.ai/v1/models",
      "https://opencode.ai/zen/v1/models",
      "https://opencode.ai/zen/go/v1/models",
    ]);
  });

  it("stays on OpenCode Zen when the base URL already names it", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({ error: "unauthorized" }, 401);
    });
    const result = await probeLlmModels({
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "sk-bad",
    });
    assert.deepEqual(result, { ok: false, reason: "http_401" });
    assert.deepEqual(urls, ["https://opencode.ai/zen/v1/models"]);
  });

  it("lists OpenCode Go models from the go base URL", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://opencode.ai/zen/go/v1/models") {
        return jsonResponse({ data: [{ id: "glm-5" }] });
      }
      return jsonResponse({}, 404);
    });
    const result = await probeLlmModels({
      baseUrl: "https://opencode.ai/zen/go",
      apiKey: "sk-go",
    });
    assert.deepEqual(result, { ok: true, models: ["glm-5"] });
    assert.deepEqual(urls, [
      "https://opencode.ai/zen/go/models",
      "https://opencode.ai/zen/go/v1/models",
    ]);
  });

  it("sends the bearer key when provided", async () => {
    let authHeader: string | undefined;
    stubFetch(async (_input, init) => {
      authHeader = (init?.headers as Record<string, string> | undefined)?.[
        "Authorization"
      ];
      return jsonResponse({ data: [{ id: "m" }] });
    });
    await probeLlmModels({
      baseUrl: "https://api.example.com/v1",
      apiKey: "sk-x",
    });
    assert.equal(authHeader, "Bearer sk-x");
  });
});

describe("hasUsableLlmProvider", () => {
  const noKey = async () => false;

  it("is usable when an .env / process key exists", async () => {
    let storeChecked = 0;
    assert.equal(
      await hasUsableLlmProvider({
        providers: [],
        hasKeyInStore: async () => {
          storeChecked += 1;
          return true;
        },
        envApiKey: "sk-env",
      }),
      true,
    );
    assert.equal(storeChecked, 0);
  });

  it("treats a whitespace-only env key as absent", async () => {
    assert.equal(
      await hasUsableLlmProvider({
        providers: [],
        hasKeyInStore: noKey,
        envApiKey: "   ",
      }),
      false,
    );
  });

  it("is usable when any provider points at a local server", async () => {
    assert.equal(
      await hasUsableLlmProvider({
        providers: [
          { id: "cloud", baseUrl: "https://api.example.com/v1" },
          { id: "local", baseUrl: "http://127.0.0.1:1234/v1" },
        ],
        hasKeyInStore: noKey,
        envApiKey: null,
      }),
      true,
    );
  });

  it("is usable when a provider has a key in the encrypted store", async () => {
    assert.equal(
      await hasUsableLlmProvider({
        providers: [{ id: "deepseek", baseUrl: "https://api.deepseek.com/v1" }],
        hasKeyInStore: async (id) => id === "deepseek",
        envApiKey: null,
      }),
      true,
    );
  });

  it("is not usable when nothing matches", async () => {
    assert.equal(
      await hasUsableLlmProvider({
        providers: [{ id: "cloud", baseUrl: "https://api.example.com/v1" }],
        hasKeyInStore: noKey,
        envApiKey: null,
      }),
      false,
    );
  });
});
