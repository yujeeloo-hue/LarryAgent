/**
 * Token Hub model detection.
 *
 * Two halves: the ported desktop-probe behaviour (must stay identical to
 * `src/llm/providerSetup.ts`, since the same gateways are behind both entry
 * points) and the relay-only guards — SSRF ranges, no redirect following,
 * overall deadline — plus the console route's key hygiene.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
  isBlockedAddress,
  modelSupportsVision,
  probeLlmModels,
} from "../src/modelProbe.ts";
import { createTokenHubEndpoints } from "../src/tokenHubEndpoints.ts";
import { createSessionToken } from "../src/auth.ts";
import { TokenHubStore } from "../src/tokenHubStore.ts";

const realFetch = globalThis.fetch;

after(() => {
  globalThis.fetch = realFetch;
});

it("lists models beside a pasted Responses endpoint without dropping query parameters", async () => {
  const urls: string[] = [];
  stubFetch(async (input) => { urls.push(String(input)); return jsonResponse({ data: [{ id: "native-example" }] }); });
  const result = await probeLlmModels({ baseUrl: "https://gateway.example/v1/responses?tenant=one/", apiKey: "mock" }, { resolveAddresses: async () => ["1.1.1.1"] });
  assert.deepEqual(result, { ok: true, models: ["native-example"] });
  assert.deepEqual(urls, ["https://gateway.example/v1/models?tenant=one/"]);
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

/** A public record: keeps the guard in the loop without real DNS in tests. */
const PUBLIC_DNS = async () => ["93.184.216.34"];

function probe(
  baseUrl: string,
  apiKey = "sk-test",
  options?: { deadlineMs?: number; resolveAddresses?: () => Promise<string[]> },
) {
  return probeLlmModels(
    { baseUrl, apiKey },
    { resolveAddresses: PUBLIC_DNS, ...options },
  );
}

describe("probeLlmModels — parity with the desktop wizard prober", () => {
  it("lists and sorts models from a standard { data: [{ id }] } payload", async () => {
    stubFetch(async () =>
      jsonResponse({
        object: "list",
        data: [{ id: "kimi-k3" }, { id: "deepseek-chat" }, { id: "deepseek-chat" }],
      }),
    );
    assert.deepEqual(await probe("https://api.moonshot.cn/v1"), {
      ok: true,
      models: ["deepseek-chat", "kimi-k3"],
    });
  });

  it("accepts a bare-array payload with string and object items", async () => {
    stubFetch(async () => jsonResponse(["llama-3", { id: "qwen-max" }, 42, ""]));
    assert.deepEqual(await probe("https://gw.example.com/v1"), {
      ok: true,
      models: ["llama-3", "qwen-max"],
    });
  });

  it("retries /v1/models when /models 404s on a versionless base URL", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://api.deepseek.com/models") return jsonResponse({ error: "not found" }, 404);
      return jsonResponse({ data: [{ id: "deepseek-reasoner" }] });
    });
    assert.deepEqual(await probe("https://api.deepseek.com"), {
      ok: true,
      models: ["deepseek-reasoner"],
    });
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
    assert.deepEqual(await probe("https://open.bigmodel.cn/api/paas/v4/"), {
      ok: false,
      reason: "http_404",
    });
    assert.deepEqual(urls, ["https://open.bigmodel.cn/api/paas/v4/models"]);
  });

  it("fails fast on 401 without the /v1 retry", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({ error: "bad key" }, 401);
    });
    assert.deepEqual(await probe("https://api.example.com", "wrong"), {
      ok: false,
      reason: "http_401",
    });
    assert.equal(urls.length, 1);
  });

  it("returns network when the host is unreachable (single attempt)", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      throw new Error("ECONNREFUSED");
    });
    assert.deepEqual(await probe("https://down.example.com"), {
      ok: false,
      reason: "network",
    });
    assert.equal(urls.length, 1);
  });

  it("reports bad_payload when 200 answers non-JSON on every attempt", async () => {
    stubFetch(async () => textResponse("<html>login page</html>"));
    assert.deepEqual(await probe("https://proxy.example.com"), {
      ok: false,
      reason: "bad_payload",
    });
  });

  it("reports no_models when the payload carries zero usable ids", async () => {
    stubFetch(async () => jsonResponse({ data: [] }));
    assert.deepEqual(await probe("https://api.example.com/v1"), {
      ok: false,
      reason: "no_models",
    });
  });

  it("rejects non-http URLs without any fetch", async () => {
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return jsonResponse({});
    });
    assert.deepEqual(await probe("file:///etc"), { ok: false, reason: "invalid_url" });
    assert.deepEqual(await probe("not a url"), { ok: false, reason: "invalid_url" });
    assert.equal(called, 0);
  });

  it("requires an API key for non-local hosts", async () => {
    assert.deepEqual(await probe("https://api.example.com/v1", ""), {
      ok: false,
      reason: "missing_key",
    });
  });

  it("probes local servers without a key and without an Authorization header", async () => {
    let authHeader: string | undefined;
    stubFetch(async (_input, init) => {
      authHeader = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return jsonResponse({ data: [{ id: "qwen3:8b" }] });
    });
    // No injected resolver: exercises the real localhost path.
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
    assert.deepEqual(await probe("https://openrouter.ai", "sk-or-test"), {
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
    assert.deepEqual(await probe("https://openrouter.ai/api/v1", "sk-or-test"), {
      ok: true,
      models: ["openai/gpt-4o"],
    });
    assert.deepEqual(urls, ["https://openrouter.ai/api/v1/models"]);
  });

  it("tries OpenCode Go after Zen rejects a bare-host key", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://opencode.ai/zen/v1/models") return jsonResponse({ error: "unauthorized" }, 401);
      if (url === "https://opencode.ai/zen/go/v1/models") {
        return jsonResponse({ data: [{ id: "deepseek-v4-flash" }] });
      }
      return jsonResponse({}, 404);
    });
    assert.deepEqual(await probe("https://opencode.ai", "sk-go"), {
      ok: true,
      models: ["deepseek-v4-flash"],
    });
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
    assert.deepEqual(await probe("https://opencode.ai/zen/v1", "sk-bad"), {
      ok: false,
      reason: "http_401",
    });
    assert.deepEqual(urls, ["https://opencode.ai/zen/v1/models"]);
  });

  it("lists OpenCode Go models from the go base URL", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (url === "https://opencode.ai/zen/go/v1/models") return jsonResponse({ data: [{ id: "glm-5" }] });
      return jsonResponse({}, 404);
    });
    assert.deepEqual(await probe("https://opencode.ai/zen/go", "sk-go"), {
      ok: true,
      models: ["glm-5"],
    });
    assert.deepEqual(urls, [
      "https://opencode.ai/zen/go/models",
      "https://opencode.ai/zen/go/v1/models",
    ]);
  });

  it("sends the bearer key and a non-node User-Agent", async () => {
    let authHeader: string | undefined;
    let agent: string | undefined;
    stubFetch(async (_input, init) => {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      authHeader = headers.Authorization;
      agent = headers["User-Agent"];
      return jsonResponse({ data: [{ id: "m" }] });
    });
    await probe("https://api.example.com/v1", "sk-x");
    assert.equal(authHeader, "Bearer sk-x");
    assert.equal(agent, "JellyBotRelay/models-probe");
  });
});

