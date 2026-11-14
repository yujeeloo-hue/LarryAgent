import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isConversationCardVisible,
  projectAssistantMessage,
  projectTranscriptMessages,
  projectTurnMessages,
  toolHintLabel,
} from "./turnDisplay.js";
import { RETRY_CONTINUATION_PART_ID } from "../../../../session/types.js";

describe("isConversationCardVisible", () => {
  it("shows background evidence reads and result submission as inspectable cards", () => {
    for (const name of ["coco_job_input", "read_coco_context", "submit_coco_result"]) assert.equal(isConversationCardVisible(name), true);
  });
  it("shows the allowlist and legacy write tools", () => {
    assert.equal(isConversationCardVisible("patch"), true);
    assert.equal(isConversationCardVisible("write_file"), true);
    assert.equal(isConversationCardVisible("upload_files"), true);
    assert.equal(isConversationCardVisible("ask_user"), true);
    assert.equal(isConversationCardVisible("edit_file"), true);
    assert.equal(isConversationCardVisible("append_file"), true);
    assert.equal(isConversationCardVisible("dispatch_subagent"), true);
    assert.equal(isConversationCardVisible("write_plan_doc"), true);
  });

  it("hides exploration tools and ordinary shells", () => {
    assert.equal(isConversationCardVisible("read_file"), false);
    assert.equal(isConversationCardVisible("grep"), false);
    assert.equal(isConversationCardVisible("run_shell", { command: "npm test" }), false);
    assert.equal(isConversationCardVisible("run_shell", { command: "false" }), false);
    assert.equal(isConversationCardVisible("update_plan"), false);
  });

  it("keeps a shell sleep countdown", () => {
    assert.equal(
      isConversationCardVisible("run_shell", { command: "sleep 8 && echo ok" }),
      true,
    );
  });
});

