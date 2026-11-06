import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeWorkspaceSettings,
  resolveVisionProvider,
  withSettingsDefaults,
} from "./index.js";
import type { WorkspaceSettings } from "./types.js";

const SETTINGS: WorkspaceSettings = {
  providers: [
    {
      id: "chat",
      name: "Chat",
      baseUrl: "https://api.example.com/v1",
      modelId: "chat-model",
    },
    {
      id: "mm",
      name: "Multimodal",
      baseUrl: "https://mm.example.com/v1",
      modelId: "mm-model",
      supportsMultimodal: true,
    },
  ],
  activeProviderId: "chat",
  visionProviderId: "mm",
};

describe("visionProviderId resolution", () => {
  it("resolves the referenced multimodal provider", () => {
    const vision = resolveVisionProvider(SETTINGS);
    assert.equal(vision?.id, "mm");
    assert.equal(vision?.modelId, "mm-model");
    assert.equal(vision?.baseUrl, "https://mm.example.com/v1");
  });

  it("returns null when the referenced provider lacks Multimodal", () => {
    assert.equal(
      resolveVisionProvider({ ...SETTINGS, visionProviderId: "chat" }),
      null,
    );
  });

  it("returns null for unknown or unset ids", () => {
    assert.equal(
      resolveVisionProvider({ ...SETTINGS, visionProviderId: "gone" }),
      null,
    );
    assert.equal(
      resolveVisionProvider({ ...SETTINGS, visionProviderId: null }),
      null,
    );
    const { visionProviderId: omitted, ...withoutVision } = SETTINGS;
    void omitted;
    assert.equal(resolveVisionProvider(withoutVision), null);
  });

  it("resolved defaults drop dangling ids", () => {
    const resolved = withSettingsDefaults({
      ...SETTINGS,
      visionProviderId: "gone",
    });
    assert.equal(resolved.visionProviderId, null);
    assert.equal(resolved.providers.length, 2);
  });

  it("persistence rejects ids that reference no provider", () => {
    const normalized = normalizeWorkspaceSettings({
      ...SETTINGS,
      visionProviderId: "gone",
    });
    assert.ok(normalized);
    assert.equal(normalized.visionProviderId, null);
  });
});
