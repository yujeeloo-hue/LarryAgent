/**
 * round_interrupted renderer handling: seal live stream chrome (Thinking
 * card) and drop write-stream preview cards whose tool call was dropped
 * main-side when the interrupt cut the stream mid-args.
 */
import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const moduleLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  return moduleLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });

type Controller = import("./ConversationController.js").ConversationController;
let ConversationController: typeof import("./ConversationController.js").ConversationController;
let state: typeof import("../../state/writeStreamState.js");
test.before(async () => {
  ({ ConversationController } = await import("./ConversationController.js"));
  state = await import("../../state/writeStreamState.js");
});

test("round_interrupted seals the Thinking card and removes unresolved write cards", () => {
  // Drive the process-wide write-stream listener like a real stream would.
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
  window.jellybot = bridge as unknown as NonNullable<Window["jellybot"]>;
  state.ensureWriteStreamBackgroundListener(window.jellybot!);
  assert.ok(handler);

  const sessionId = "s-round-interrupted";
  try {
    // Materialized call first (complete tool_call event → tool_finished
    // still to come), then two half-streamed calls the interrupt will cut:
    // one with a REAL id (provider sent the id before args finished) and one
    // still-unnamed pending entry. Ordered so the pending entry is not
    // adopted by the earlier tool_call (adoption is last-pending-per-message).
    handler!({
      sessionId,
      event: {
        type: "tool_call",
        id: "call-done",
        name: "write_file",
        messageId: "m1",
        arguments: {},
        argumentsRaw: "{}",
      },
    });
    handler!({
      sessionId,
      event: {
        type: "tool_call_delta",
        id: "call-real",
        name: "write_file",
        messageId: "m1",
        argumentsRawDelta: '{"path":"/x","content":"hal',
      },
    });
    handler!({
      sessionId,
      event: {
        type: "tool_call_delta",
        id: "pending-0",
        name: "write_fil",
        messageId: "m1",
        argumentsRawDelta: "",
      },
    });
    assert.equal(state.listWriteStreams(sessionId).length, 3);

    const finalizedReasoning: number[] = [];
    const removed: string[] = [];
    const controller = Object.assign(
      Object.create(ConversationController.prototype),
      {
        view: {
          foldHeldReplyIntoThought: () => {},
          finalizeStreamingReasoning: () => {
            finalizedReasoning.push(1);
          },
          removeToolCardByCallId: (id: string) => {
            removed.push(id);
          },
        },
        sessionId,
        destroyed: false,
        isLocallyStreaming: false,
        pendingReasoningDelta: "",
        pendingReasoningMessageId: null,
        dirtyWriteStreamIds: new Set<string>(),
        syncTurnProgress: () => {},
      },
    ) as Controller & { handleStreamEvent(event: unknown): void };

    controller.handleStreamEvent({ type: "round_interrupted", messageId: "m1" });

    assert.equal(finalizedReasoning.length, 1, "live Thinking card sealed");
    assert.deepEqual(
      [...removed].sort(),
      ["call-real", "pending-0"],
      "unresolved write preview cards removed",
    );
    assert.deepEqual(
      state.listWriteStreams(sessionId).map((e) => e.id),
      ["call-done"],
      "materialized call kept for its tool_finished",
    );
  } finally {
    state.clearSessionWriteStreams(sessionId);
  }
});
