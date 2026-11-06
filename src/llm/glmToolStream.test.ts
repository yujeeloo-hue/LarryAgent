import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  glmToolStreamBody,
  shouldEnableGlmToolStream,
} from "./glmToolStream.js";

describe("shouldEnableGlmToolStream", () => {
  it("enables on Zhipu / GLM / LKEAP hosts", () => {
    for (const baseUrl of [
      "https://open.bigmodel.cn/api/paas/v4",
      "https://api.z.ai/api/paas/v4",
      "https://open.bigmodel.cn",
      "https://lkeap.tencentcloudapi.com",
    ]) {
      assert.equal(shouldEnableGlmToolStream(baseUrl), true, baseUrl);
    }
  });

  it("enables when the model id is GLM on an unknown host", () => {
    assert.equal(
      shouldEnableGlmToolStream("https://gateway.example.com/v1", "glm-5.3"),
      true,
    );
  });

  it("stays off for OpenAI / DeepSeek", () => {
    assert.equal(
      shouldEnableGlmToolStream("https://api.openai.com/v1", "gpt-4o"),
      false,
    );
    assert.equal(
      shouldEnableGlmToolStream("https://api.deepseek.com", "deepseek-chat"),
      false,
    );
  });
});

describe("glmToolStreamBody", () => {
  it("sets tool_stream true for bigmodel", () => {
    assert.deepEqual(
      glmToolStreamBody("https://open.bigmodel.cn/api/paas/v4", "glm-5.3"),
      { tool_stream: true },
    );
  });

  it("omits the field otherwise", () => {
    assert.equal(
      glmToolStreamBody("https://api.openai.com/v1", "gpt-4o"),
      undefined,
    );
  });
});
