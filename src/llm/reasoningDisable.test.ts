import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  noReasoningExtraBody,
  reasoningDisableExtraBody,
} from "./reasoningDisable.js";

describe("reasoningDisableExtraBody", () => {
  it("DeepSeek: thinking disabled + reasoning_effort low fallback", () => {
    const body = reasoningDisableExtraBody("https://api.deepseek.com");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.reasoning_effort, "low");
    assert.equal("enableReasoning" in body, false);
  });

  it("GLM / LKEAP: enableReasoning false + reasoning_effort low", () => {
    for (const baseUrl of [
      "https://open.bigmodel.cn/api/paas/v4",
      "https://api.z.ai/api/paas/v4",
      "https://lkeap.tencentcloudapi.com",
    ]) {
      const body = reasoningDisableExtraBody(baseUrl);
      assert.equal(body.enableReasoning, false, baseUrl);
      assert.equal(body.reasoning_effort, "low", baseUrl);
      assert.equal("thinking" in body, false, baseUrl);
    }
  });

  it("unknown gateway: double-write both conventions (safe, ignored when unsupported)", () => {
    const body = reasoningDisableExtraBody("https://gateway.example.com/v1");
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.enableReasoning, false);
    assert.equal(body.reasoning_effort, "low");
  });

  it("TokenLink (Hy4): native no_think effort only — never the low compat write", () => {
    for (const baseUrl of [
      "https://tokenlink.woa.com/openapi/v1",
      "https://tokenlink-test.woa.com/openapi/v1",
    ]) {
      assert.deepEqual(reasoningDisableExtraBody(baseUrl), {
        reasoning_effort: "no_think",
      }, baseUrl);
    }
  });

  it("malformed baseUrl falls back to raw string match", () => {
    const body = reasoningDisableExtraBody("deepseek-invalid-url");
    assert.deepEqual(body.thinking, { type: "disabled" });
  });
});

describe("noReasoningExtraBody", () => {
  it("keeps provider disable fields and merges call-site extras", () => {
    // Extras are for non-sampling fields only (max_tokens caps vision cost);
    // sampling params (temperature / top_p) are never set — Kimi forbids them.
    const body = noReasoningExtraBody("https://api.deepseek.com", {
      max_tokens: 1024,
    });
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.reasoning_effort, "low");
    assert.equal(body.max_tokens, 1024);
  });

  it("TokenLink: merges call-site extras without re-enabling reasoning", () => {
    const body = noReasoningExtraBody(
      "https://tokenlink.woa.com/openapi/v1",
      { max_tokens: 1024 },
    );
    assert.deepEqual(body, {
      reasoning_effort: "no_think",
      max_tokens: 1024,
    });
  });
});
