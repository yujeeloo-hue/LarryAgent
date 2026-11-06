import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { modelEndpoint, normalizeLlmBaseUrl, normalizeLlmProviderOptions, providerApiEndpoint, resolveLlmApiProtocol, resolveResponsesStateful } from "./apiProtocol.js";

describe("provider protocol detection", () => {
  it("uses Responses with opt-in state for GLM's exact Responses API base", () => {
    for (const baseUrl of ["https://open.bigmodel.cn/api/v1", "https://open.bigmodel.cn/api/v1/?tenant=one/", "https://open.bigmodel.cn/api/v1/responses?tenant=one/"]) {
      for (const rawEndpoint of [false, true]) {
        const config = { baseUrl, rawEndpoint, apiProtocol: "auto" as const };
        assert.equal(resolveLlmApiProtocol(config), "responses");
        assert.equal(resolveResponsesStateful(config), false);
      }
    }
    assert.equal(modelEndpoint({ baseUrl: "https://open.bigmodel.cn/api/v1/?tenant=one/" }), "https://open.bigmodel.cn/api/v1/responses?tenant=one/");
  });
  it("keeps GLM Coding and unrelated routes on Chat and respects explicit Chat choices", () => {
    for (const baseUrl of ["https://open.bigmodel.cn/api/coding/paas/v4", "https://open.bigmodel.cn/api/paas/v4", "https://open.bigmodel.cn/api/v10", "https://open.bigmodel.cn/api/v1/custom", "https://proxy.example/api/v1"]) {
      assert.equal(resolveLlmApiProtocol({ baseUrl }), "chat_completions");
    }
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://open.bigmodel.cn/api/v1?tenant=one/", apiProtocol: "chat_completions" }), "chat_completions");
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://open.bigmodel.cn/api/v1/chat/completions/?tenant=one/", rawEndpoint: true }), "chat_completions");
    assert.equal(resolveResponsesStateful({ baseUrl: "https://open.bigmodel.cn/api/v1", responsesStateful: false }), false);
  });
  it("uses Responses without retained state for the exact Kimi Coding profile", () => {
    for (const baseUrl of ["https://api.kimi.com/coding/v1", "https://api.kimi.com/coding/v1/?tenant=one/", "https://api.kimi.com/coding/v1/responses?tenant=one/"]) {
      for (const rawEndpoint of [false, true]) {
        const config = { baseUrl, rawEndpoint, apiProtocol: "auto" as const };
        assert.equal(resolveLlmApiProtocol(config), "responses");
        assert.equal(resolveResponsesStateful(config), false);
      }
    }
    assert.equal(modelEndpoint({ baseUrl: "https://api.kimi.com/coding/v1?tenant=one/" }), "https://api.kimi.com/coding/v1/responses?tenant=one/");
  });
  it("keeps explicit Chat and complete Chat endpoints ahead of the Kimi Coding default", () => {
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://api.kimi.com/coding/v1", apiProtocol: "chat_completions" }), "chat_completions");
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://api.kimi.com/coding/v1/chat/completions/?tenant=one/", rawEndpoint: true }), "chat_completions");
    assert.equal(resolveResponsesStateful({ baseUrl: "https://api.kimi.com/coding/v1/chat/completions/?tenant=one/" }), false);
  });
  it("keeps every other host stateless by default too", () => {
    for (const baseUrl of ["https://api.kimi.com/v1", "https://api.kimi.com/coding/v10", "https://api.kimi.com/coding/v1/custom", "https://api.kimi.com.example/coding/v1", "https://proxy.example/coding/v1"]) {
      assert.equal(resolveLlmApiProtocol({ baseUrl }), "chat_completions");
      assert.equal(resolveResponsesStateful({ baseUrl }), false);
    }
    assert.equal(resolveResponsesStateful({ baseUrl: "https://api.openai.com/v1" }), false);
    assert.equal(resolveResponsesStateful({ baseUrl: "https://unknown.example/v1/responses" }), false);
  });
  it("honors explicit state retention without rewriting stored preferences", () => {
    for (const baseUrl of ["https://api.kimi.com/coding/v1", "https://api.openai.com/v1", "https://unknown.example/custom"]) {
      assert.equal(resolveResponsesStateful({ baseUrl, responsesStateful: true }), true);
      assert.equal(resolveResponsesStateful({ baseUrl, responsesStateful: false }), false);
      assert.deepEqual(normalizeLlmProviderOptions({ baseUrl }), {});
    }
  });
  it("normalizes path slashes without changing query or fragment values", () => {
    assert.equal(normalizeLlmBaseUrl(" https://example.com/custom///?tenant=org/ "), "https://example.com/custom?tenant=org/");
    assert.equal(normalizeLlmBaseUrl("https://example.com/v1/#route/"), "https://example.com/v1#route/");
    assert.equal(modelEndpoint({ baseUrl: normalizeLlmBaseUrl("https://example.com/custom/responses/?tenant=org/") }), "https://example.com/custom/responses?tenant=org/");
    assert.equal(normalizeLlmBaseUrl("https://example.com/custom///"), "https://example.com/custom");
    assert.equal(normalizeLlmBaseUrl(" https://example.com/invoke/?tenant=x/ ", true), "https://example.com/invoke/?tenant=x/");
  });
  it("uses Responses for the official base and explicit Responses URLs", () => {
    for (const baseUrl of ["https://api.openai.com/v1", "https://api.openai.com/v1/?tenant=a", "https://gateway.example/v1/responses?version=1"]) {
      assert.equal(resolveLlmApiProtocol({ baseUrl }), "responses");
    }
  });
  it("preserves Chat compatibility for unknown gateways and explicit Chat URLs", () => {
    for (const baseUrl of ["https://gateway.example/v1", "http://localhost:1234/v1", "https://api.openai.com/v1/chat/completions?x=1"]) {
      assert.equal(resolveLlmApiProtocol({ baseUrl, apiProtocol: "auto" }), "chat_completions");
    }
  });
  it("honors manual protocol preferences over a URL suffix", () => {
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://api.openai.com/v1", apiProtocol: "chat_completions" }), "chat_completions");
    assert.equal(resolveLlmApiProtocol({ baseUrl: "https://example.com/chat/completions", apiProtocol: "responses" }), "responses");
  });
  it("avoids duplicate paths and preserves query parameters", () => {
    assert.equal(modelEndpoint({ baseUrl: "https://example.com/v1/responses?version=1" }), "https://example.com/v1/responses?version=1");
    assert.equal(modelEndpoint({ baseUrl: "https://example.com/v1/chat/completions/?version=1", apiProtocol: "responses" }), "https://example.com/v1/responses?version=1");
    assert.equal(modelEndpoint({ baseUrl: "https://api.openai.com/v1?tenant=one" }), "https://api.openai.com/v1/responses?tenant=one");
    assert.equal(providerApiEndpoint("https://example.com/v1/responses?tenant=one", "models"), "https://example.com/v1/models?tenant=one");
  });
  it("keeps raw endpoint mode literal even with a manual protocol mismatch", () => {
    const config = { baseUrl: "https://example.com/chat/completions?key=one", rawEndpoint: true, apiProtocol: "responses" as const };
    assert.equal(resolveLlmApiProtocol(config), "responses");
    assert.equal(modelEndpoint(config), config.baseUrl);
  });
  it("preserves preferences without writing detection results into them", () => {
    const options = { apiProtocol: "auto" as const, responsesTools: [{ type: "web_search", filters: { allowed_domains: ["example.com"] } }], responsesStateful: false };
    const copy = normalizeLlmProviderOptions(options);
    assert.deepEqual(copy, options);
    assert.notEqual(copy.responsesTools, options.responsesTools);
    assert.deepEqual(normalizeLlmProviderOptions({ apiProtocol: "bad", responsesStateful: "false", responsesTools: [null, [], 1] }), { responsesTools: [] });
    assert.deepEqual(normalizeLlmProviderOptions({}), {});
  });
});
