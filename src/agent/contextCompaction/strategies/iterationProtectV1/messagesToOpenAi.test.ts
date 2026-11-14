import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  ContextCompactionPart,
  Message,
  ToolCallPart,
  ToolResultPart,
} from "../../../../session/types.js";
import {
  buildModelMessages,
  liveTurnUserPrefixes,
} from "./messagesToOpenAi.js";

function user(id: string, text: string): Message {
  return { id, role: "user", parts: [{ type: "text", text }], createdAt: 1 };
}

function assistantTool(id: string, callId: string, name: string): Message {
  const call: ToolCallPart = {
    type: "tool_call",
    id: callId,
    name,
    status: "done",
    arguments: {},
    argumentsRaw: "{}",
  };
  return { id, role: "assistant", parts: [call], createdAt: 1 };
}

function tool(id: string, callId: string, text: string): Message {
  const result: ToolResultPart = {
    type: "tool_result",
    toolCallId: callId,
    returnCode: 0,
    content: [{ type: "text", text }],
  };
  return {
    id,
    role: "tool",
    toolCallId: callId,
    parts: [result],
    createdAt: 1,
  };
}

function marker(coveredThroughMessageId: string): Message {
  const part: ContextCompactionPart = {
    type: "context_compaction",
    id: "part-1",
    summary: "Earlier iterations were summarized.",
    fromMessageId: "u1",
    toMessageId: coveredThroughMessageId,
    coveredThroughMessageId,
    usedTokensBefore: 100_000,
    usedTokensAfter: 20_000,
  };
  return { id: "marker", role: "system", parts: [part], createdAt: 2 };
}

describe("iterationProtectV1 buildModelMessages keeps live-turn users", () => {
  it("splices the current Turn user when coverage cuts mid-turn", () => {
    const u1 = user("u1", "implement settings");
    const a1 = assistantTool("a1", "c1", "read_file");
    const t1 = tool("t1", "c1", "ok");
    const a2 = assistantTool("a2", "c2", "edit_file");
    const t2 = tool("t2", "c2", "ok");
    const messages: Message[] = [u1, a1, t1, a2, t2, marker("t1")];

    const wire = buildModelMessages(messages);
    assert.equal(wire[0]?.role, "system");
    assert.match(String(wire[0]?.content), /Earlier iterations/);
    assert.deepEqual(
      wire.slice(1).map((m) => m.role),
      ["user", "assistant", "tool"],
    );
    assert.equal(wire[1]?.content, "implement settings");
  });

  it("does not duplicate a user already after the coverage cursor", () => {
    const u1 = user("u1", "first");
    const a1 = assistantTool("a1", "c1", "read_file");
    const t1 = tool("t1", "c1", "ok");
    const u2 = user("u2", "continue");
    const a2 = assistantTool("a2", "c2", "edit_file");
    const t2 = tool("t2", "c2", "ok");
    const messages: Message[] = [u1, a1, t1, u2, a2, t2, marker("t1")];

    const wire = buildModelMessages(messages);
    const users = wire.filter((m) => m.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]?.content, "continue");
  });

  it("drops fully summarized Turns' users (they live in the summary)", () => {
    const u1 = user("u1", "old task");
    const a1 = assistantTool("a1", "c1", "read_file");
    const t1 = tool("t1", "c1", "ok");
    const u2 = user("u2", "new task");
    const a2 = assistantTool("a2", "c2", "edit_file");
    const t2 = tool("t2", "c2", "ok");
    const a3 = assistantTool("a3", "c3", "run_shell");
    const t3 = tool("t3", "c3", "ok");
    const messages: Message[] = [u1, a1, t1, u2, a2, t2, a3, t3, marker("t2")];

    const wire = buildModelMessages(messages);
    const users = wire.filter((m) => m.role === "user");
    assert.equal(users.length, 1);
    assert.equal(users[0]?.content, "new task");
    assert.deepEqual(
      wire.slice(1).map((m) => m.role),
      ["user", "assistant", "tool"],
    );
  });

  it("keeps covered pre-user messages off the wire", () => {
    const w1 = assistantTool("w1", "c0", "read_file");
    const wt1 = tool("wt1", "c0", "old wake result");
    const u1 = user("u1", "question");
    const a1 = assistantTool("a1", "c1", "read_file");
    const t1 = tool("t1", "c1", "ok");
    const a2 = assistantTool("a2", "c2", "edit_file");
    const t2 = tool("t2", "c2", "ok");

    const covered = buildModelMessages([w1, wt1, u1, a1, t1, a2, t2, marker("t1")]);
    assert.ok(!covered.some((m) => m.content === "old wake result"));
    assert.deepEqual(covered.slice(1).map((m) => m.role), ["user", "assistant", "tool"]);

    const partly = buildModelMessages([w1, wt1, u1, a1, t1, marker("w1")]);
    assert.ok(partly.some((m) => m.content === "old wake result"), "uncovered pre-user messages stay");
  });

  it("liveTurnUserPrefixes is empty when the user is already live", () => {
    const u2 = user("u2", "continue");
    const a2 = assistantTool("a2", "c2", "edit_file");
    const kept = liveTurnUserPrefixes(
      [user("u1", "first"), u2, a2],
      [u2, a2],
    );
    assert.deepEqual(kept, []);
  });
});
