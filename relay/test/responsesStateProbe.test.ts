/**
 * Token Hub Responses-state probe.
 *
 * The two-turn verification is the whole point: a gateway may accept
 * `store: true` and still drop the response, and only the follow-up turn
 * referencing the stored id can tell. Route tests drive the console
 * endpoints (wizard form + stored provider) through the same harness as the
 * detect-models route, including key hygiene and the SSRF guard.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { probeResponsesState } from "../src/responsesStateProbe.ts";
import { createTokenHubEndpoints } from "../src/tokenHubEndpoints.ts";
import { createSessionToken } from "../src/auth.ts";
import { TokenHubStore } from "../src/tokenHubStore.ts";

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

function outputResponse(id: string, text: string, extra: Record<string, unknown> = {}): Response {
  return jsonResponse({
    id,
    status: "completed",
    output: [{ type: "message", content: [{ type: "output_text", text }] }],
    ...extra,
  });
}

function probeToken(body: Record<string, unknown>): string {
  const token = /jellybot-state-[0-9a-f]+/.exec(String(body.input))?.[0];
  assert.ok(token, "first request contains the random probe token");
  return token;
}

/** A public record: keeps the guard in the loop without real DNS in tests. */
const PUBLIC_DNS = async () => ["93.184.216.34"];

const INPUT = { baseUrl: "https://gateway.example/v1", apiKey: "sk-mock", modelId: "glm-4.7" };

describe("probeResponsesState", () => {
  it("verdict stateful only when the follow-up turn can reference the stored id", async () => {
    const calls: Array<{ url: string; method: string; body: Record<string, unknown> }> = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      calls.push({ url, method: init?.method ?? "GET", body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      if (calls.length === 1) return outputResponse("resp_probe_1", "OK", { store: true });
      if (calls.length === 2) return outputResponse("resp_probe_2", probeToken(calls[0]!.body), { previous_response_id: "resp_probe_1" });
      return jsonResponse({ deleted: true });
    });
    const result = await probeResponsesState({ ...INPUT, responsesTools: [{ type: "web_search" }] }, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: true });
    assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
      "POST https://gateway.example/v1/responses",
      "POST https://gateway.example/v1/responses",
      "DELETE https://gateway.example/v1/responses/resp_probe_1",
    ]);
    assert.equal(calls[0]!.body.model, "glm-4.7");
    assert.equal(calls[0]!.body.store, true);
    assert.equal(calls[0]!.body.max_output_tokens, 256);
    assert.equal(calls[0]!.body.stream, false);
    assert.match(String(calls[0]!.body.input), /^Remember this exact token: jellybot-state-/);
    assert.deepEqual((calls[0]!.body.tools as Array<Record<string, unknown>>).map((tool) => tool.type), ["function", "web_search"]);
    assert.equal(calls[1]!.body.previous_response_id, "resp_probe_1");
    assert.match(String(calls[1]!.body.input), /What exact token/);
    assert.deepEqual(calls[1]!.body.tools, calls[0]!.body.tools);
  });

  it("rejects an HTTP 200 follow-up that does not remember the token", async () => {
    const calls: Array<Record<string, unknown>> = [];
    stubFetch(async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      calls.push(body);
      if (calls.length === 1) return outputResponse("resp_probe_1", "OK");
      if (calls.length === 2) return outputResponse("resp_probe_2", "No token.", { previous_response_id: null });
      return jsonResponse({ deleted: true });
    });
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
    assert.equal(calls.length, 3, "cleanup still runs after the semantic mismatch");
  });

  it("treats an explicit store:false create response as stateless without another POST", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls += 1;
      return outputResponse("resp_probe_1", "OK", { store: false });
    });
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
    assert.equal(calls, 1);
  });

  it("detects the store-but-drop gateways (follow-up 404) as stateless", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      const url = String(input);
      urls.push(url);
      if (urls.length === 1) return jsonResponse({ id: "resp_probe_1" });
      if (urls.length === 2) return jsonResponse({ error: "response not found" }, 404);
      return jsonResponse({ deleted: true });
    });
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
    assert.equal(urls.length, 3, "cleanup DELETE still runs");
  });

  it("treats a 400 naming previous_response_id as stateless", async () => {
    let n = 0;
    stubFetch(async () => {
      n += 1;
      if (n === 1) return jsonResponse({ id: "resp_probe_1" });
      return jsonResponse({ error: { message: "Invalid 'previous_response_id': resp_probe_1" } }, 400);
    });
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
  });

  it("chat-only gateways (404 on the first POST) are stateless without a follow-up", async () => {
    const urls: string[] = [];
    stubFetch(async (input) => {
      urls.push(String(input));
      return jsonResponse({ error: "not found" }, 404);
    });
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
    assert.equal(urls.length, 1);
  });

  it("a 400 rejecting the store parameter is stateless", async () => {
    stubFetch(async () => new Response("Unknown parameter: 'store'.", { status: 400 }));
    const result = await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS });
    assert.deepEqual(result, { ok: true, supported: false });
  });

  it("auth, network, and payload failures stay unknown with a reason", async () => {
    stubFetch(async () => jsonResponse({ error: "bad key" }, 401));
    assert.deepEqual(
      await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS }),
      { ok: false, reason: "http_401" },
    );

    stubFetch(async () => { throw new Error("tcp reset"); });
    assert.deepEqual(
      await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS }),
      { ok: false, reason: "network" },
    );

    stubFetch(async () => jsonResponse({ no: "id field" }));
    assert.deepEqual(
      await probeResponsesState(INPUT, { resolveAddresses: PUBLIC_DNS }),
      { ok: false, reason: "bad_payload" },
    );
  });

  it("raw endpoint mode posts the URL exactly as pasted", async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      urls.push(url);
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (urls.length === 1) return outputResponse("r", "OK");
      if (urls.length === 2) return outputResponse("r2", probeToken(bodies[0]!));
      return jsonResponse({ deleted: true });
    });
    const result = await probeResponsesState(
      { ...INPUT, baseUrl: "https://gateway.example/custom/endpoint?tenant=one", rawEndpoint: true },
      { resolveAddresses: PUBLIC_DNS },
    );
    assert.deepEqual(result, { ok: true, supported: true });
    assert.deepEqual(urls, [
      "https://gateway.example/custom/endpoint?tenant=one",
      "https://gateway.example/custom/endpoint?tenant=one",
      "https://gateway.example/custom/endpoint/r?tenant=one",
    ]);
  });

  it("keeps query strings and strips a pasted /responses path before rejoining", async () => {
    const urls: string[] = [];
    const bodies: Array<Record<string, unknown>> = [];
    stubFetch(async (input, init) => {
      const url = String(input);
      urls.push(url);
      bodies.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      if (urls.length === 1) return outputResponse("resp_1", "OK");
      if (urls.length === 2) return outputResponse("resp_2", probeToken(bodies[0]!));
      return jsonResponse({ deleted: true });
    });
    const result = await probeResponsesState(
      { ...INPUT, baseUrl: "https://gateway.example/v1/responses?tenant=one/" },
      { resolveAddresses: PUBLIC_DNS },
    );
    assert.deepEqual(result, { ok: true, supported: true });
    assert.deepEqual(urls, [
      "https://gateway.example/v1/responses?tenant=one/",
      "https://gateway.example/v1/responses?tenant=one/",
      "https://gateway.example/v1/responses/resp_1?tenant=one/",
    ]);
  });

  it("refuses blocked targets before any request and demands a key off localhost", async () => {
    let fetched = 0;
    stubFetch(async () => {
      fetched += 1;
      return jsonResponse({});
    });
    assert.deepEqual(
      await probeResponsesState(INPUT, { resolveAddresses: async () => ["169.254.169.254"] }),
      { ok: false, reason: "blocked_target" },
    );
    assert.deepEqual(
      await probeResponsesState({ ...INPUT, apiKey: "" }),
      { ok: false, reason: "missing_key" },
    );
    assert.deepEqual(
      await probeResponsesState({ ...INPUT, modelId: "" }),
      { ok: false, reason: "missing_model" },
    );
    assert.equal(fetched, 0);
  });
});

