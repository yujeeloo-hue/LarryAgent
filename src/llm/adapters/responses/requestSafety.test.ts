import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyResponsesRequestSafety } from "./requestSafety.js";

describe("Responses request safety", () => {
  it("treats no native tools and deferred local functions as read-only", () => {
    assert.equal(classifyResponsesRequestSafety([], []), "read_only");
    assert.equal(classifyResponsesRequestSafety(undefined, "User text"), "read_only");
    assert.equal(classifyResponsesRequestSafety([{ type: "function", name: "write_file" }], []), "read_only");
  });

  it("recognizes only web and file search as read-only native capabilities", () => {
    assert.equal(classifyResponsesRequestSafety([
      { type: "web_search" }, { type: "web_search_preview" }, { type: "file_search" },
      { type: "function", function: { name: "run_shell" } },
    ], []), "read_only");
  });

  it("keeps MCP, code, image generation and unknown capabilities conservative", () => {
    for (const type of ["mcp", "code_interpreter", "image_generation", "shell", "computer", "future_tool", ""]) {
      assert.equal(classifyResponsesRequestSafety([{ type: "web_search" }, { type }], []), "effects_possible");
    }
    assert.equal(classifyResponsesRequestSafety([{ type: "mcp", allowed_tools: { read_only: true } }], []), "effects_possible");
  });

  it("fails closed for malformed tool capability records", () => {
    for (const tools of [{ type: "web_search" }, [null], ["web_search"], [{}]]) {
      assert.equal(classifyResponsesRequestSafety(tools, []), "effects_possible");
    }
  });

  it("treats every active positive MCP approval as effects-possible even without tools", () => {
    const approval = { type: "mcp_approval_response", approval_request_id: "approval", approve: true };
    assert.equal(classifyResponsesRequestSafety([], [approval]), "effects_possible");
    assert.equal(classifyResponsesRequestSafety([{ type: "web_search" }], [approval]), "effects_possible");
    assert.equal(classifyResponsesRequestSafety([], approval), "effects_possible");
    assert.equal(classifyResponsesRequestSafety([], [{ ...approval, approve: false }]), "read_only");
  });

  it("does not treat quoted or nested tool-result data as executable approval input", () => {
    const approval = { type: "mcp_approval_response", approve: true };
    assert.equal(classifyResponsesRequestSafety([], [
      { role: "user", content: JSON.stringify(approval) },
      { type: "function_call_output", call_id: "call", output: approval },
    ]), "read_only");
  });
});