describe("projectTurnMessages", () => {
  it("keeps narration text in the column; hidden tools fold into Thinking", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "fix login" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Look first.", durationMs: 100, tokenCount: 4 },
          { type: "text", text: "I'll read the file." },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Now patch.", durationMs: 50, tokenCount: 3 },
          { type: "text", text: "Patching." },
          { type: "tool_call", id: "p1", name: "patch", arguments: { path: "a.ts" } },
          { type: "text", text: "Done." },
        ],
      },
    ]);

    assert.equal(projected[0]?.id, "u1");
    // Reasoning folds; its narration text stays in the column.
    assert.equal(projected[1]?.id, "turn-reasoning:a1");
    const firstBlock = projected[1]?.parts[0];
    assert.equal(firstBlock?.id, "turn-reasoning");
    assert.equal(firstBlock?.text, "Look first.");
    assert.equal(firstBlock?.durationMs, 100);
    assert.equal(firstBlock?.tokenCount, 4);
    assert.equal(projected[2]?.id, "a1");
    assert.deepEqual(
      projected[2]?.parts.map((part) => part.type === "tool_call" ? part.name : part.type),
      ["text"],
    );
    assert.equal(projected[2]?.parts[0]?.text, "I'll read the file.");
    // The hidden read hint and the next reasoning share one new block; the
    // painted card below seals it.
    assert.equal(projected[3]?.id, "turn-reasoning:a1:1");
    const secondBlock = projected[3]?.parts[0];
    assert.equal(secondBlock?.text, "Now patch.");
    assert.deepEqual(secondBlock?.toolHints, ["Read File a.ts"]);
    assert.equal(secondBlock?.durationMs, 50);
    assert.equal(secondBlock?.tokenCount, 3);
    assert.equal(projected[4]?.id, "a2");
    assert.deepEqual(
      projected[4]?.parts.map((part) => part.type === "tool_call" ? part.name : part.type),
      ["text", "patch", "text"],
    );
    assert.equal(projected[4]?.parts[2]?.text, "Done.");
    assert.equal(projected.length, 5);
  });

  it("opens a new Thinking block for the iteration after a card", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Write it." },
          { type: "tool_call", id: "w1", name: "write_file", arguments: { path: "a.ts" } },
        ],
      },
      { id: "t1", role: "tool", parts: [{ type: "tool_result", toolCallId: "w1", content: [] }] },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Check it." },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      { id: "t2", role: "tool", parts: [{ type: "tool_result", toolCallId: "r1", content: [] }] },
      { id: "a3", role: "assistant", parts: [{ type: "reasoning", text: "Looks right." }] },
    ]);
    assert.deepEqual(
      projected.map((message) => message.id),
      ["u1", "turn-reasoning:a1", "a1", "t1", "t2", "turn-reasoning:a2:1"],
    );
    assert.equal(projected[1]?.parts[0]?.text, "Write it.");
    assert.equal(projected[5]?.parts[0]?.text, "Check it.\n\nLooks right.");
  });

  it("puts Thinking at the end when the turn has no reply yet", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool_call", id: "w1", name: "write_file", arguments: { path: "a.ts" } },
          { type: "tool_call", id: "g1", name: "grep", arguments: { pattern: "x" } },
        ],
      },
    ]);
    assert.equal(projected[1]?.id, "a1");
    assert.equal(projected[2]?.id, "turn-reasoning:a1");
    assert.equal(projected.length, 3);
  });

  it("keeps a reply that never called a tool", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "hi" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Short." },
          { type: "text", text: "Hello." },
        ],
      },
    ]);
    assert.equal(projected[1]?.parts[0]?.type, "reasoning");
    assert.equal(projected[2]?.parts[0]?.text, "Hello.");
  });

  it("leaves the user steer in place", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool_call", id: "r1", name: "grep", arguments: { pattern: "x" } },
        ],
      },
      {
        id: "s1",
        role: "user",
        parts: [{ type: "text", id: "turn-continuation:steer", text: "also check css" }],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [{ type: "text", text: "Checked." }],
      },
    ]);
    assert.deepEqual(projected[1]?.parts[0]?.toolHints, ["Search x"]);
    assert.equal(projected[2]?.id, "s1");
    assert.equal(projected[3]?.parts[0]?.text, "Checked.");
  });

  it("opens a Thinking block from hidden tools alone (empty provider CoT)", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "" },
          { type: "tool_call", id: "s1", name: "run_shell", arguments: { command: "npm test" } },
          { type: "tool_call", id: "u1", name: "update_plan", arguments: {} },
        ],
      },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "All green." }] },
    ]);
    const thought = projected[1]?.parts[0];
    assert.equal(thought?.text, "");
    assert.deepEqual(thought?.toolHints, ["Shell npm test"]);
    assert.equal(projected[2]?.parts[0]?.text, "All green.");
  });

  it("opens a new Thinking block for thinking after painted reply text", () => {
    const findings = "## Findings\n\n- the login handler drops the cookie";
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "First pass.", tokenCount: 3 },
          { type: "text", text: findings },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "/x/y.ts" } },
        ],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Second pass.", tokenCount: 5 },
          { type: "text", text: "Fixed." },
        ],
      },
    ]);
    assert.deepEqual(
      projected.map((message) => message.id),
      ["u1", "turn-reasoning:a1", "a1", "turn-reasoning:a1:1", "a2"],
    );
    assert.equal(projected[1]?.parts[0]?.text, "First pass.");
    assert.equal(projected[1]?.parts[0]?.tokenCount, 3);
    assert.equal(projected[2]?.parts[0]?.text, findings);
    const second = projected[3]?.parts[0];
    assert.equal(second?.text, "Second pass.");
    assert.equal(second?.tokenCount, 5);
    assert.deepEqual(second?.toolHints, ["Read File y.ts"]);
    assert.equal(projected[4]?.parts[0]?.text, "Fixed.");
  });

  it("keeps one Thinking block across tool results and a stop seal", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "First." },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "a.ts" } },
        ],
      },
      {
        id: "t1",
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: "r1", content: [], returnCode: 0 }],
      },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Second." },
          { type: "tool_call", id: "g1", name: "grep", arguments: { pattern: "x" } },
        ],
      },
      {
        id: "t2",
        role: "tool",
        parts: [{ type: "tool_result", toolCallId: "g1", content: [], returnCode: 6 }],
      },
      { id: "a3", role: "assistant", parts: [{ type: "reasoning", text: "Third." }] },
    ]);
    const thoughts = projected.filter((message) =>
      message.parts.some((part) => part.id === "turn-reasoning"),
    );
    assert.equal(thoughts.length, 1);
    assert.equal(thoughts[0]?.parts[0]?.text, "First.\n\nSecond.\n\nThird.");
  });

  it("keeps substantial text in place even when a tool follows", () => {
    const long = "## Findings\n\n- the login handler drops the cookie";
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "text", text: long },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "/x/y.ts" } },
        ],
      },
    ]);
    assert.equal(projected[1]?.parts[0]?.text, long);
    assert.equal(projected[2]?.parts[0]?.text, "");
    assert.deepEqual(projected[2]?.parts[0]?.toolHints, ["Read File y.ts"]);
  });

  it("collects every hidden-tool call as a record with duration and failure", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Look." },
          { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "a.ts" },
            status: "done", durationMs: 300 },
          { type: "tool_call", id: "r2", name: "read_file", arguments: { path: "a.ts" },
            status: "done", durationMs: 150 },
          { type: "tool_call", id: "g1", name: "run_shell", arguments: { command: "npm test" },
            status: "error", durationMs: 8400 },
          { type: "tool_call", id: "p1", name: "patch", arguments: { path: "a.ts" },
            status: "done", durationMs: 50 },
        ],
      },
      { id: "a2", role: "assistant", parts: [{ type: "text", text: "Done." }] },
    ]);
    const thought = projected[1]?.parts[0];
    // Records keep every call (duplicates included) — merge ×N is render-side.
    // Card tools (patch) and silent tools stay out.
    assert.deepEqual(thought?.toolRecords, [
      { id: "r1", hint: "Read File a.ts", durationMs: 300 },
      { id: "r2", hint: "Read File a.ts", durationMs: 150 },
      { id: "g1", hint: "Shell npm test", durationMs: 8400, failed: true },
    ]);
    // Dock hints stay deduped (consecutive repeats collapse).
    assert.deepEqual(thought?.toolHints, ["Read File a.ts", "Shell npm test"]);
  });

  it("keeps records across tool-result rows in one Thinking block", () => {
    const projected = projectTurnMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "go" }] },
      {
        id: "a1",
        role: "assistant",
        parts: [
          { type: "tool_call", id: "r1", name: "grep", arguments: { pattern: "x" },
            status: "done", durationMs: 600 },
        ],
      },
      { id: "t1", role: "tool", parts: [{ type: "tool_result", toolCallId: "r1", content: [], returnCode: 0 }] },
      {
        id: "a2",
        role: "assistant",
        parts: [
          { type: "reasoning", text: "Found." },
        ],
      },
    ]);
    const thought = projected.find((message) =>
      message.parts.some((part) => part.id === "turn-reasoning"),
    )?.parts[0];
    assert.deepEqual(thought?.toolRecords, [
      { id: "r1", hint: "Search x", durationMs: 600 },
    ]);
  });
});

