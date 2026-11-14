import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureCredentialsRoot, configureCredentialCipherForTests, hasApiKeyInStore, writeApiKeyToStore } from "../llm/credentials.js";
import { configureSettingsRoot } from "../settings/settingsRoot.js";
import { writeWorkspaceSettings } from "../settings/writeWorkspaceSettings.js";
import { readWorkspaceSettings } from "../settings/readWorkspaceSettings.js";
import {
  exportSyncProvider,
  listSyncProviders,
  providerMatchKey,
  removeSyncProvider,
  removeSyncProviderById,
  upsertSyncProvider,
} from "./providerSync.js";

describe("providerSync", () => {
  let root = "";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "provider-sync-"));
    configureSettingsRoot(null);
    configureCredentialsRoot(root);
    configureCredentialCipherForTests({
      mode: "plain",
      encrypt: (text) => Buffer.from(text, "utf8").toString("base64"),
      decrypt: (payload) => Buffer.from(payload, "base64").toString("utf8"),
    });
    await writeWorkspaceSettings(root, {
      providers: [{
        id: "p1",
        name: "DeepSeek Chat",
        baseUrl: "https://api.deepseek.com/v1",
        modelId: "deepseek-chat",
      }],
      activeProviderId: "p1",
    });
    await writeApiKeyToStore("sk-device-original", "p1");
  });

  afterEach(() => {
    configureCredentialCipherForTests(undefined);
    rmSync(root, { recursive: true, force: true });
  });

  it("lists public providers without API keys", async () => {
    const listed = await listSyncProviders(root);
    assert.equal(listed.length, 1);
    assert.equal(listed[0]!.apiKeyConfigured, true);
    assert.equal("apiKey" in listed[0]!, false);
    assert.equal(listed[0]!.modelId, "deepseek-chat");
  });

  it("round-trips API preferences and keeps them when an older device omits new fields", async () => {
    const transfer = { name: "P", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat", apiKey: "", supportsMultimodal: false, imageInput: "url" as const, rawEndpoint: false };
    const options = { apiProtocol: "responses" as const, responsesTools: [{ type: "web_search" }], responsesStateful: false };
    await upsertSyncProvider(root, { ...transfer, ...options });
    const first = await exportSyncProvider(root, "p1");
    for (const key of Object.keys(options) as Array<keyof typeof options>) assert.deepEqual(first[key], options[key]);
    await upsertSyncProvider(root, transfer);
    const second = (await listSyncProviders(root))[0]!;
    for (const key of Object.keys(options) as Array<keyof typeof options>) assert.deepEqual(second[key], options[key]);
    await upsertSyncProvider(root, { ...transfer, apiProtocol: "auto", responsesTools: [], responsesStateful: true });
    const cleared = await exportSyncProvider(root, "p1");
    assert.equal(cleared.apiProtocol, "auto");
    assert.deepEqual(cleared.responsesTools, []);
    assert.equal(cleared.responsesStateful, true);
  });
  it("round-trips toolRoleImages overrides and exposes the effective value", async () => {
    const glmFlash = { name: "GLM Flash", baseUrl: "https://open.bigmodel.cn/api/paas/v4", modelId: "glm-5.3-flash", apiKey: "mock", supportsMultimodal: true, imageInput: "url" as const, rawEndpoint: false };
    // No explicit flag: verified-list default applies (glm-5.3-flash → on).
    const added = await upsertSyncProvider(root, glmFlash);
    assert.equal((await exportSyncProvider(root, added.id)).toolRoleImages, undefined);
    assert.equal((await listSyncProviders(root)).find((p) => p.id === added.id)!.toolRoleImages, true);
    // Explicit false round-trips and survives an older-device sync that
    // omits the field.
    await upsertSyncProvider(root, { ...glmFlash, toolRoleImages: false });
    assert.equal((await exportSyncProvider(root, added.id)).toolRoleImages, false);
    await upsertSyncProvider(root, glmFlash);
    let settings = await readWorkspaceSettings(root);
    assert.equal(settings.providers.find((p) => p.id === added.id)!.toolRoleImages, false);
    // Explicit true also round-trips.
    await upsertSyncProvider(root, { ...glmFlash, toolRoleImages: true });
    settings = await readWorkspaceSettings(root);
    assert.equal(settings.providers.find((p) => p.id === added.id)!.toolRoleImages, true);
  });

  it("keeps query values ending in a slash through provider sync", async () => {
    const result = await upsertSyncProvider(root, {
      name: "Query endpoint", baseUrl: "https://gateway.example/custom/responses/?tenant=org/", modelId: "native",
      apiKey: "mock", rawEndpoint: true, supportsMultimodal: false, imageInput: "url", apiProtocol: "responses",
    });
    assert.equal((await exportSyncProvider(root, result.id)).baseUrl, "https://gateway.example/custom/responses/?tenant=org/");
    assert.equal((await listSyncProviders(root)).find((provider) => provider.id === result.id)!.baseUrl, "https://gateway.example/custom/responses/?tenant=org/");
  });

  it("matches by normalized Base URL + Model ID and overwrites in place", async () => {
    assert.equal(
      providerMatchKey("https://api.deepseek.com/v1/", "deepseek-chat"),
      providerMatchKey("https://api.deepseek.com/v1", "deepseek-chat"),
    );
    const result = await upsertSyncProvider(root, {
      name: "DeepSeek Renamed",
      baseUrl: "https://api.deepseek.com/v1/",
      modelId: "deepseek-chat",
      apiKey: "sk-rotated",
      supportsMultimodal: true,
      imageInput: "base64",
      rawEndpoint: true,
    });
    assert.equal(result.action, "overwritten");
    assert.equal(result.id, "p1");
    const exported = await exportSyncProvider(root, "p1");
    assert.equal(exported.name, "DeepSeek Renamed");
    assert.equal(exported.apiKey, "sk-rotated");
    assert.equal(exported.supportsMultimodal, true);
    assert.equal(exported.imageInput, "base64");
    assert.equal(exported.rawEndpoint, true);
    assert.equal(exported.baseUrl, "https://api.deepseek.com/v1/");
  });

  it("adds a new provider when Base URL + Model ID do not match", async () => {
    const result = await upsertSyncProvider(root, {
      name: "Claude",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "claude-4-sonnet",
      apiKey: "sk-new",
      supportsMultimodal: true,
      imageInput: "url",
      rawEndpoint: false,
    });
    assert.equal(result.action, "added");
    assert.notEqual(result.id, "p1");
    const listed = await listSyncProviders(root);
    assert.equal(listed.length, 2);
  });

  it("keeps the existing API key when overwrite omits a key", async () => {
    await upsertSyncProvider(root, {
      name: "DeepSeek Chat",
      baseUrl: "https://api.deepseek.com/v1",
      modelId: "deepseek-chat",
      apiKey: "",
      supportsMultimodal: false,
      imageInput: "url",
      rawEndpoint: false,
    });
    const exported = await exportSyncProvider(root, "p1");
    assert.equal(exported.apiKey, "sk-device-original");
  });

  it("removes a matched provider and refuses deleting the last one", async () => {
    await upsertSyncProvider(root, {
      name: "Claude",
      baseUrl: "https://openrouter.ai/api/v1",
      modelId: "claude-4-sonnet",
      apiKey: "sk-new",
      supportsMultimodal: false,
      imageInput: "url",
      rawEndpoint: false,
    });
    const removed = await removeSyncProvider(root, "https://api.deepseek.com/v1", "deepseek-chat");
    assert.equal(removed.removed, true);
    assert.equal(removed.id, "p1");
    await assert.rejects(
      () => removeSyncProvider(root, "https://openrouter.ai/api/v1", "claude-4-sonnet"),
      /last LLM provider/i,
    );
  });

  it("deletes the requested id among duplicate endpoint/model rows and changes the default", async () => {
    await writeWorkspaceSettings(root, {
      providers: [
        { id: "p1", name: "First", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
        { id: "p2", name: "Second", baseUrl: "https://api.deepseek.com/v1", modelId: "deepseek-chat" },
        { id: "p3", name: "Other", baseUrl: "https://example.com/v1", modelId: "other" },
      ],
      activeProviderId: "p2",
    });
    await writeApiKeyToStore("sk-second-provider", "p2");

    assert.deepEqual(await removeSyncProviderById(root, "p2"), { removed: true, id: "p2" });
    assert.deepEqual((await listSyncProviders(root)).map((provider) => provider.id), ["p1", "p3"]);
    assert.equal((await readWorkspaceSettings(root))?.activeProviderId, "p1");
    assert.equal(await hasApiKeyInStore("p2"), false);
    assert.equal((await exportSyncProvider(root, "p1")).apiKey, "sk-device-original");
  });

  it("does not delete a different row for a missing id and still protects the last provider", async () => {
    assert.deepEqual(await removeSyncProviderById(root, "missing"), { removed: false });
    assert.equal((await listSyncProviders(root))[0]!.id, "p1");
    await assert.rejects(() => removeSyncProviderById(root, "p1"), /last LLM provider/i);
    await assert.rejects(() => removeSyncProviderById(root, " "), /Provider ID is required/i);
    assert.equal(await hasApiKeyInStore("p1"), true);
  });
});
