import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AGED_TOOL_RESULT_STUB,
  messagesToOpenAi,
  REASONING_ONLY_ASSISTANT_CONTENT,
} from "./messagesToOpenAi.js";
import type { Message, ToolCallPart, ToolResultPart } from "../../session/types.js";

function assistantCall(
  id: string,
  name: string,
  args: ToolCallPart["arguments"] = {},
): Message {
  const call: ToolCallPart = {
    type: "tool_call",
    id,
    name,
    status: "done",
    arguments: args,
    argumentsRaw: JSON.stringify(args),
  };
  return { id: `a-${id}`, role: "assistant", parts: [call], createdAt: 1 };
}

function toolResult(callId: string, text: string): Message {
  const result: ToolResultPart = {
    type: "tool_result",
    toolCallId: callId,
    returnCode: 0,
    content: [{ type: "text", text }],
  };
  return {
    id: `t-${callId}`,
    role: "tool",
    toolCallId: callId,
    parts: [result],
    createdAt: 1,
  };
}

describe("messagesToOpenAi interrupted assistant recovery", () => {
  it("drops an empty assistant shell", () => {
    const wire = messagesToOpenAi([
      {
        id: "a-empty",
        role: "assistant",
        parts: [{ type: "text", text: " \n " }],
        createdAt: 1,
      },
    ]);

    assert.deepEqual(wire, []);
  });

  it("gives a reasoning-only assistant non-empty wire content", () => {
    const wire = messagesToOpenAi([
      {
        id: "a-reasoning",
        role: "assistant",
        parts: [{ type: "reasoning", text: "Partial thought" }],
        createdAt: 1,
      },
    ]);

    assert.equal(wire[0]?.content, REASONING_ONLY_ASSISTANT_CONTENT);
    assert.equal(wire[0]?.reasoning_content, "Partial thought");
  });
});

describe("messagesToOpenAi patch aging", () => {
  it("keeps long patch results on aged iterations (failure excerpts)", () => {
    const excerpt = `PATCH FAILED — old_string not found in /tmp/x.ts.\n${"3|source line\n".repeat(40)}`;
    const wire = messagesToOpenAi(
      [assistantCall("c1", "patch"), toolResult("c1", excerpt)],
      { ageToolResults: true },
    );
    assert.equal(wire[1]?.role, "tool");
    assert.equal(wire[1]?.content, excerpt);
  });

  it("keeps legacy long edit_file results exempt (history replay)", () => {
    const excerpt = `EDIT APPLIED — replaced unique match at line 2 in /tmp/x.ts.\n${"body\n".repeat(80)}`;
    const wire = messagesToOpenAi(
      [assistantCall("c1", "edit_file"), toolResult("c1", excerpt)],
      { ageToolResults: true },
    );
    assert.equal(wire[1]?.role, "tool");
    assert.equal(wire[1]?.content, excerpt);
  });

  it("stubs other long tool results when aging", () => {
    const excerpt = `read_file output\n${"line\n".repeat(80)}`;
    const wire = messagesToOpenAi(
      [assistantCall("c1", "read_file"), toolResult("c1", excerpt)],
      { ageToolResults: true },
    );
    assert.equal(wire[1]?.content, AGED_TOOL_RESULT_STUB);
  });
});

describe("messagesToOpenAi write-arg wire stubbing", () => {
  it("stubs V4A patch body but keeps mode on aged iterations", () => {
    const patch = "*** Begin Patch\n*** Update File: a.ts\n-old\n+new\n*** End Patch";
    const wire = messagesToOpenAi(
      [assistantCall("c1", "patch", { mode: "patch", patch })],
      { stubWriteArgs: true },
    );
    const toolCalls = wire[0]?.tool_calls ?? [];
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments ?? "{}")) as Record<
      string,
      unknown
    >;
    assert.equal(args.patch, undefined);
    assert.equal(args.mode, "patch");
    assert.equal(args._wire, "content_omitted");
    assert.equal(typeof args.patchSha256, "string");
    assert.equal(args.patchChars, patch.length);
  });

  it("does not stub replace-mode old_string/new_string", () => {
    const wire = messagesToOpenAi(
      [
        assistantCall("c1", "patch", {
          path: "/w/f.ts",
          old_string: "foo",
          new_string: "bar",
        }),
      ],
      { stubWriteArgs: true },
    );
    const toolCalls = wire[0]?.tool_calls ?? [];
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments ?? "{}")) as Record<
      string,
      unknown
    >;
    assert.equal(args.old_string, "foo");
    assert.equal(args.new_string, "bar");
    assert.equal(args._wire, undefined);
  });

  it("stubs legacy GNU patch_text on aged iterations (history replay)", () => {
    const patchText = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+B\n";
    const wire = messagesToOpenAi(
      [assistantCall("c1", "patch", { patch_text: patchText, strip: 1 })],
      { stubWriteArgs: true },
    );
    const toolCalls = wire[0]?.tool_calls ?? [];
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments ?? "{}")) as Record<
      string,
      unknown
    >;
    assert.equal(args.patch_text, undefined);
    assert.equal(args.strip, 1);
    assert.equal(args._wire, "content_omitted");
  });

  it("keeps full V4A patch on raw iterations (stubWriteArgs off)", () => {
    const patch = "*** Begin Patch\n*** Update File: x\n-a\n+B\n*** End Patch";
    const wire = messagesToOpenAi(
      [assistantCall("c1", "patch", { mode: "patch", patch })],
      {},
    );
    const toolCalls = wire[0]?.tool_calls ?? [];
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments ?? "{}")) as Record<
      string,
      unknown
    >;
    assert.equal(args.patch, patch);
    assert.equal(args._wire, undefined);
  });

  it("still stubs write_file content", () => {
    const wire = messagesToOpenAi(
      [assistantCall("c1", "write_file", { path: "/w/f.ts", content: "x".repeat(500) })],
      { stubWriteArgs: true },
    );
    const toolCalls = wire[0]?.tool_calls ?? [];
    const args = JSON.parse(String(toolCalls[0]?.function?.arguments ?? "{}")) as Record<
      string,
      unknown
    >;
    assert.equal(args.content, undefined);
    assert.equal(args.path, "/w/f.ts");
    assert.equal(args._wire, "content_omitted");
  });
});