describe("probeLlmModels — relay guards", () => {
  it("refuses link-local / metadata addresses before any request", async () => {
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return jsonResponse({ data: [{ id: "x" }] });
    });
    for (const url of [
      "http://169.254.169.254/latest/meta-data",
      "http://100.100.100.200",
      "http://[::ffff:a9fe:a9fe]",
      "http://[::ffff:169.254.169.254]",
    ]) {
      // Address literals go through the real resolver (no DNS needed), so the
      // guard is exercised end to end rather than only through the injected one.
      assert.deepEqual(
        await probeLlmModels({ baseUrl: url, apiKey: "sk-test" }),
        { ok: false, reason: "blocked_target" },
        url,
      );
    }
    assert.equal(called, 0);
  });

  it("refuses metadata hostnames and .internal names", async () => {
    stubFetch(async () => jsonResponse({ data: [] }));
    assert.deepEqual(await probe("http://metadata.google.internal"), {
      ok: false,
      reason: "blocked_target",
    });
    assert.deepEqual(await probe("http://relay.corp.internal/v1"), {
      ok: false,
      reason: "blocked_target",
    });
  });

  it("refuses when a hostname resolves to a blocked record", async () => {
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return jsonResponse({ data: [{ id: "x" }] });
    });
    const result = await probe("https://rebind.example", "k", {
      resolveAddresses: async () => ["93.184.216.34", "169.254.169.254"],
    });
    assert.deepEqual(result, { ok: false, reason: "blocked_target" });
    assert.equal(called, 0);
  });

  it("still reaches loopback and LAN gateways (self-hosted relay probing ollama)", async () => {
    stubFetch(async () => jsonResponse({ data: [{ id: "qwen3:32b" }] }));
    assert.deepEqual(
      await probeLlmModels({ baseUrl: "http://192.168.31.47:11434/v1", apiKey: "sk-lan" }),
      { ok: true, models: ["qwen3:32b"] },
    );
  });

  it("does not follow redirects — a 302 is reported, not chased", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return new Response(null, {
        status: 302,
        headers: { Location: "http://169.254.169.254/" },
      });
    });
    assert.deepEqual(await probe("https://bounce.example/v1"), {
      ok: false,
      reason: "blocked_target",
    });
    assert.deepEqual(urls, ["https://bounce.example/v1/models"]);
  });

  it("stops without any attempt once the deadline is spent", async () => {
    let called = 0;
    stubFetch(async () => {
      called += 1;
      return jsonResponse({ data: [{ id: "x" }] });
    });
    assert.deepEqual(await probe("https://slow.example.com", "k", { deadlineMs: 0 }), {
      ok: false,
      reason: "network",
    });
    assert.equal(called, 0);
  });

  it("classifies addresses by the documented ranges", () => {
    const blocked = [
      "0.0.0.0",
      "169.254.169.254",
      "100.100.100.200",
      "192.0.2.1",
      "198.51.100.4",
      "203.0.113.9",
      "224.0.0.1",
      "::",
      "fe80::1",
      "ff02::1",
      "2001:db8::1",
      "::ffff:169.254.169.254",
    ];
    const allowed = [
      "93.184.216.34",
      "127.0.0.1",
      "::1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.31.47",
      "fd12::3456",
    ];
    for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, ip);
    for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, ip);
    // Anything unclassifiable is refused, not waved through.
    assert.equal(isBlockedAddress("not-an-ip"), true);
    assert.equal(isBlockedAddress("[::ffff:7f00:1]"), false); // mapped loopback
    assert.equal(isBlockedAddress("[::ffff:fe80:1]"), true); // mapped link-local
  });

  it("tags vision models from the id only", () => {
    assert.equal(modelSupportsVision("gpt-4o"), true);
    assert.equal(modelSupportsVision("qwen-vl-max"), true);
    assert.equal(modelSupportsVision("gemini-2.5-flash"), true);
    assert.equal(modelSupportsVision("kimi-k2"), true);
    assert.equal(modelSupportsVision("deepseek-chat"), false);
    assert.equal(modelSupportsVision("bge-m3"), false);
  });
});

