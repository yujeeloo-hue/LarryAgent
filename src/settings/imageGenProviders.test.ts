import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseWorkspaceSettings } from "./readWorkspaceSettings.js";
import { normalizeWorkspaceSettings } from "./writeWorkspaceSettings.js";
import {
  resolveImageGenProvider,
  withSettingsDefaults,
  type ImageGenProvider,
  type WorkspaceSettings,
} from "./types.js";

const BASE_SETTINGS: WorkspaceSettings = {
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

describe("imageGenProviders settings", () => {
  it("parses multi-profile lists and keeps the active id", () => {
    const parsed = parseWorkspaceSettings(
      JSON.stringify({
        ...BASE_SETTINGS,
        imageGenProviders: [
          {
            id: "imagegen",
            name: "Zhipu",
            baseUrl: "https://open.bigmodel.cn/api/paas/v4/",
            modelId: "cogview-4-250304",
          },
          {
            id: "ark",
            name: "Ark Seedream",
            baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
            modelId: "doubao-seedream-5-0-pro-260628",
            watermark: false,
            imageInput: "url",
          },
        ],
        activeImageGenProviderId: "ark",
      }),
    );
    assert.ok(parsed);
    assert.equal(parsed.imageGenProviders?.length, 2);
    assert.equal(parsed.imageGenProviders?.[0]?.baseUrl, "https://open.bigmodel.cn/api/paas/v4");
    assert.equal(parsed.activeImageGenProviderId, "ark");
    // watermark survives the round-trip only when explicitly boolean.
    assert.ok(!("watermark" in (parsed.imageGenProviders?.[0] ?? {})));
    assert.equal(parsed.imageGenProviders?.[1]?.watermark, false);
    assert.equal(parsed.imageGenProviders?.[1]?.imageInput, "url");
    assert.ok(
      !("imageInput" in (parsed.imageGenProviders?.[0] ?? {})),
      "imageInput omitted when unset",
    );
  });

  it("migrates the legacy single imageGenProvider with the stable imagegen id", () => {
    const parsed = parseWorkspaceSettings(
      JSON.stringify({
        ...BASE_SETTINGS,
        imageGenProvider: {
          id: "imagegen",
          name: "Zhipu",
          baseUrl: "https://open.bigmodel.cn/api/paas/v4",
          modelId: "cogview-4-250304",
        },
      }),
    );
    assert.ok(parsed);
    const migrated = withSettingsDefaults(parsed);
    assert.equal(migrated.imageGenProviders.length, 1);
    assert.equal(migrated.imageGenProviders[0]?.id, "imagegen");
    assert.equal(migrated.activeImageGenProviderId, "imagegen");
  });

  it("resolves the active profile and falls back to the first entry", () => {
    const zhipu: ImageGenProvider = {
      id: "imagegen",
      name: "Zhipu",
      baseUrl: "https://open.bigmodel.cn/api/paas/v4",
      modelId: "cogview-4-250304",
    };
    const ark: ImageGenProvider = {
      id: "ark",
      name: "Ark",
      baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
      modelId: "doubao-seedream-5-0-pro-260628",
      watermark: true,
    };
    const settings: WorkspaceSettings = {
      ...BASE_SETTINGS,
      imageGenProviders: [zhipu, ark],
      activeImageGenProviderId: "ark",
    };
    assert.equal(resolveImageGenProvider(settings)?.id, "ark");
    assert.equal(resolveImageGenProvider(settings)?.watermark, true);

    const staleActive: WorkspaceSettings = {
      ...BASE_SETTINGS,
      imageGenProviders: [zhipu, ark],
      activeImageGenProviderId: "deleted-id",
    };
    assert.equal(resolveImageGenProvider(staleActive)?.id, "imagegen");

    assert.equal(
      resolveImageGenProvider({ ...BASE_SETTINGS, imageGenProviders: [] }),
      null,
    );
  });

  it("normalizeWorkspaceSettings drops incomplete entries and fixes active id", () => {
    const normalized = normalizeWorkspaceSettings({
      ...BASE_SETTINGS,
      imageGenProviders: [
        {
          id: "ok",
          name: "Ok",
          baseUrl: "https://ok.example.com/v1",
          modelId: "m",
          rawEndpoint: true,
        },
        { id: "bad", name: "", baseUrl: "https://x.example.com", modelId: "m" },
      ],
      activeImageGenProviderId: "bad",
    });
    assert.ok(normalized);
    assert.equal(normalized.imageGenProviders?.length, 1);
    assert.equal(normalized.imageGenProviders?.[0]?.id, "ok");
    assert.equal(normalized.imageGenProviders?.[0]?.rawEndpoint, true);
    assert.equal(normalized.activeImageGenProviderId, "ok");
  });

  it("JSON round-trip preserves watermark tri-state per profile", () => {
    const normalized = normalizeWorkspaceSettings({
      ...BASE_SETTINGS,
      imageGenProviders: [
        {
          id: "a",
          name: "A",
          baseUrl: "https://a.example.com/v1",
          modelId: "m1",
        },
        {
          id: "b",
          name: "B",
          baseUrl: "https://b.example.com/v1",
          modelId: "m2",
          watermark: true,
        },
        {
          id: "c",
          name: "C",
          baseUrl: "https://c.example.com/v1",
          modelId: "m3",
          watermark: false,
        },
      ],
      activeImageGenProviderId: "b",
    });
    assert.ok(normalized);
    const revived = parseWorkspaceSettings(
      JSON.stringify(normalized),
    );
    assert.ok(revived);
    assert.ok(!("watermark" in (revived.imageGenProviders?.[0] ?? {})));
    assert.equal(revived.imageGenProviders?.[1]?.watermark, true);
    assert.equal(revived.imageGenProviders?.[2]?.watermark, false);
  });
});
