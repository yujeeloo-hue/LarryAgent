import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { reasoningScopeForClient } from "../../llm/contextScope.js";
import type { AssistantMessage, Message } from "../../session/types.js";
import { messagesToOpenAi } from "./messagesToOpenAi.js";
import { buildModelMessages } from "./strategies/iterationProtectV1/messagesToOpenAi.js";

const client = { baseUrl: "https://gateway.example/v1", model: "model-a", apiKey: "test-secret" };
const scope = reasoningScopeForClient(client);

function assistant(id: string, providerScope: string = scope): AssistantMessage {
  return { id, role: "assistant", createdAt: 1, parts: [
    { type: "reasoning", text: `private-${id}`, providerScope },
    { type: "text", text: `answer-${id}` },
  ] };
}

describe("reasoning context binding", () => {
  it("scopes by endpoint, credentials and model without persisting their plaintext", () => {
    assert.equal(scope, reasoningScopeForClient({ ...client, baseUrl: `${client.baseUrl}/` }));
    for (const changed of [
      { ...client, model: "model-b" }, { ...client, apiKey: "different" },
      { ...client, baseUrl: "https://other.example/v1" }, { ...client, rawEndpoint: true },
    ]) assert.notEqual(scope, reasoningScopeForClient(changed));
    assert.match(scope, /^[a-f0-9]{64}$/);
    assert.ok(!scope.includes(client.apiKey));
  });

  it("replays same-binding reasoning while keeping foreign and legacy reasoning display-only", () => {
    const legacy = assistant("legacy");
    const part = legacy.parts.find((part) => part.type === "reasoning")!;
    if (part.type === "reasoning") delete part.providerScope;
    const messages = [assistant("same"), assistant("foreign", "other-scope"), legacy];
    const wire = messagesToOpenAi(messages, { reasoningScope: scope });
    assert.equal(wire[0]!.reasoning_content, "private-same");
    assert.equal(wire[1]!.reasoning_content, undefined);
    assert.equal(wire[2]!.reasoning_content, undefined);
    assert.deepEqual(wire.map((message) => message.content), ["answer-same", "answer-foreign", "answer-legacy"]);
    assert.equal(messages[1]!.parts[0]!.type === "reasoning" && messages[1]!.parts[0]!.text, "private-foreign");
  });

  it("preserves function calls and results while excluding foreign reasoning", () => {
    const message = assistant("tool", "other-scope");
    message.parts.push({ type: "tool_call", id: "call", name: "read_file", status: "done", arguments: {}, argumentsRaw: "{}" });
    const wire = messagesToOpenAi([message], { reasoningScope: scope });
    assert.equal(wire[0]!.reasoning_content, "");
    assert.equal(wire[0]!.tool_calls![0]!.id, "call");
  });

  it("clear starts a fresh window and never revives an earlier scope", () => {
    const messages: Message[] = [assistant("old"), {
      id: "clear", role: "system", createdAt: 2,
      parts: [{ type: "context_clear", id: "clear", clearedMessageCount: 1 }],
    }, assistant("new")];
    const wire = buildModelMessages(messages, { reasoningScope: scope });
    assert.equal(wire.length, 1);
    assert.equal(wire[0]!.reasoning_content, "private-new");
    assert.ok(!JSON.stringify(wire).includes("private-old"));
  });

  it("compaction retains its selected suffix and applies the active binding scope there", () => {
    const messages: Message[] = [assistant("old"), {
      id: "compact", role: "system", createdAt: 2, parts: [{
        type: "context_compaction", id: "compact", summary: "Earlier work completed.",
        fromMessageId: "old", toMessageId: "old", coveredThroughMessageId: "old",
        usedTokensBefore: 100, usedTokensAfter: 20,
      }],
    }, assistant("live", "other-scope")];
    const wire = buildModelMessages(messages, { reasoningScope: scope });
    assert.ok(JSON.stringify(wire).includes("Earlier work completed."));
    assert.ok(!JSON.stringify(wire).includes("private-old"));
    assert.equal(wire.at(-1)!.content, "answer-live");
    assert.equal(wire.at(-1)!.reasoning_content, undefined);
  });
});