describe("token hub detect-models route", () => {
  it("probes through the relay, audits the host only, and keeps the key out", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jellybot-detect-"));
    const store = new TokenHubStore(dataDir);
    const audits: string[] = [];
    const endpoints = createTokenHubEndpoints({
      tokenHub: store,
      onAudit: (actor, action, detail) => audits.push(`${actor} ${action} ${detail ?? ""}`),
    });
    const server = createServer((req, res) => {
      void endpoints.handle(new URL(req.url ?? "/", "http://localhost").pathname, req, res);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    const session = createSessionToken("tester");
    const SECRET = "sk-route-probe-secret-never-logged";
    // Drive the route with node:http, not global fetch: the probe inside the
    // endpoint is what owns the stubbed fetch in this process.
    const post = (payload: unknown, token?: string) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/console/token-hub/detect-models",
            headers: {
              "content-type": "application/json",
              ...(token ? { "x-auth-token": token } : {}),
            },
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on("data", (chunk: Buffer) => chunks.push(chunk));
            res.on("end", () => {
              const text = Buffer.concat(chunks).toString("utf8");
              resolve({
                status: res.statusCode ?? 0,
                body: text ? (JSON.parse(text) as Record<string, unknown>) : {},
              });
            });
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(payload));
      });

    try {
      const anon = await post({ baseUrl: "http://93.184.216.34/v1", apiKey: SECRET });
      assert.equal(anon.status, 401);

      stubFetch(async () =>
        jsonResponse({ data: [{ id: "gpt-4o" }, { id: "deepseek-chat" }] }),
      );
      const ok = await post({ baseUrl: "http://93.184.216.34/v1", apiKey: SECRET }, session.token);
      assert.equal(ok.status, 200);
      const body = ok.body as unknown as {
        ok: boolean;
        models: Array<{ id: string; supportsMultimodal: boolean }>;
      };
      assert.equal(body.ok, true);
      assert.deepEqual(body.models, [
        { id: "deepseek-chat", supportsMultimodal: false },
        { id: "gpt-4o", supportsMultimodal: true },
      ]);
      assert.equal(JSON.stringify(body).includes(SECRET), false);

      stubFetch(async () => jsonResponse({ error: "bad key" }, 401));
      const bad = await post({ baseUrl: "http://93.184.216.34/v1", apiKey: SECRET }, session.token);
      assert.deepEqual(bad.body, { ok: false, reason: "http_401" });

      const blocked = await post({ baseUrl: "http://169.254.169.254", apiKey: SECRET }, session.token);
      assert.deepEqual(blocked.body, { ok: false, reason: "blocked_target" });

      const missing = await post({ apiKey: SECRET }, session.token);
      assert.equal(missing.status, 400);

      assert.equal(audits.some((line) => line.includes("tokenHubDetect") && line.includes("93.184.216.34")), true);
      assert.equal(audits.some((line) => line.includes("failed: http_401")), true);
      assert.equal(audits.some((line) => line.includes("failed: blocked_target")), true);
      assert.equal(audits.some((line) => line.includes(SECRET)), false);
    } finally {
      server.close();
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
