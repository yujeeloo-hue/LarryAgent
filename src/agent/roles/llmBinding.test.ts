import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StreamEvent } from "../../llm/streamEvents.js";
import type {
  OpenAiCompatibleClientConfig,
  StreamChatOptions,
} from "../../llm/types.js";
import type { JsonObject } from "../../session/types.js";
import { createRoleLlmBinding } from "./llmBinding.js";

const baseClient: OpenAiCompatibleClientConfig = {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "test-key",
  model: "deepseek-v4-flash",
};

/**
 * Drive binding.stream with an injected fake base stream and return the
 * extraBody the selected API adapter would send. Stream and complete share
 * the same adapter mapping, so covering stream covers both.
 */
async function extraBodyFor(
  client: OpenAiCompatibleClientConfig,
): Promise<JsonObject | undefined> {
  let captured: StreamChatOptions | undefined;
  const binding = createRoleLlmBinding({
    providerId: "deepseek",
    client,
    stream: async function* (
      _config,
      options,
    ): AsyncGenerator<StreamEvent, void, undefined> {
      captured = options;
    },
  });
  for await (const event of binding.stream(baseClient, {
    messages: [{ role: "user", content: "hi" }],
  })) {
    void event;
  }
  assert.ok(captured);
  return captured.extraBody;
}

describe("createRoleLlmBinding reasoning effort", () => {
  it('dial "low" → reasoning_effort low', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      reasoningEffort: "low",
    });
    assert.deepEqual(body, { reasoning_effort: "low" });
  });

  it('dial "medium" → passthrough on DeepSeek (server maps to high)', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      reasoningEffort: "medium",
    });
    assert.deepEqual(body, { reasoning_effort: "medium" });
  });

  it('dial "medium" → clamped to high on Kimi hosts', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      baseUrl: "https://api.moonshot.ai/v1",
      model: "kimi-k3",
      reasoningEffort: "medium",
    });
    assert.deepEqual(body, { reasoning_effort: "high" });
  });

  it('dial "max" → reasoning_effort max', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      reasoningEffort: "max",
    });
    assert.deepEqual(body, { reasoning_effort: "max" });
  });

  it('dial "off" → disable switches + low double-write', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      reasoningEffort: "off",
    });
    assert.deepEqual(body, {
      reasoning_effort: "low",
      thinking: { type: "disabled" },
    });
  });

  it('dial "off" on TokenLink → no_think only', async () => {
    const body = await extraBodyFor({
      ...baseClient,
      baseUrl: "https://tokenlink.woa.com/openapi/v1",
      model: "hy4",
      reasoningEffort: "off",
    });
    assert.deepEqual(body, { reasoning_effort: "no_think" });
  });

  it("Ask mode on TokenLink overrides a thinking dial with no_think", async () => {
    const body = await extraBodyFor({
      ...baseClient,
      baseUrl: "https://tokenlink.woa.com/openapi/v1",
      model: "hy4",
      reasoningEffort: "max",
      disableReasoning: true,
    });
    assert.deepEqual(body, { reasoning_effort: "no_think" });
  });

  it("Ask mode: disableReasoning wins over the dial (low + provider off switch)", async () => {
    const body = await extraBodyFor({
      ...baseClient,
      reasoningEffort: "max",
      disableReasoning: true,
    });
    assert.deepEqual(body, {
      reasoning_effort: "low",
      thinking: { type: "disabled" },
    });
  });

  it("no effort configured and no disable → no extraBody", async () => {
    const body = await extraBodyFor(baseClient);
    assert.equal(body, undefined);
  });

  it("leaves Responses reasoning mapping to the Responses adapter", async () => {
    const body = await extraBodyFor({
      ...baseClient,
      apiProtocol: "responses",
      reasoningEffort: "max",
      disableReasoning: true,
    });
    assert.equal(body, undefined);
  });
});
