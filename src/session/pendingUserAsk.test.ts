import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sealOrphanToolCallsInSession } from "../agent/sealOrphanToolCalls.js";
import { ToolReturnCode } from "./returnCodes.js";
import {
  appendAskUserToolResult,
  cancelAskUserToolCall,
  formatAskAnswerText,
  parseSessionPendingUserAsk,
} from "./pendingUserAsk.js";
import type { Session } from "./types.js";
import type { SessionPendingUserAsk } from "./pendingUserAsk.js";

function minimalSession(overrides?: Partial<Session>): Session {
  return {
    id: "s1",
    type: "agent",
    title: "Test",
    createdAt: 1,
    updatedAt: 1,
    status: "idle",
    progressText: "",
    messages: [],
    model: "m",
    providerId: "p",
    workspaceId: "w",
    workspacePath: "/tmp",
    pinned: false,
    archived: false,
    archivedAt: null,
    contextUsage: { usedTokens: 0 },
    plan: null,
    ...overrides,
  };
}

describe("parseSessionPendingUserAsk", () => {
  it("restores option descriptions and ignores details for missing labels", () => {
    const restored = parseSessionPendingUserAsk(JSON.stringify({ requestId: "r-details", toolCallId: "ask-details", assistantMessageId: "a1",
      question: "Scope?", options: ["Preview", "Build"], optionDetails: [
        { label: " Preview ", description: " Review first ", recommended: true },
        { label: "Missing", description: "Ignore" }, null,
      ] }));
    assert.deepEqual(restored?.optionDetails, [{ label: "Preview", description: "Review first", recommended: true }]);
  });
  it("round-trips valid JSON", () => {
    const raw = JSON.stringify({
      requestId: "r1",
      toolCallId: "tc1",
      question: "Pick one",
      options: ["A", "B"],
      allowCustom: true,
      allowMultiple: false,
      assistantMessageId: "a1",
      remainingToolCallIds: ["tc2"],
      runMode: "plan",
      fullPermissions: true,
      autoSkillSummarize: false,
      createdAt: 123,
    });
    const parsed = parseSessionPendingUserAsk(raw);
    assert.ok(parsed);
    assert.equal(parsed.requestId, "r1");
    assert.equal(parsed.remainingToolCallIds.length, 1);
    assert.equal(parsed.runMode, "plan");
  });

  it("treats unknown runMode including legacy infinite as agent", () => {
    const raw = JSON.stringify({
      requestId: "r2",
      toolCallId: "tc2",
      question: "Pick one",
      options: ["A", "B"],
      assistantMessageId: "a1",
      remainingToolCallIds: [],
      runMode: "infinite",
      fullPermissions: false,
      autoSkillSummarize: false,
      createdAt: 1,
    });
    const parsed = parseSessionPendingUserAsk(raw);
    assert.ok(parsed);
    assert.equal(parsed.runMode, "agent");
  });

  it("round-trips an open-ended ask (empty options)", () => {
    const raw = JSON.stringify({
      requestId: "r-open",
      toolCallId: "tc-open",
      question: "Describe the vibe",
      options: [],
      allowCustom: true,
      allowMultiple: false,
      assistantMessageId: "a1",
      remainingToolCallIds: [],
      runMode: "agent",
      fullPermissions: false,
      autoSkillSummarize: false,
      createdAt: 5,
    });
    const parsed = parseSessionPendingUserAsk(raw);
    assert.ok(parsed);
    assert.deepEqual(parsed.options, []);
  });

  it("missing options parse as open-ended instead of being dropped", () => {
    const raw = JSON.stringify({
      requestId: "r-open2",
      toolCallId: "tc-open2",
      question: "Any thoughts?",
      assistantMessageId: "a1",
      remainingToolCallIds: [],
    });
    const parsed = parseSessionPendingUserAsk(raw);
    assert.ok(parsed);
    assert.deepEqual(parsed.options, []);
  });
});

