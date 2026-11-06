import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reasoningScopeForClient } from "../contextScope.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig } from "../types.js";
import { messagesForBinding } from "./messagesForBinding.js";

const client: OpenAiCompatibleClientConfig = {
  baseUrl: "https://gateway.example/v1",
  apiKey: "key",
  model: "model",
  apiProtocol: "responses",
};

const messages: OpenAiChatMessage[] = [{
  role: "assistant",
  content: null,
  reasoning_content: "private",
  tool_calls: [{
    id: "call",
    type: "function",
    function: { name: "read_file", arguments: "{}" },
  }],
  responsesOutput: {
    providerScope: "old",
    responseId: "response",
    status: "completed",
    stored: true,
    output: [],
  },
}];

describe("messagesForBinding", () => {
  it("preserves private replay fields for the binding that built the window", () => {
    assert.equal(
      messagesForBinding(messages, reasoningScopeForClient(client), client),
      messages,
    );
  });

  it("removes foreign replay fields without mutating the candidate window", () => {
    const before = structuredClone(messages);
    const result = messagesForBinding(messages, "foreign", client);
    assert.equal(result[0]!.responsesOutput, undefined);
    assert.equal(result[0]!.reasoning_content, "");
    assert.deepEqual(messages, before);
  });
});
