import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  chatProviderAcceptsImageUrls,
  chatProviderUsesBase64Images,
  chatProviderUsesProviderFiles,
  isMoonshotProviderBaseUrl,
  withSettingsDefaults,
  type LlmProvider,
  type WorkspaceSettings,
} from "./types.js";

function provider(overrides?: Partial<LlmProvider>): LlmProvider {
  return {
    id: "p1",
    name: "P1",
    baseUrl: "https://api.example.com/v1",
    modelId: "m1",
    ...overrides,
  };
}

function settingsWith(p: LlmProvider): WorkspaceSettings {
  return {
    providers: [p],
    activeProviderId: p.id,
  } as WorkspaceSettings;
}

describe("withSettingsDefaults imageInput", () => {
  it("omits imageInput by default (url mode)", () => {
    const resolved = withSettingsDefaults(settingsWith(provider()));
    assert.equal(resolved.providers[0]!.imageInput, undefined);
  });

  it("preserves explicit base64 imageInput", () => {
    const resolved = withSettingsDefaults(
      settingsWith(provider({ imageInput: "base64" })),
    );
    assert.equal(resolved.providers[0]!.imageInput, "base64");
  });

  it("preserves explicit file imageInput", () => {
    const resolved = withSettingsDefaults(
      settingsWith(provider({ imageInput: "file" })),
    );
    assert.equal(resolved.providers[0]!.imageInput, "file");
  });

  it("drops unknown imageInput values", () => {
    const resolved = withSettingsDefaults(
      settingsWith(
        provider({ imageInput: "bogus" as "base64" }),
      ),
    );
    assert.equal(resolved.providers[0]!.imageInput, undefined);
  });
});

describe("image input mode predicates", () => {
  it("multimodal + default mode accepts image URLs on non-Moonshot hosts", () => {
    const s = settingsWith(provider({ supportsMultimodal: true }));
    assert.equal(chatProviderAcceptsImageUrls(s, "p1"), true);
    assert.equal(chatProviderUsesBase64Images(s, "p1"), false);
  });

  it("Moonshot host never accepts image URLs, even with default imageInput", () => {
    const s = settingsWith(
      provider({
        supportsMultimodal: true,
        baseUrl: "https://api.moonshot.cn/v1",
      }),
    );
    assert.equal(chatProviderAcceptsImageUrls(s, "p1"), false);
  });

  it("Kimi coding plan host (api.kimi.com) behaves like Moonshot", () => {
    const s = settingsWith(
      provider({
        supportsMultimodal: true,
        baseUrl: "https://api.kimi.com/coding/v1",
      }),
    );
    assert.equal(chatProviderAcceptsImageUrls(s, "p1"), false);

    const fileMode = settingsWith(
      provider({
        supportsMultimodal: true,
        imageInput: "file",
        baseUrl: "https://api.kimi.com/coding/v1",
      }),
    );
    assert.equal(chatProviderUsesProviderFiles(fileMode, "p1"), true);
    assert.equal(chatProviderAcceptsImageUrls(fileMode, "p1"), false);
  });

  it("multimodal + base64 mode uses data URIs, not URLs", () => {
    const s = settingsWith(
      provider({ supportsMultimodal: true, imageInput: "base64" }),
    );
    assert.equal(chatProviderAcceptsImageUrls(s, "p1"), false);
    assert.equal(chatProviderUsesBase64Images(s, "p1"), true);
    assert.equal(chatProviderUsesProviderFiles(s, "p1"), false);
  });

  it("file mode works only on Moonshot hosts", () => {
    const moonshot = settingsWith(
      provider({
        supportsMultimodal: true,
        imageInput: "file",
        baseUrl: "https://api.moonshot.ai/v1",
      }),
    );
    assert.equal(chatProviderUsesProviderFiles(moonshot, "p1"), true);
    assert.equal(chatProviderAcceptsImageUrls(moonshot, "p1"), false);

    const other = settingsWith(
      provider({ supportsMultimodal: true, imageInput: "file" }),
    );
    assert.equal(chatProviderUsesProviderFiles(other, "p1"), false);
    // Stale "file" on a non-Moonshot host does not fall back to URL images.
    assert.equal(chatProviderAcceptsImageUrls(other, "p1"), false);
  });

  it("non-multimodal provider gets neither path", () => {
    const s = settingsWith(provider({ imageInput: "base64" }));
    assert.equal(chatProviderAcceptsImageUrls(s, "p1"), false);
    assert.equal(chatProviderUsesBase64Images(s, "p1"), false);
  });

  it("unknown provider id / null settings return false", () => {
    const s = settingsWith(provider({ supportsMultimodal: true }));
    assert.equal(chatProviderAcceptsImageUrls(s, "nope"), false);
    assert.equal(chatProviderAcceptsImageUrls(null, "p1"), false);
    assert.equal(chatProviderUsesBase64Images(undefined, "p1"), false);
  });
});

describe("isMoonshotProviderBaseUrl", () => {
  it("matches moonshot.cn / moonshot.ai hosts and subdomains", () => {
    assert.equal(isMoonshotProviderBaseUrl("https://api.moonshot.cn/v1"), true);
    assert.equal(isMoonshotProviderBaseUrl("https://api.moonshot.ai"), true);
    assert.equal(
      isMoonshotProviderBaseUrl("https://cn.api.moonshot.cn/v1/"),
      true,
    );
  });

  it("matches the Kimi coding plan host api.kimi.com and its subdomains", () => {
    assert.equal(
      isMoonshotProviderBaseUrl("https://api.kimi.com/coding/v1"),
      true,
    );
    assert.equal(isMoonshotProviderBaseUrl("https://api.kimi.com/v1"), true);
    assert.equal(isMoonshotProviderBaseUrl("https://cn.api.kimi.com/v1"), true);
  });

  it("rejects other hosts, paths that merely mention moonshot, and garbage", () => {
    assert.equal(isMoonshotProviderBaseUrl("https://api.deepseek.com/v1"), false);
    assert.equal(
      isMoonshotProviderBaseUrl("https://example.com/moonshot"),
      false,
    );
    assert.equal(
      isMoonshotProviderBaseUrl("https://example.com/kimi"),
      false,
    );
    assert.equal(isMoonshotProviderBaseUrl("not a url"), false);
    assert.equal(isMoonshotProviderBaseUrl(""), false);
    assert.equal(isMoonshotProviderBaseUrl(null), false);
    assert.equal(isMoonshotProviderBaseUrl(undefined), false);
  });
});