describe("sealOrphanToolCallsInSession with pendingUserAsk", () => {
  it("skips the persisted ask_user tool_call", () => {
    const session = minimalSession({
      pendingUserAsk: {
        requestId: "r1",
        toolCallId: "tc-ask",
        question: "Q?",
        options: ["Yes", "No"],
        allowCustom: false,
        allowMultiple: false,
        assistantMessageId: "a1",
        remainingToolCallIds: [],
        runMode: "agent",
        fullPermissions: false,
        autoSkillSummarize: false,
        createdAt: 1,
      },
      messages: [
        {
          id: "a1",
          role: "assistant",
          createdAt: 1,
          parts: [
            {
              type: "tool_call",
              id: "tc-ask",
              name: "ask_user",
              status: "running",
              arguments: { question: "Q?", options: ["Yes", "No"] },
              argumentsRaw: "{}",
            },
          ],
        },
      ],
    });
    const sealed = sealOrphanToolCallsInSession(session, () => "m1");
    assert.equal(sealed, 0);
    assert.equal(session.messages.length, 1);
  });
});

describe("appendAskUserToolResult", () => {
  it("appends a success tool_result for the pending ask call", () => {
    const session = minimalSession({
      messages: [
        {
          id: "a1",
          role: "assistant",
          createdAt: 1,
          parts: [
            {
              type: "tool_call",
              id: "tc-ask",
              name: "ask_user",
              status: "running",
              arguments: { question: "Q?", options: ["Yes", "No"] },
              argumentsRaw: "{}",
            },
          ],
        },
      ],
    });
    const ok = appendAskUserToolResult(
      session,
      {
        requestId: "r1",
        toolCallId: "tc-ask",
        question: "Q?",
        options: ["Yes", "No"],
        allowCustom: false,
        allowMultiple: false,
        assistantMessageId: "a1",
        remainingToolCallIds: [],
        runMode: "agent",
        fullPermissions: false,
        autoSkillSummarize: false,
        createdAt: 1,
      },
      { selected: "Yes", custom: false },
      () => "m1",
    );
    assert.equal(ok, true);
    assert.equal(session.messages.length, 2);
    assert.equal(session.messages[1]?.role, "tool");
    const call = session.messages[0]?.parts[0];
    assert.ok(call);
    assert.equal(call.type, "tool_call");
    if (call.type === "tool_call") {
      assert.equal(call.status, "done");
    }
  });

  it("formats an open-ended persisted answer as structured JSON", () => {
    const session = minimalSession({
      messages: [
        {
          id: "a1",
          role: "assistant",
          createdAt: 1,
          parts: [
            {
              type: "tool_call",
              id: "tc-ask",
              name: "ask_user",
              status: "running",
              arguments: { question: "Describe the vibe" },
              argumentsRaw: "{}",
            },
          ],
        },
      ],
    });
    const ok = appendAskUserToolResult(
      session,
      {
        requestId: "r1",
        toolCallId: "tc-ask",
        question: "Describe the vibe",
        options: [],
        allowCustom: true,
        allowMultiple: false,
        assistantMessageId: "a1",
        remainingToolCallIds: [],
        runMode: "agent",
        fullPermissions: false,
        autoSkillSummarize: false,
        createdAt: 1,
      },
      { selected: "Calm, low-contrast, quiet", custom: true },
      () => "m1",
    );
    assert.equal(ok, true);
    const toolMessage = session.messages[1];
    assert.ok(toolMessage && toolMessage.role === "tool");
    const part = toolMessage.parts[0];
    assert.ok(part && part.type === "tool_result");
    if (part.type === "tool_result") {
      assert.equal(part.returnCode, ToolReturnCode.Success);
      const textPart = part.content[0];
      assert.ok(textPart && textPart.type === "text");
      assert.equal(
        textPart.type === "text" ? textPart.text : null,
        JSON.stringify({ selected_options: [], custom_answer: "Calm, low-contrast, quiet", comment: null }),
      );
    }
  });
});

