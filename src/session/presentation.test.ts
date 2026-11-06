import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { messagesForPresentation, messageWindowForPresentation, sessionForPresentation, sessionTailForPresentation, subagentDetailForPresentation } from "./presentation.js";

function transcript() {
  return [{ id: "user", role: "user", parts: [{ type: "text", text: "Research this" }] }, {
    id: "assistant", role: "assistant", parts: [
      { type: "text", text: "Here is the result", annotations: [{ type: "url_citation", url: "https://example.com" }] },
      { type: "hosted_tool", id: "search", name: "web_search_call", status: "completed", item: { type: "web_search_call", action: { query: "example" } } },
      { type: "model_response", providerScope: "private-provider", responseId: "private-response", status: "completed", stored: true,
        output: [{ type: "reasoning", encrypted_content: "OPAQUE-ONLY-FOR-MODEL" }], requestItemHashes: ["private-hash"], continuationInput: [{ type: "mcp_approval_response", approval_request_id: "private-approval" }] },
    ],
  }];
}

describe("session presentation DTOs", () => {
  it("removes the complete replay part while preserving visible text, citations and hosted activity", () => {
    const original = transcript();
    const copy = messagesForPresentation(original);
    assert.deepEqual(copy[0], original[0]);
    assert.deepEqual(copy[1]!.parts, original[1]!.parts.slice(0, 2));
    assert.equal(copy[1]!.id, "assistant");
    assert.doesNotMatch(JSON.stringify(copy), /model_response|OPAQUE-ONLY|private-(?:provider|response|hash|approval)/);
    assert.equal(original[1]!.parts.length, 3);
    assert.match(JSON.stringify(original), /OPAQUE-ONLY/);
  });

  it("deep-clones session metadata, messages and nested public tool items", () => {
    const original = { id: "session", messages: transcript(), plan: { steps: [{ title: "Original" }] } };
    const copy = sessionForPresentation(original)!;
    assert.notEqual(copy, original);
    copy.plan.steps[0]!.title = "Presentation edit";
    const hosted = copy.messages[1]!.parts[1] as { item: { action: { query: string } } };
    hosted.item.action.query = "Changed";
    assert.equal(original.plan.steps[0]!.title, "Original");
    assert.equal((original.messages[1]!.parts[1] as { item: { action: { query: string } } }).item.action.query, "example");
    assert.equal(original.messages[1]!.parts.length, 3);
  });

  it("keeps paging metadata and stable message IDs for tail and older pages", () => {
    const window = { firstMessageId: "user", hasMore: true, remainingTurns: 4 };
    const originalTail = { session: { id: "session", messages: transcript() }, window };
    const tail = sessionTailForPresentation(originalTail)!;
    assert.deepEqual(tail.window, window);
    assert.notEqual(tail.window, window);
    assert.doesNotMatch(JSON.stringify(tail), /OPAQUE-ONLY/);
    assert.equal(tail.session.messages.length, 2);
    const older = messageWindowForPresentation({ ...window, messages: transcript() })!;
    assert.equal(older.firstMessageId, "user");
    assert.equal(older.hasMore, true);
    assert.equal(older.remainingTurns, 4);
    assert.equal(older.messages[1]!.id, "assistant");
    assert.doesNotMatch(JSON.stringify(older), /OPAQUE-ONLY/);
    assert.match(JSON.stringify(originalTail), /OPAQUE-ONLY/);
  });

  it("clones legacy text-only subagent transcripts and filters future part-based details", () => {
    const legacy = { id: "child", prompt: "Work", messages: [{ role: "assistant", text: "Done" }] };
    const copy = subagentDetailForPresentation(legacy)!;
    assert.deepEqual(copy, legacy);
    copy.messages[0]!.text = "UI edit";
    assert.equal(legacy.messages[0]!.text, "Done");
    const native = subagentDetailForPresentation({ id: "child", prompt: "Work", messages: transcript() })!;
    assert.doesNotMatch(JSON.stringify(native), /OPAQUE-ONLY/);
    assert.equal(native.messages[1]!.parts[1]!.type, "hosted_tool");
  });

  it("preserves null lookups and does not remove messages containing only hidden state", () => {
    assert.equal(sessionForPresentation(null), null);
    assert.equal(sessionTailForPresentation(null), null);
    assert.equal(messageWindowForPresentation(null), null);
    assert.equal(subagentDetailForPresentation(null), null);
    const input = [{ id: "stable-cursor", role: "assistant", parts: [{ type: "model_response", output: [] }] }];
    assert.deepEqual(messagesForPresentation(input), [{ id: "stable-cursor", role: "assistant", parts: [] }]);
  });
});
