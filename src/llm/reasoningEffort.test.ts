import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isReasoningEffort,
  normalizeReasoningEffort,
  reasoningEffortExtraBody,
} from "./reasoningEffort.js";

describe("isReasoningEffort", () => {
  for (const level of ["off", "low", "medium", "high", "max"] as const) {
    it(`accepts "${level}"`, () => {
      assert.equal(isReasoningEffort(level), true);
    });
  }
  it("rejects xhigh (deliberately not a level)", () => {
    assert.equal(isReasoningEffort("xhigh"), false);
  });
  it("rejects non-strings", () => {
    assert.equal(isReasoningEffort(1), false);
    assert.equal(isReasoningEffort(null), false);
    assert.equal(isReasoningEffort(undefined), false);
  });
});

describe("normalizeReasoningEffort", () => {
  it("passes valid levels through", () => {
    assert.equal(normalizeReasoningEffort("max"), "max");
  });
  it("maps the legacy Max boolean: true → max, false → low", () => {
    assert.equal(normalizeReasoningEffort(true), "max");
    assert.equal(normalizeReasoningEffort(false), "low");
  });
  it("falls back to low for null/undefined/invalid", () => {
    assert.equal(normalizeReasoningEffort(null), "low");
    assert.equal(normalizeReasoningEffort(undefined), "low");
    assert.equal(normalizeReasoningEffort("ultra"), "low");
  });
  it("honors a custom fallback (session-row NULL → follow settings later)", () => {
    assert.equal(normalizeReasoningEffort(null, "high"), "high");
  });
});

describe("reasoningEffortExtraBody", () => {
  it("off reuses the disable layer (DeepSeek thinking switch)", () => {
    assert.deepEqual(
      reasoningEffortExtraBody("https://api.deepseek.com/v1", "off"),
      {
        reasoning_effort: "low",
        thinking: { type: "disabled" },
      },
    );
  });

  it("off reuses the disable layer (GLM enableReasoning)", () => {
    assert.deepEqual(reasoningEffortExtraBody("https://api.z.ai/api/paas/v4", "off"), {
      reasoning_effort: "low",
      enableReasoning: false,
    });
  });

  it("off double-writes both switches for unknown gateways", () => {
    assert.deepEqual(reasoningEffortExtraBody("https://api.example.com/v1", "off"), {
      reasoning_effort: "low",
      thinking: { type: "disabled" },
      enableReasoning: false,
    });
  });

  it("off on TokenLink uses its native no_think effort", () => {
    assert.deepEqual(
      reasoningEffortExtraBody("https://tokenlink.woa.com/openapi/v1", "off"),
      { reasoning_effort: "no_think" },
    );
  });

  it("non-off dials pass through on TokenLink (all keep reasoning on)", () => {
    for (const level of ["low", "medium", "high", "max"] as const) {
      assert.deepEqual(
        reasoningEffortExtraBody("https://tokenlink.woa.com/openapi/v1", level),
        { reasoning_effort: level },
      );
    }
  });

  it("low / high / max pass through as reasoning_effort", () => {
    assert.deepEqual(reasoningEffortExtraBody("https://api.deepseek.com/v1", "low"), {
      reasoning_effort: "low",
    });
    assert.deepEqual(reasoningEffortExtraBody("https://api.deepseek.com/v1", "high"), {
      reasoning_effort: "high",
    });
    assert.deepEqual(reasoningEffortExtraBody("https://api.deepseek.com/v1", "max"), {
      reasoning_effort: "max",
    });
  });

  it("medium passes through on DeepSeek (server-side compat mapping)", () => {
    assert.deepEqual(
      reasoningEffortExtraBody("https://api.deepseek.com/v1", "medium"),
      { reasoning_effort: "medium" },
    );
  });

  it("medium clamps to high on Kimi / Moonshot hosts", () => {
    assert.deepEqual(
      reasoningEffortExtraBody("https://api.moonshot.ai/v1", "medium"),
      { reasoning_effort: "high" },
    );
    assert.deepEqual(
      reasoningEffortExtraBody("https://api.moonshot.cn/v1", "medium"),
      { reasoning_effort: "high" },
    );
  });

  it("medium clamps to high on GLM / Z.ai / bigmodel / lkeap hosts", () => {
    assert.deepEqual(
      reasoningEffortExtraBody("https://api.z.ai/api/paas/v4", "medium"),
      { reasoning_effort: "high" },
    );
    assert.deepEqual(
      reasoningEffortExtraBody("https://open.bigmodel.cn/api/paas/v4", "medium"),
      { reasoning_effort: "high" },
    );
  });
});
