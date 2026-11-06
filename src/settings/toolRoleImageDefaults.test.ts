import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  resolveToolRoleImageSupport,
  type ToolRoleImageProviderInfo,
} from "./toolRoleImageDefaults.js";

const deepseekFlash: ToolRoleImageProviderInfo = {
  baseUrl: "https://api.deepseek.com/v1",
  modelId: "deepseek-flash",
  supportsMultimodal: true,
};

const glmFlash: ToolRoleImageProviderInfo = {
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  modelId: "glm-5.3-flash",
  supportsMultimodal: true,
};

describe("resolveToolRoleImageSupport (probe matrix 2026-11-05)", () => {
  it("verified list: DeepSeek vision models default on with base64 transport", () => {
    assert.deepEqual(resolveToolRoleImageSupport(deepseekFlash), {
      enabled: true,
      transport: "base64",
    });
  });

  it("DeepSeek with explicit imageInput url follows the configured channel", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...deepseekFlash, imageInput: "url" }),
      { enabled: true, transport: "url" },
    );
  });

  it("verified list: GLM-5.3-Flash defaults on with FORCED url transport (data-URI tool parts get stringified)", () => {
    assert.deepEqual(resolveToolRoleImageSupport(glmFlash), {
      enabled: true,
      transport: "url",
    });
    // Even an explicit base64 imageInput must not downgrade to data URIs.
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...glmFlash, imageInput: "base64" }),
      { enabled: true, transport: "url" },
    );
  });

  it("GLM-5.3 flagship and other bigmodel models stay off by default", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...glmFlash, modelId: "glm-5.3" }),
      { enabled: false },
    );
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...glmFlash, modelId: "glm-5.3-flashx" }),
      { enabled: false },
    );
  });

  it("explicit true enables an unlisted provider", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({
        baseUrl: "https://api.example.com/v1",
        modelId: "some-vision-model",
        supportsMultimodal: true,
        toolRoleImages: true,
        imageInput: "url",
      }),
      { enabled: true, transport: "url" },
    );
  });

  it("explicit false wins over the verified list", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...deepseekFlash, toolRoleImages: false }),
      { enabled: false },
    );
  });

  it("non-multimodal providers are never enabled", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({ ...deepseekFlash, supportsMultimodal: false }),
      { enabled: false },
    );
    assert.deepEqual(resolveToolRoleImageSupport(undefined), { enabled: false });
  });

  it("moonshot hosts follow their base64 imageInput when explicitly enabled", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({
        baseUrl: "https://api.moonshot.cn/v1",
        modelId: "kimi-latest",
        supportsMultimodal: true,
        toolRoleImages: true,
        imageInput: "base64",
      }),
      { enabled: true, transport: "base64" },
    );
  });

  it("unparsable base URLs degrade to disabled instead of throwing", () => {
    assert.deepEqual(
      resolveToolRoleImageSupport({
        baseUrl: "not a url",
        modelId: "deepseek-flash",
        supportsMultimodal: true,
      }),
      { enabled: false },
    );
  });
});
