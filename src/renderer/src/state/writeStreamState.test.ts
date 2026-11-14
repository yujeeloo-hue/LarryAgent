import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendToolCallArguments } from "../../../llm/appendToolCallArguments.js";
import {
  parsePartialWriteFileArgs,
  patchHeaderPathFromText,
} from "../screens/conversation/cards/parsePartialWriteArgs.js";
import {
  clearSessionWriteStreams,
  ensureWriteStreamBackgroundListener,
  listWriteStreams,
} from "./writeStreamState.js";

describe("write stream GLM snapshots", () => {
  it("keeps the latest content field instead of the first empty snapshot", () => {
    const merged = appendToolCallArguments(
      '{"path":"/x","content":""}',
      '{"path":"/x","content":"hello\\nworld"}',
    );
    const parsed = parsePartialWriteFileArgs(merged);
    assert.equal(parsed.path, "/x");
    assert.equal(parsed.content, "hello\nworld");
  });

  it("replaces unclosed growing snapshots before parsing content", () => {
    const merged = appendToolCallArguments(
      '{"path":"/x","content":"',
      '{"path":"/x","content":"hello\\nworld"}',
    );
    const parsed = parsePartialWriteFileArgs(merged);
    assert.equal(parsed.path, "/x");
    assert.equal(parsed.content, "hello\nworld");
  });

  it("does not stick on the first content when snapshots are concatenated", () => {
    const broken =
      '{"path":"/x","content":""}{"path":"/x","content":"hello\\nworld"}';
    const parsed = parsePartialWriteFileArgs(broken);
    assert.equal(parsed.content, "");
  });
});

describe("write_plan_doc partial args", () => {
  it("extracts title and content from complete JSON", () => {
    const parsed = parsePartialWriteFileArgs(
      '{"title":"FSM Node SelfLoop","content":"# Goal\\n\\nShip it.","summary":"s"}',
    );
    assert.equal(parsed.title, "FSM Node SelfLoop");
    assert.equal(parsed.content, "# Goal\n\nShip it.");
  });

  it("extracts title and streaming content from unclosed JSON", () => {
    const parsed = parsePartialWriteFileArgs(
      '{"title":"fsm-node-selfloop","content":"# Goal\\n\\nApproach still typi',
    );
    assert.equal(parsed.title, "fsm-node-selfloop");
    assert.equal(parsed.content, "# Goal\n\nApproach still typi");
  });

  it("tolerates a title whose value is still streaming in", () => {
    const parsed = parsePartialWriteFileArgs('{"title":"fsm nod');
    assert.equal(parsed.title, "fsm nod");
    assert.equal(parsed.content, undefined);
  });
});

describe("patchHeaderPathFromText streaming guards", () => {
  it("ignores an unterminated header line (path still streaming)", () => {
    const parsed = parsePartialWriteFileArgs(
      '{"patch":"*** Begin Patch\\n*** Update File: /Users/you',
    );
    assert.equal(
      parsed.patchText,
      "*** Begin Patch\n*** Update File: /Users/you",
    );
    // "/Users/you" is a cut-mid-stream fragment of /Users/youyee/… — the
    // file is not known yet, so no path hint may surface (card shows none).
    assert.equal(patchHeaderPathFromText(parsed.patchText!), undefined);
  });

  it("reads the path once the header line is newline-terminated", () => {
    assert.equal(
      patchHeaderPathFromText(
        "*** Begin Patch\n*** Update File: src/a.ts\n@@ -1 +1 @@\n",
      ),
      "src/a.ts",
    );
    assert.equal(
      patchHeaderPathFromText(
        "*** Begin Patch\n*** Update File: src/foo.ts\n@@ -1 +1 @@\n-x\n+y\n*** End Patch",
      ),
      "src/foo.ts",
    );
  });

  it("skips a partially streamed GNU header line too", () => {
    assert.equal(patchHeaderPathFromText("--- a/src/a"), undefined);
    assert.equal(patchHeaderPathFromText("--- a/src/a.ts\n+++ b/src/a"), "src/a.ts");
    assert.equal(
      patchHeaderPathFromText("--- a/src/a.ts\n+++ b/src/a.ts\n"),
      "src/a.ts",
    );
  });
});

describe("writeStreamState patch path", () => {
  it("does not stick on a mid-stream partial path (e.g. basename 'you')", () => {
    let handler:
      | ((payload: {
          sessionId: string;
          event: Record<string, unknown>;
        }) => void)
      | null = null;
    const bridge = {
      onAgentStream(
        cb: (payload: {
          sessionId: string;
          event: Record<string, unknown>;
        }) => void,
      ) {
        handler = cb;
        return () => {};
      },
    };
    ensureWriteStreamBackgroundListener(
      bridge as unknown as Parameters<
        typeof ensureWriteStreamBackgroundListener
      >[0],
    );
    assert.ok(handler);

    const sessionId = "s-patch-path";
    try {
      const delta = (chunk: string): void => {
        handler!({
          sessionId,
          event: {
            type: "tool_call_delta",
            id: "t-patch-1",
            name: "patch",
            messageId: "m1",
            argumentsRawDelta: chunk,
          },
        });
      };

      // Delta lands exactly after "/Users/you" — path unknown, no sticky value.
      delta('{"patch":"*** Begin Patch\\n*** Update File: /Users/you');
      const partial = listWriteStreams(sessionId)[0];
      assert.ok(partial);
      assert.equal(partial.name, "patch");
      assert.equal(partial.path, undefined);

      // Header line completes — path becomes the full file.
      delta(
        'yee/Developer/JellyBot/src/renderer/foo.ts\\n@@ -1 +1 @@\\n-a\\n+b\\n*** End Patch\\n"}',
      );
      const complete = listWriteStreams(sessionId)[0];
      assert.ok(complete);
      assert.equal(
        complete.path,
        "/Users/youyee/Developer/JellyBot/src/renderer/foo.ts",
      );
    } finally {
      clearSessionWriteStreams(sessionId);
    }
  });
});
