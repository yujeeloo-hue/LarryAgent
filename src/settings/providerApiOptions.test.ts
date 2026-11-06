import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { disableResponsesStateful, normalizeWorkspaceSettings, readWorkspaceSettings, writeWorkspaceSettings, withSettingsDefaults } from "./index.js";

describe("provider API preference persistence", () => {
  const options = { apiProtocol: "responses" as const, responsesTools: [{ type: "web_search" }, { type: "code_interpreter", container: { type: "auto" } }], responsesStateful: false };
  const settings = { providers: [{ id: "p", name: "P", baseUrl: "https://gateway.example/v1", modelId: "m", ...options }], activeProviderId: "p" };
  it("survives normalize/defaults and JSON round trips", () => {
    const normalized = normalizeWorkspaceSettings(settings)!;
    const revived = withSettingsDefaults(normalizeWorkspaceSettings(JSON.parse(JSON.stringify(normalized))));
    assert.deepEqual(revived.providers[0], settings.providers[0]);
  });
  it("preserves explicit Auto and leaves missing preferences sparse", () => {
    assert.equal(withSettingsDefaults({ ...settings, providers: [{ ...settings.providers[0]!, apiProtocol: "auto" }] }).providers[0]!.apiProtocol, "auto");
    const provider = { id: "p", name: "P", baseUrl: "https://api.openai.com/v1", modelId: "m" };
    assert.deepEqual(withSettingsDefaults({ providers: [provider], activeProviderId: "p" }).providers[0], provider);
  });
  it("writes and reads hosted tools and stateless mode through the real settings file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellybot-provider-api-"));
    try {
      await writeWorkspaceSettings(dir, settings);
      assert.deepEqual((await readWorkspaceSettings(dir))!.providers[0], settings.providers[0]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("preserves query values ending in a slash through normalization and real disk reads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellybot-provider-query-"));
    const provider = { ...settings.providers[0]!, baseUrl: "https://gateway.example/custom/responses/?tenant=org/", rawEndpoint: true };
    try {
      await writeWorkspaceSettings(dir, { ...settings, providers: [provider] });
      const read = await readWorkspaceSettings(dir);
      assert.equal(read!.providers[0]!.baseUrl, provider.baseUrl);
      assert.equal(withSettingsDefaults(read).providers[0]!.baseUrl, provider.baseUrl);
      assert.equal(read!.providers[0]!.rawEndpoint, true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it("disables only an explicitly enabled provider under the settings write lock", async () => {
    const dir = await mkdtemp(join(tmpdir(), "jellybot-provider-state-disable-"));
    const other = { ...settings.providers[0]!, id: "other", responsesStateful: true };
    try {
      await writeWorkspaceSettings(dir, {
        ...settings,
        providers: [{ ...settings.providers[0]!, responsesStateful: true }, other],
      });
      assert.equal(await disableResponsesStateful(dir, "p"), true);
      assert.equal(await disableResponsesStateful(dir, "p"), false);
      const saved = await readWorkspaceSettings(dir);
      assert.equal(saved!.providers.find((provider) => provider.id === "p")!.responsesStateful, false);
      assert.equal(saved!.providers.find((provider) => provider.id === "other")!.responsesStateful, true);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
