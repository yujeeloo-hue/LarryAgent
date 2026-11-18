import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { dispatchLlmApi } from "./apiDispatch.js";

describe("dispatchLlmApi", () => {
  it("selects the explicitly configured API adapter", () => {
    assert.equal(dispatchLlmApi({
      baseUrl: "https://gateway.example/v1",
      apiProtocol: "chat_completions",
    }).id, "chat_completions");
    assert.equal(dispatchLlmApi({
      baseUrl: "https://gateway.example/v1",
      apiProtocol: "responses",
    }).id, "responses");
  });

  it("keeps automatic protocol detection inside the dispatch layer", () => {
    assert.equal(dispatchLlmApi({
      baseUrl: "https://gateway.example/v1/responses",
      apiProtocol: "auto",
    }).id, "responses");
  });
});
