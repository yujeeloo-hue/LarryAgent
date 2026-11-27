import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeWorkspaceSettings,
  withSettingsDefaults,
} from "./index.js";
import type { WorkspaceSettings } from "./types.js";

const BASE_SETTINGS = {
  providers: [
    {
      id: "default",
      name: "Default",
      baseUrl: "https://api.openai.com/v1",
      modelId: "gpt-4o-mini",
    },
  ],
  activeProviderId: "default",
};

function withLegacySummary(
  summaryProvider: unknown,
): WorkspaceSettings {
  return {
    ...BASE_SETTINGS,
    summaryProvider,
  } as WorkspaceSettings;
}

describe("removed summaryProvider settings", () => {
  it("ignores legacy summaryProvider residue when normalizing", () => {
    const normalized = normalizeWorkspaceSettings(
      withLegacySummary({
        id: "summary",
        name: "Local Summary",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "llama3.2",
      }),
    );
    assert.ok(normalized);
    assert.ok(
      !("summaryProvider" in normalized),
      "summaryProvider should not be persisted",
    );
    const json = JSON.stringify(normalized);
    assert.ok(!json.includes("summaryProvider"));
  });

  it("resolved settings carry no summaryProvider when disk has residue", () => {
    const resolved = withSettingsDefaults(
      withLegacySummary({
        id: "summary",
        name: "Summary",
        baseUrl: "http://127.0.0.1:11434/v1/",
        modelId: "llama3.2",
      }),
    );
    assert.ok(
      !("summaryProvider" in resolved),
      "resolved settings must not expose summaryProvider",
    );
    assert.equal(resolved.providers.length, 1);
    assert.equal(resolved.activeProviderId, "default");
    assert.equal(resolved.visionProviderId, null);
  });

  it("null legacy summaryProvider is equally ignored", () => {
    const resolved = withSettingsDefaults(withLegacySummary(null));
    assert.ok(!("summaryProvider" in resolved));
  });
});
