import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { createSessionToken } from "../src/auth.ts";
import { createTokenHubEndpoints } from "../src/tokenHubEndpoints.ts";
import { TokenHubStore } from "../src/tokenHubStore.ts";

const options = { apiProtocol: "responses" as const, responsesTools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }], responsesStateful: false };
const input = { name: "Native", baseUrl: "https://api.example/v1", modelId: "gpt-example", apiKey: "mock-only", supportsMultimodal: false, multimodalSource: "manual" as const };

function assertOptions(value: unknown): void {
  const provider = value as Record<string, unknown>;
  for (const [key, expected] of Object.entries(options)) assert.deepEqual(provider[key], expected, key);
}

describe("Token Hub provider API preferences", () => {
  it("keeps trailing slashes inside query values during create, update and export", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-api-query-"));
    const store = new TokenHubStore(dir);
    try {
      const id = store.addProviders([{ ...input, baseUrl: "https://gateway.example/custom/responses/?tenant=org/", ...options }]).providers[0]!.id;
      assert.equal(store.getTransfer(id).baseUrl, "https://gateway.example/custom/responses?tenant=org/");
      store.setBaseUrl(id, "https://gateway.example/custom/responses/?tenant=next/");
      assert.equal(store.getTransfer(id).baseUrl, "https://gateway.example/custom/responses?tenant=next/");
      assert.equal(store.findByMatch("https://gateway.example/custom/responses/?tenant=next/", input.modelId)!.id, id);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it("persists and exports native settings across reopening and metadata edits", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-api-options-"));
    let store = new TokenHubStore(dir);
    try {
      const id = store.addProviders([{ ...input, ...options }]).providers[0]!.id;
      store.renameProvider(id, "Renamed");
      store.setRawEndpoint(id, true);
      store.close();
      store = new TokenHubStore(dir);
      assertOptions(store.snapshot().providers[0]);
      assertOptions(store.getTransfer(id));
      store.upsertByMatch(input);
      assertOptions(store.getTransfer(id));
      store.setApiOptions(id, { apiProtocol: "auto", responsesTools: [], responsesStateful: true });
      const reset = store.getTransfer(id);
      assert.equal(reset.apiProtocol, "auto");
      assert.deepEqual(reset.responsesTools, []);
      assert.equal(reset.responsesStateful, true);
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("upgrades a legacy SQLite table without replacing identities or credentials", () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-api-upgrade-"));
    let store = new TokenHubStore(dir);
    try {
      const id = store.addProviders([input]).providers[0]!.id;
      store.close();
      const db = new DatabaseSync(join(dir, "token-hub.db"));
      db.exec("ALTER TABLE provider DROP COLUMN api_options");
      db.close();
      store = new TokenHubStore(dir);
      assert.equal(store.available, true);
      assert.equal(store.snapshot().providers[0]!.id, id);
      assert.equal(store.getTransfer(id).apiKey, input.apiKey);
      assert.equal(store.getTransfer(id).apiProtocol, undefined);
      store.setApiOptions(id, options);
      store.close();
      store = new TokenHubStore(dir);
      assertOptions(store.getTransfer(id));
    } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
  });

  it("carries preferences through HTTP push, pull and partial PATCH", async () => {
    const dir = mkdtempSync(join(tmpdir(), "hub-api-http-"));
    const store = new TokenHubStore(dir);
    let pushed: Record<string, unknown> | undefined;
    const endpoints = createTokenHubEndpoints({
      tokenHub: store, isDeviceOnline: () => true,
      callDevice: async (_device, action, payload) => {
        if (action === "upsertSyncProvider") { pushed = payload as Record<string, unknown>; return { id: "device-p", action: "added" }; }
        if (action === "exportSyncProvider") return { ...input, ...options };
        throw new Error(`Unexpected mock RPC ${action}`);
      },
    });
    const server = createServer((req, res) => { void endpoints.handle(new URL(req.url!, "http://localhost").pathname, req, res); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const base = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/api/console/token-hub`;
    const headers = { "content-type": "application/json", "x-auth-token": createSessionToken("tester").token };
    const post = async (path: string, body: unknown, method = "POST"): Promise<Record<string, unknown>> => {
      const response = await fetch(base + path, { method, headers, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return await response.json() as Record<string, unknown>;
    };
    try {
      const id = store.addProviders([{ ...input, ...options }]).providers[0]!.id;
      await post("/devices/device-one/push", { providerId: id });
      assertOptions(pushed);
      await post(`/providers/${id}`, { baseUrl: "https://api.example/invoke/?tenant=x/", rawEndpoint: true }, "PATCH");
      assert.equal(store.getTransfer(id).baseUrl, "https://api.example/invoke/?tenant=x/");
      store.setBaseUrl(id, input.baseUrl);
      await post(`/providers/${id}`, { name: "Updated name" }, "PATCH");
      assertOptions(store.getTransfer(id));
      await post(`/providers/${id}`, { apiProtocol: "chat_completions", responsesTools: [] }, "PATCH");
      assert.equal(store.getTransfer(id).apiProtocol, "chat_completions");
      await post("/devices/device-one/pull", { providerId: "device-p" });
      assertOptions(store.getTransfer(id));
      assert.equal("apiKey" in store.snapshot().providers[0]!, false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      store.close(); rmSync(dir, { recursive: true, force: true });
    }
  });
});
