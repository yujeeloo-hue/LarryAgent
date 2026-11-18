import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { JsonObject, ModelResponsePart } from "../../../session/types.js";
import { reasoningScopeForClient } from "../../contextScope.js";
import { canReplayResponsesInput, prepareResponsesContext, sealResponsesContext } from "./context.js";
import type { OpenAiChatMessage, OpenAiCompatibleClientConfig } from "../../types.js";

const client: OpenAiCompatibleClientConfig = { baseUrl: "https://gateway.test/v1", apiKey: "test", model: "m", apiProtocol: "responses", responsesStateful: true };
const original: OpenAiChatMessage[] = [{ role: "system", content: "Persona" }, { role: "user", content: "First" }];
function fixture(config: OpenAiCompatibleClientConfig = client) {
  const base = prepareResponsesContext(original, config);
  const part: ModelResponsePart = { type: "model_response", providerScope: reasoningScopeForClient(config),
    responseId: "resp_first", status: "completed", stored: true,
    output: [{ type: "reasoning", id: "rs", summary: [], encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Answer", annotations: [] }] }] };
  sealResponsesContext(part, base.fullInput);
  const { type: _type, ...state } = part;
  const messages: OpenAiChatMessage[] = [...original, { role: "assistant", content: "Answer", responsesOutput: state }, { role: "user", content: "Second" }];
  return { part, messages };
}
describe("Responses context cursor isolation", () => {
  it("sends only the unsent suffix when the entire local prefix is unchanged", () => {
    const { messages } = fixture();
    const next = prepareResponsesContext(messages, client);
    assert.equal(next.previousResponseId, "resp_first");
    assert.deepEqual(next.input, [{ role: "user", content: "Second" }]);
  });
  it("resets the cursor for prompt edits, truncation, clear, changed endpoint/model/key/protocol or stateless mode", () => {
    const { messages } = fixture();
    for (const changed of [
      [{ ...original[0]!, content: "New persona" }, ...messages.slice(1)],
      messages.slice(1), messages.slice(-1),
    ]) assert.equal(prepareResponsesContext(changed, client).previousResponseId, undefined);
    for (const changed of [{ ...client, model: "other" }, { ...client, apiKey: "other" },
      { ...client, baseUrl: "https://other.test/v1" }, { ...client, apiProtocol: "chat_completions" as const },
      { ...client, responsesStateful: false }]) {
      const next = prepareResponsesContext(messages, changed);
      assert.equal(next.previousResponseId, undefined);
      if (changed.responsesStateful !== false) assert.ok(!JSON.stringify(next.input).includes("opaque"));
    }
  });
  it("replays complete encrypted output in stateless mode and preserves unsent approvals after a cursor", () => {
    const { messages } = fixture();
    assert.match(JSON.stringify(prepareResponsesContext(messages, { ...client, responsesStateful: false }).input), /opaque/);
    const assistant = messages[2]!;
    assistant.responsesOutput!.continuationInput = [{ type: "mcp_approval_response", approval_request_id: "approval", approve: false }];
    const next = prepareResponsesContext(messages, client);
    assert.equal(next.previousResponseId, "resp_first");
    assert.equal(next.input[0]!.type, "mcp_approval_response");
  });
  it("can seal a recovered response using opaque persisted input fingerprints", () => {
    const { part, messages } = fixture();
    delete part.contextHash; delete part.contextLength;
    sealResponsesContext(part);
    const { type: _type, ...state } = part;
    messages[2]!.responsesOutput = state;
    assert.equal(prepareResponsesContext(messages, client).previousResponseId, "resp_first");
    assert.ok(!JSON.stringify(part.requestItemHashes).includes("Persona"));
  });

  it("does not reuse cursors by default and honors explicit stateful preferences", () => {
    const kimi: OpenAiCompatibleClientConfig = { ...client, baseUrl: "https://api.kimi.com/coding/v1", model: "kimi-for-coding" };
    delete kimi.responsesStateful;
    const { messages } = fixture(kimi);
    const independent = prepareResponsesContext(messages, kimi);
    assert.equal(independent.previousResponseId, undefined);
    assert.equal(independent.input, independent.fullInput);
    assert.match(JSON.stringify(independent.input), /opaque/);
    assert.equal(prepareResponsesContext(messages, { ...kimi, responsesStateful: true }).previousResponseId, "resp_first");
    assert.equal(prepareResponsesContext(messages, { ...kimi, responsesStateful: false }).previousResponseId, undefined);
  });

  it("treats the latest matching completed stateless response as a boundary for older stored cursors", () => {
    const { messages } = fixture();
    messages.push({ role: "assistant", content: "Latest answer", responsesOutput: {
      ...messages[2]!.responsesOutput!, responseId: "resp_latest", stored: false,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Latest answer" }] }],
    } }, { role: "user", content: "Third" });
    const next = prepareResponsesContext(messages, client);
    assert.equal(next.previousResponseId, undefined);
    assert.deepEqual(next.input, next.fullInput);
    assert.match(JSON.stringify(next.input), /opaque/);
    assert.match(JSON.stringify(next.input), /Latest answer/);
    assert.equal(messages[2]!.responsesOutput!.status, "completed");
  });

  it("does not let a foreign provider's stateless response disable a matching stored cursor", () => {
    const { messages } = fixture();
    messages.push({ role: "assistant", content: "Other provider", responsesOutput: {
      ...messages[2]!.responsesOutput!, providerScope: "other-provider", responseId: "foreign", stored: false,
    } });
    assert.equal(prepareResponsesContext(messages, client).previousResponseId, "resp_first");
  });

  it("never truncates input for a completed response with an empty or whitespace-only cursor", () => {
    for (const responseId of ["", " ", "\t\n"]) {
      const { messages } = fixture();
      messages[2]!.responsesOutput!.responseId = responseId;
      const next = prepareResponsesContext(messages, client);
      assert.equal(next.previousResponseId, undefined);
      assert.deepEqual(next.input, next.fullInput);
    }
  });

  it("does not revive an older cursor behind a newer completed response with a missing cursor", () => {
    const { messages } = fixture();
    messages.push({ role: "assistant", content: "Latest answer", responsesOutput: {
      ...messages[2]!.responsesOutput!, responseId: " ", stored: true,
      output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Latest answer" }] }],
    } });
    const next = prepareResponsesContext(messages, client);
    assert.equal(next.previousResponseId, undefined);
    assert.deepEqual(next.input, next.fullInput);
  });
});

describe("Responses input replay safety", () => {
  const call = (id: string): JsonObject => ({ type: "function_call", call_id: id, name: "grep", arguments: '{"pattern":"needle"}', status: "completed" });
  const result = (id: string): JsonObject => ({ type: "function_call_output", call_id: id, output: "matching line" });

  it("replays summary-only reasoning with both grep calls and their exact cached results", () => {
    const input: JsonObject[] = [
      { role: "system", content: "Help with this project" },
      { role: "user", content: "Find both occurrences" },
      { type: "reasoning", id: "rs_kimi", summary: [{ type: "summary_text", text: "Search both files" }] },
      call("grep_one"), call("grep_two"), result("grep_one"), result("grep_two"),
      { type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "Found both" }] },
      { role: "user", content: "Continue" },
    ];
    const before = JSON.stringify(input);
    assert.equal(canReplayResponsesInput(input), true);
    assert.equal(JSON.stringify(input), before);
  });

  it("accepts complete ordinary messages, encrypted or empty-summary reasoning, and embedded attachments", () => {
    assert.equal(canReplayResponsesInput([
      { type: "message", role: "developer", content: "Instructions" },
      { role: "user", content: [
        { type: "input_text", text: "Inspect these" },
        { type: "input_image", image_url: "data:image/png;base64,AA==" },
        { type: "input_file", filename: "note.txt", file_data: "data:text/plain;base64,YQ==" },
      ] },
      { type: "reasoning", summary: [] },
      { type: "reasoning", encrypted_content: "opaque" },
      { type: "message", role: "assistant", content: [{ type: "refusal", refusal: "Cannot help" }] },
    ]), true);
  });

  it("accepts completed hosted results as history without treating them as local calls", () => {
    assert.equal(canReplayResponsesInput([
      { type: "web_search_call", id: "web", status: "completed", action: { type: "search", query: "evidence" } },
      { type: "file_search_call", id: "file", status: "completed", queries: ["evidence"], results: [{ file_id: "file_one", text: "Evidence" }] },
      { type: "code_interpreter_call", id: "code", status: "completed", code: "print(1)", container_id: "container_one", outputs: [{ type: "logs", logs: "1" }] },
      { type: "image_generation_call", id: "image", status: "completed", result: "aW1hZ2U=" },
      { type: "mcp_call", id: "mcp", status: "completed", server_label: "docs", name: "read", output: "Saved result" },
      { type: "mcp_list_tools", id: "list", status: "completed", server_label: "docs", tools: [] },
    ]), true);
  });

  it("accepts a complete cached function result with structured embedded content", () => {
    const legacyCall = call("structured");
    delete legacyCall.status;
    assert.equal(canReplayResponsesInput([legacyCall, { type: "function_call_output", call_id: "structured",
      output: [{ type: "input_text", text: "Complete output" }, { type: "input_image", image_url: "https://example.test/result.png" }] }]), true);
  });

  it("rejects missing, orphaned, out-of-order, duplicate or conflicting function results", () => {
    const unsafe: JsonObject[][] = [
      [call("one")], [result("one")], [result("one"), call("one")],
      [call("one"), result("two")],
      [call("one"), call("one"), result("one")],
      [call("one"), { ...call("one"), arguments: "{}" }, result("one")],
      [call("one"), result("one"), result("one")],
      [call("one"), result("one"), { ...result("one"), output: "different" }],
      [call("one"), result("one"), call("two")],
    ];
    for (const input of unsafe) assert.equal(canReplayResponsesInput(input), false, JSON.stringify(input));
  });

  it("rejects incomplete function records even when their IDs can be paired", () => {
    for (const incomplete of [
      { ...call("one"), name: "" }, { ...call("one"), arguments: null },
      { ...call("one"), status: "in_progress" }, { type: "function_call", call_id: "one" },
    ]) assert.equal(canReplayResponsesInput([incomplete, result("one")]), false);
    assert.equal(canReplayResponsesInput([call("one"), { type: "function_call_output", call_id: "one" }]), false);
    assert.equal(canReplayResponsesInput([call(" "), result(" ")]), false);
  });

  it("rejects remote-only references while allowing ordinary citations on complete visible text", () => {
    for (const reference of [
      { type: "item_reference", id: "remote_item" }, { id: "remote_item" },
      { type: "message", id: "remote_message" }, { type: "reasoning", id: "remote_reasoning" },
      { role: "user", content: [{ type: "input_file", file_id: "remote_file" }] },
      { role: "user", content: [{ type: "input_image", file_id: "remote_image" }] },
    ]) assert.equal(canReplayResponsesInput([reference]), false, JSON.stringify(reference));
    assert.equal(canReplayResponsesInput([{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Evidence",
      annotations: [{ type: "file_citation", file_id: "source_file", filename: "source.txt" }] }] }]), true);
  });

  it("rejects unknown or unfinished hosted work and remote-only hosted shells", () => {
    const completed: JsonObject[] = [
      { type: "web_search_call", id: "web", status: "completed", action: { type: "search", query: "test" } },
      { type: "file_search_call", id: "file", status: "completed", queries: ["test"] },
      { type: "code_interpreter_call", id: "code", status: "completed", code: "print(1)", outputs: [] },
      { type: "image_generation_call", id: "image", status: "completed", result: "aW1hZ2U=" },
      { type: "mcp_call", id: "mcp", status: "completed", output: "Complete" },
    ];
    for (const item of completed) {
      for (const status of [undefined, "queued", "in_progress", "incomplete", "failed", "cancelled", "future"]) {
        const changed = { ...item };
        if (status === undefined) delete changed.status; else changed.status = status;
        assert.equal(canReplayResponsesInput([changed]), false, JSON.stringify(changed));
      }
      assert.equal(canReplayResponsesInput([{ type: item.type!, id: item.id!, status: "completed" }]), false);
    }
    assert.equal(canReplayResponsesInput([{ type: "future_call", id: "future", status: "completed", output: "Unknown semantics" }]), false);
    assert.equal(canReplayResponsesInput([{ type: "computer_call", id: "computer", status: "completed", action: { type: "click" } }]), false);
  });

  it("conservatively rejects both positive and negative MCP approvals, including consumed historical approvals", () => {
    const approval: JsonObject = { type: "mcp_approval_request", id: "approval", server_label: "docs", name: "write", arguments: "{}" };
    for (const approve of [true, false]) {
      const answer: JsonObject = { type: "mcp_approval_response", approval_request_id: "approval", approve };
      assert.equal(canReplayResponsesInput([approval, answer]), false);
      assert.equal(canReplayResponsesInput([answer]), false);
      assert.equal(canReplayResponsesInput([approval, answer, { type: "mcp_call", id: "called", status: "completed", output: "Already wrote" }]), false);
    }
    assert.equal(canReplayResponsesInput([approval]), false);
  });
});
