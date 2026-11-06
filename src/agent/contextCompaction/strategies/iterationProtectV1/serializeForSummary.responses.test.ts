import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../../../session/types.js";
import { serializeIterationsForSummary } from "./serializeForSummary.js";

function serialize(parts: Message["parts"]): string {
  return serializeIterationsForSummary([{
    age: 1, chronoIndex: 0, userPrefix: [], tokens: 10,
    messages: [{ id: "assistant", role: "assistant", createdAt: 1, parts }],
  }]);
}

test("summary retains completed native activity and bounded public output references", () => {
  const summary = serialize([
    { type: "hosted_tool", id: "web", name: "web_search_call", status: "completed", item: { action: { query: "release date", sources: [{ url: "https://example.com/releases" }] } } },
    { type: "hosted_tool", id: "file", name: "file_search_call", status: "completed", item: { queries: ["budget"], results: [{ file_id: "file-budget", text: "RAW_FILE_BODY" }] } },
    { type: "hosted_tool", id: "code", name: "code_interpreter_call", status: "completed", item: { outputs: [{ type: "logs", logs: "Total: 42" }, { files: [{ file_id: "file-report" }] }], code: "PRIVATE_CODE_BODY" } },
    { type: "hosted_tool", id: "mcp", name: "mcp_call", status: "completed", item: { server_label: "crm", name: "lookup", arguments: "PRIVATE_ARGUMENTS", output: "ARBITRARY_MCP_BODY" } },
    { type: "hosted_tool", id: "image", name: "image_generation_call", status: "completed", item: { result: "HUGE_BASE64".repeat(1000) } },
  ]);
  assert.match(summary, /\[TOOL\]: web_search_call \(hosted, completed\).*query=release date.*https:\/\/example.com\/releases/);
  assert.match(summary, /file_search_call.*queries=budget.*files=file-budget/);
  assert.match(summary, /code_interpreter_call.*output=Total: 42.*files=file-report/);
  assert.match(summary, /mcp_call.*server=crm.*name=lookup/);
  assert.match(summary, /image_generation_call \(hosted, completed\)/);
  assert.doesNotMatch(summary, /RAW_FILE_BODY|PRIVATE_CODE_BODY|PRIVATE_ARGUMENTS|ARBITRARY_MCP_BODY|HUGE_BASE64/);
  assert.ok(summary.length < 1500);
});

test("summary distinguishes native failure and incomplete execution from completed tools", () => {
  const summary = serialize([
    { type: "hosted_tool", id: "failed", name: "mcp_call", status: "failed", item: { error: { message: "Permission denied" } } },
    { type: "hosted_tool", id: "cut", name: "web_search_call", status: "incomplete" },
    { type: "hosted_tool", id: "running", name: "code_interpreter_call", status: "in_progress" },
  ]);
  assert.match(summary, /mcp_call \(hosted, failed\) error=Permission denied/);
  assert.match(summary, /web_search_call \(hosted, incomplete\)/);
  assert.match(summary, /code_interpreter_call \(hosted, in_progress\)/);
  assert.doesNotMatch(summary, /completed/);
});

test("opaque native model_response remains excluded even with matching summary scope", () => {
  const summary = serialize([
    { type: "text", text: "Public answer" },
    { type: "model_response", providerScope: "summary", responseId: "resp-private", status: "completed", stored: true, output: [
      { type: "reasoning", encrypted_content: "PRIVATE_ENCRYPTED_REASONING" },
      { type: "message", content: [{ text: "DUPLICATED_RAW_OUTPUT" }] },
    ] },
  ]);
  assert.match(summary, /Public answer/);
  assert.doesNotMatch(summary, /resp-private|PRIVATE_ENCRYPTED_REASONING|DUPLICATED_RAW_OUTPUT/);
});