describe("projectTranscriptMessages", () => {
  it("drops hidden retry-continuation prompts (model-facing, UI-hidden)", () => {
    const projected = projectTranscriptMessages([
      { id: "u1", role: "user", parts: [{ type: "text", text: "fix login" }] },
      {
        id: "c1",
        role: "user",
        parts: [
          {
            type: "text",
            text: "The previous turn was interrupted by an error…",
            id: RETRY_CONTINUATION_PART_ID,
          },
        ],
      },
      {
        id: "a1",
        role: "assistant",
        parts: [{ type: "text", text: "Picking up where it stopped." }],
      },
    ]);
    assert.deepEqual(
      projected.map((message) => message.id),
      ["u1", "a1"],
    );
    // The hidden text must not leak through any projected part either.
    assert.equal(
      projected.some((message) =>
        message.parts.some(
          (part) => part.type === "text" && part.id === RETRY_CONTINUATION_PART_ID,
        ),
      ),
      false,
    );
  });
});

describe("toolHintLabel", () => {
  it("names hidden tools and stays silent for cards and plan bookkeeping", () => {
    assert.equal(toolHintLabel("grep", { pattern: "useAuth" }), "Search useAuth");
    assert.equal(
      toolHintLabel("tool_call", { name: "list_dir", arguments: { path: "/a/src/" } }),
      "List Directory src",
    );
    assert.equal(toolHintLabel("patch", { path: "a.ts" }), null);
    assert.equal(toolHintLabel("update_plan", {}), null);
    assert.equal(toolHintLabel("run_shell", { command: "sleep 5" }), null);
  });
});

describe("projectAssistantMessage", () => {
  it("keeps text that sits in front of a tool call in the same message", () => {
    const projected = projectAssistantMessage({
      id: "a1",
      role: "assistant",
      parts: [
        { type: "text", text: "Reading." },
        { type: "tool_call", id: "r1", name: "read_file", arguments: { path: "a.ts" } },
        { type: "text", text: "After." },
      ],
    });
    assert.deepEqual(
      projected.parts.map((part) => part.text),
      ["Reading.", "After."],
    );
  });
});
