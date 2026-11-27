import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, JsonObject } from "../../../session/types.js";
import { applyResponsesOutput, canApproveHostedMcp, sealHostedToolProgress } from "./transcript.js";

describe("Responses MCP approval policy", () => {
  const approval: JsonObject = { type: "mcp_approval_request", id: "approval", server_label: "docs", name: "write", arguments: "{}" };
  const server: JsonObject = { type: "mcp", server_label: "docs", server_url: "https://mcp.example.com" };
  const listing = (hint: boolean): JsonObject => ({ type: "mcp_list_tools", server_label: "docs", id: "list",
    tools: [{ name: "write", input_schema: { type: "object" }, annotations: { readOnlyHint: hint } }] });

  it("requires the actual offered server and applies name allowlists", () => {
    assert.equal(canApproveHostedMcp(approval, []), false);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, server_label: "other" }]), false);
    assert.equal(canApproveHostedMcp(approval, [server]), true);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: ["write"] }]), true);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: ["read"] }]), false);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: { tool_names: ["write"] } }]), true);
    assert.equal(canApproveHostedMcp({ ...approval, name: "" }, [server]), false);
  });

  it("matches both boolean read_only filters against native listing annotations", () => {
    for (const requested of [true, false]) {
      const tools = [{ ...server, allowed_tools: { read_only: requested } }];
      assert.equal(canApproveHostedMcp(approval, tools, [listing(requested)]), true);
      assert.equal(canApproveHostedMcp(approval, tools, [listing(!requested)]), false);
    }
  });

  it("intersects tool_names and read_only rather than accepting either filter", () => {
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: { tool_names: ["write"], read_only: true } }], [listing(false)]), false);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: { tool_names: ["read"], read_only: false } }], [listing(false)]), false);
    assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools: { tool_names: ["write"], read_only: false } }], [listing(false)]), true);
  });

  it("fails closed without an exact server/tool native annotation and never scans visible content", () => {
    const tools = [{ ...server, allowed_tools: { read_only: true } }];
    for (const output of [[], [{ ...listing(true), server_label: "other" }],
      [{ ...listing(true), tools: [{ name: "other", annotations: { readOnlyHint: true } }] }],
      [{ ...listing(true), tools: [{ name: "write" }] }],
      [{ type: "message", role: "assistant", content: [{ type: "output_text", text: JSON.stringify(listing(true)) }] }],
    ] satisfies JsonObject[][]) assert.equal(canApproveHostedMcp(approval, tools, output), false);
  });

  it("does not use an older hint after the latest native listing changed or omitted the tool", () => {
    const tools = [{ ...server, allowed_tools: { read_only: true } }];
    assert.equal(canApproveHostedMcp(approval, tools, [listing(true), listing(false)]), false);
    assert.equal(canApproveHostedMcp(approval, tools, [listing(false), listing(true)]), true);
    assert.equal(canApproveHostedMcp(approval, tools, [listing(true), { ...listing(true), tools: [] }]), false);
  });

  it("fails closed for malformed constrained filters", () => {
    for (const allowed_tools of ["write", { read_only: "true" }, { tool_names: "write" }]) {
      assert.equal(canApproveHostedMcp(approval, [{ ...server, allowed_tools }], [listing(true)]), false);
    }
  });
});

describe("Responses hosted transcript status", () => {
  it("preserves failed and unfinished native operations when recovering terminal output", () => {
    const assistant: AssistantMessage = { id: "a", role: "assistant", createdAt: 1, parts: [] };
    applyResponsesOutput(assistant, [
      { type: "web_search_call", id: "search", status: "in_progress" },
      { type: "code_interpreter_call", id: "code", status: "completed" },
      { type: "mcp_call", id: "mcp", status: "completed", error: { message: "Remote operation failed" } },
    ], true);
    assert.deepEqual(assistant.parts.map((part) => part.type === "hosted_tool" && [part.id, part.status]), [
      ["search", "incomplete"], ["code", "completed"], ["mcp", "failed"],
    ]);
  });

  it("stops progress spinners at the stream boundary without altering authoritative response state", () => {
    const assistant: AssistantMessage = { id: "a", role: "assistant", createdAt: 1, parts: [
      { type: "hosted_tool", id: "search", name: "web_search", status: "in_progress" },
      { type: "hosted_tool", id: "code", name: "code_interpreter", status: "completed" },
      { type: "model_response", providerScope: "scope", responseId: "resp", status: "in_progress", stored: true, output: [] },
    ] };
    assert.deepEqual(sealHostedToolProgress(assistant).map((part) => [part.id, part.status]), [["search", "incomplete"]]);
    assert.equal(assistant.parts[2]?.type === "model_response" && assistant.parts[2].status, "in_progress");
    assert.equal(sealHostedToolProgress(assistant).length, 0);
    applyResponsesOutput(assistant, [{ type: "web_search_call", id: "search", status: "completed" }], true);
    assert.equal(assistant.parts[0]?.type === "hosted_tool" && assistant.parts[0].status, "completed");
  });
});