describe("formatAskAnswerText", () => {
  it("preserves selected labels and multiline supplemental instructions separately", () => {
    assert.deepEqual(JSON.parse(formatAskAnswerText({ selected: "Yes", custom: false, comment: " Scope only.\nNo deploy. " })),
      { selected_options: ["Yes"], custom_answer: null, comment: "Scope only.\nNo deploy." });
  });
  it("open-ended answers use custom_answer", () => {
    assert.equal(
      formatAskAnswerText(
        { selected: "Something like Notion", custom: true },
        true,
      ),
      JSON.stringify({ selected_options: [], custom_answer: "Something like Notion", comment: null }),
    );
  });

  it("choice mode distinguishes selections from custom answers", () => {
    assert.equal(
      formatAskAnswerText({ selected: "Other", custom: true }),
      JSON.stringify({ selected_options: [], custom_answer: "Other", comment: null }),
    );
    assert.equal(
      formatAskAnswerText({ selected: "Yes", custom: false }),
      JSON.stringify({ selected_options: ["Yes"], custom_answer: null, comment: null }),
    );
    assert.equal(
      formatAskAnswerText(
        { selected: "A, B", selections: ["A", "B"], custom: false },
      ),
      JSON.stringify({ selected_options: ["A", "B"], custom_answer: null, comment: null }),
    );
  });
});

describe("persisted ask_user ownership and replay", () => {
  const pending: SessionPendingUserAsk = {
    requestId: "request", toolCallId: "reused", assistantMessageId: "current",
    question: "Continue?", options: [], allowCustom: true, allowMultiple: false,
    remainingToolCallIds: [], runMode: "agent", fullPermissions: false,
    autoSkillSummarize: false, createdAt: 1,
  };
  function fixture() {
    const call = () => ({ type: "tool_call" as const, id: "reused", name: "ask_user",
      status: "running" as const, arguments: {}, argumentsRaw: "{}" });
    return minimalSession({ messages: [
      { id: "old", role: "assistant", createdAt: 1, parts: [call()] },
      { id: "old-result", role: "tool", toolCallId: "reused", createdAt: 1,
        parts: [{ type: "tool_result", toolCallId: "reused", returnCode: 0, content: [] }] },
      { id: "current", role: "assistant", createdAt: 2, parts: [call()] },
      { id: "later", role: "assistant", createdAt: 3, parts: [] },
    ] });
  }

  it("updates and inserts the answer under the exact assistant even if a call id is reused", () => {
    const session = fixture();
    assert.equal(appendAskUserToolResult(session, pending, { selected: "Yes", custom: true }, () => "answer"), true);
    const old = session.messages[0]!.parts[0]!;
    const current = session.messages[2]!.parts[0]!;
    assert.equal(old.type === "tool_call" && old.status, "running");
    assert.equal(current.type === "tool_call" && current.status, "done");
    assert.equal(session.messages[3]!.id, "answer");
    assert.equal(session.messages[4]!.id, "later");
  });

  it("replaying an answer or cancellation never appends or overwrites a recorded result", () => {
    for (const cancelFirst of [false, true]) {
      const session = fixture();
      if (cancelFirst) cancelAskUserToolCall(session, pending, () => "cancel");
      else appendAskUserToolResult(session, pending, { selected: "Yes", custom: true }, () => "answer");
      const before = structuredClone(session);
      assert.equal(appendAskUserToolResult(session, pending, { selected: "No", custom: true }, () => "duplicate"), true);
      assert.equal(cancelAskUserToolCall(session, pending, () => "duplicate"), true);
      assert.deepEqual(session, before);
    }
  });

  it("does not fall back to another assistant when the persisted owner is missing", () => {
    const session = fixture();
    const invalid = { ...pending, assistantMessageId: "missing" };
    assert.equal(appendAskUserToolResult(session, invalid, { selected: "Yes", custom: true }, () => "wrong"), false);
    assert.equal(cancelAskUserToolCall(session, invalid, () => "wrong"), false);
    assert.equal(session.messages.length, 4);
  });
});