describe("token hub probe-state routes", () => {
  it("probes wizard form values and stored providers, auditing the host only", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "jellybot-stateprobe-"));
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
    const SECRET = "sk-state-probe-secret-never-logged";
    const post = (path: string, payload: unknown, token?: string) =>
      new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
        const req = httpRequest(
          {
            host: "127.0.0.1",
            port,
            method: "POST",
            path,
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
      const anon = await post("/api/console/token-hub/probe-responses-state", {
        baseUrl: "http://93.184.216.34/v1", modelId: "m", apiKey: SECRET,
      });
      assert.equal(anon.status, 401);

      let wizardFirst: Record<string, unknown> | undefined;
      stubFetch(async (_input, init) => {
        if (init?.method === "DELETE") return jsonResponse({ deleted: true });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        if ("previous_response_id" in body) return outputResponse("r2", probeToken(wizardFirst!));
        wizardFirst = body;
        return outputResponse("r", "OK");
      });
      const wizard = await post("/api/console/token-hub/probe-responses-state", {
        baseUrl: "http://93.184.216.34/v1", modelId: "m", apiKey: SECRET,
      }, session.token);
      assert.equal(wizard.status, 200);
      assert.deepEqual(wizard.body, { ok: true, supported: true });
      assert.equal(JSON.stringify(wizard.body).includes(SECRET), false);
      assert.match(audits.at(-1)!, /tokenHubProbeState 93.184.216.34 · stateful/);

      const invalid = await post("/api/console/token-hub/probe-responses-state", {
        baseUrl: "http://93.184.216.34/v1",
      }, session.token);
      assert.equal(invalid.status, 400);

      // Stored-provider route: the relay decrypts the stored key itself.
      const added = store.addProviders([{
        name: "Probed", baseUrl: "http://93.184.216.34/v1", modelId: "m", apiKey: SECRET,
        supportsMultimodal: false, multimodalSource: "manual", imageInput: "url", rawEndpoint: false,
        responsesTools: [{ type: "web_search" }],
      }]);
      const providerId = added.providers[0]!.id;
      let storedFirst: Record<string, unknown> | undefined;
      stubFetch(async (input, init) => {
        if (init?.method === "DELETE") return jsonResponse({ deleted: true });
        const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        assert.equal((init?.headers as Record<string, string>).Authorization, `Bearer ${SECRET}`);
        assert.ok((body.tools as Array<Record<string, unknown>>).some((tool) => tool.type === "web_search"));
        if ("previous_response_id" in body) return outputResponse("stored_2", probeToken(storedFirst!));
        storedFirst = body;
        return outputResponse("stored_1", "OK");
      });
      const stored = await post(
        `/api/console/token-hub/providers/${providerId}/probe-state`,
        {},
        session.token,
      );
      assert.equal(stored.status, 200);
      assert.deepEqual(stored.body, { ok: true, supported: true });
      assert.match(audits.at(-1)!, /tokenHubProbeState 93.184.216.34 · stateful/);

      const missing = await post(
        "/api/console/token-hub/providers/00000000-0000-4000-8000-000000000000/probe-state",
        {},
        session.token,
      );
      assert.equal(missing.status, 404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close();
      rmSync(dataDir, { recursive: true, force: true });
      globalThis.fetch = realFetch;
    }
  });
});
