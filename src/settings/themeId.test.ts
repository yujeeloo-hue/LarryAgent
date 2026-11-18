import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWorkspaceSettings } from "./readWorkspaceSettings.js";
import { resolveThemeId, withSettingsDefaults } from "./types.js";
import { normalizeWorkspaceSettings } from "./writeWorkspaceSettings.js";

const BASE_PROVIDERS = [
  {
    id: "default",
    name: "Default",
    baseUrl: "https://api.openai.com/v1",
    modelId: "gpt-4o-mini",
  },
];

describe("themeId settings", () => {
  it("defaults to dark when unset", () => {
    assert.equal(resolveThemeId({} as never), "dark");
  });

  it("resolves known ids", () => {
    assert.equal(resolveThemeId({ themeId: "light" } as never), "light");
    assert.equal(resolveThemeId({ themeId: "dark" } as never), "dark");
  });

  it("migrates the removed graphite id to dark", () => {
    assert.equal(resolveThemeId({ themeId: "graphite" } as never), "dark");
  });

  it("falls back to dark for unknown ids", () => {
    assert.equal(resolveThemeId({ themeId: "solar" } as never), "dark");
    assert.equal(resolveThemeId({ themeId: 42 } as never), "dark");
  });

  it("survives withSettingsDefaults round trip", () => {
    const resolved = withSettingsDefaults({
      providers: [
        {
          id: "default",
          name: "Default",
          baseUrl: "https://api.openai.com/v1",
          modelId: "gpt-4o-mini",
        },
      ],
      activeProviderId: "default",
      themeId: "light",
    });
    assert.equal(resolved.themeId, "light");
  });

  it("survives normalizeWorkspaceSettings (persistence whitelist)", () => {
    const normalized = normalizeWorkspaceSettings({
      providers: BASE_PROVIDERS,
      activeProviderId: "default",
      themeId: "light",
    });
    assert.ok(normalized);
    assert.equal(normalized!.themeId, "light");
  });

  it("drops invalid theme ids during normalization", () => {
    const normalized = normalizeWorkspaceSettings({
      providers: BASE_PROVIDERS,
      activeProviderId: "default",
      themeId: "solar",
    });
    assert.ok(normalized);
    assert.equal(normalized!.themeId, undefined);
    const legacy = normalizeWorkspaceSettings({
      providers: BASE_PROVIDERS,
      activeProviderId: "default",
      themeId: "graphite",
    });
    assert.ok(legacy);
    assert.equal(legacy!.themeId, undefined);
  });

  it("parseWorkspaceSettings preserves themeId on read", () => {
    const parsed = parseWorkspaceSettings(
      JSON.stringify({
        providers: BASE_PROVIDERS,
        activeProviderId: "default",
        themeId: "light",
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed!.themeId, "light");
  });

  it("parseWorkspaceSettings drops the removed graphite id", () => {
    const parsed = parseWorkspaceSettings(
      JSON.stringify({
        providers: BASE_PROVIDERS,
        activeProviderId: "default",
        themeId: "graphite",
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed!.themeId, undefined);
  });

  it("resolveThemeId surfaces persisted themeId", () => {
    assert.equal(resolveThemeId({ themeId: "light" } as never), "light");
  });
});
