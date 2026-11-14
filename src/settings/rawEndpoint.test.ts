import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeWorkspaceSettings,
  resolveVisionProvider,
  withSettingsDefaults,
} from "./index.js";
import type { WorkspaceSettings } from "./types.js";

const BASE_SETTINGS: WorkspaceSettings = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
      rawEndpoint: true,
    },
    {
      id: "gateway",
      name: "Gateway",
      baseUrl: "https://gw.example.com/full/endpoint",
      modelId: "some-model",
    },
    {
      id: "vision-mm",
      name: "Vision MM",
      baseUrl: "https://vision.example.com/endpoint",
      modelId: "vision-model",
      supportsMultimodal: true,
      rawEndpoint: true,
    },
  ],
  activeProviderId: "default",
  visionProviderId: "vision-mm",
};

describe("provider rawEndpoint setting", () => {
  it("normalizeWorkspaceSettings keeps rawEndpoint flag per provider", () => {
    const normalized = normalizeWorkspaceSettings(BASE_SETTINGS);
    assert.ok(normalized);
    assert.equal(normalized.providers[0]?.rawEndpoint, true);
    // Absent flag stays absent (default append behavior).
    assert.ok(!("rawEndpoint" in (normalized.providers[1] ?? {})));
    assert.equal(normalized.providers[2]?.rawEndpoint, true);
    assert.equal(normalized.visionProviderId, "vision-mm");
  });

  it("JSON round-trip preserves rawEndpoint", () => {
    const normalized = normalizeWorkspaceSettings(BASE_SETTINGS);
    assert.ok(normalized);
    const revived = normalizeWorkspaceSettings(
      JSON.parse(JSON.stringify(normalized)) as unknown,
    );
    assert.ok(revived);
    assert.equal(revived.providers[0]?.rawEndpoint, true);
    assert.equal(revived.providers[2]?.rawEndpoint, true);
    assert.equal(revived.visionProviderId, "vision-mm");
  });

  it("withSettingsDefaults passes rawEndpoint through to runtime", () => {
    const resolved = withSettingsDefaults(BASE_SETTINGS);
    assert.equal(resolved.providers[0]?.rawEndpoint, true);
    assert.ok(!("rawEndpoint" in (resolved.providers[1] ?? {})));
    assert.equal(resolved.providers[2]?.rawEndpoint, true);
    assert.equal(resolveVisionProvider(BASE_SETTINGS)?.rawEndpoint, true);
  });

  it("non-boolean rawEndpoint values are dropped", () => {
    const normalized = normalizeWorkspaceSettings({
      ...BASE_SETTINGS,
      providers: [
        {
          id: "bad",
          name: "Bad",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4o-mini",
          rawEndpoint: "yes",
        },
      ],
    } as unknown as WorkspaceSettings);
    assert.ok(normalized);
    assert.ok(!("rawEndpoint" in (normalized.providers[0] ?? {})));
  });
});
