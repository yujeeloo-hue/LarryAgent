import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  resolveComposerSubmitAction,
  type ComposerSubmitContext,
} from "./promptQueueGesture.js";

const ctx = (over: Partial<ComposerSubmitContext> = {}): ComposerSubmitContext => ({
  hasContent: false,
  running: false,
  queueHasDeferred: false,
  ...over,
});

describe("resolveComposerSubmitAction", () => {
  it("idle session: content sends, empty is ignored", () => {
    assert.equal(resolveComposerSubmitAction(ctx({ hasContent: true })), "send");
    assert.equal(resolveComposerSubmitAction(ctx()), "noop");
  });

  it("running turn + content: queues instead of steering (new default)", () => {
    assert.equal(
      resolveComposerSubmitAction(ctx({ running: true, hasContent: true })),
      "enqueue",
    );
    // Queue contents never change what a typed prompt does.
    assert.equal(
      resolveComposerSubmitAction(
        ctx({ running: true, hasContent: true, queueHasDeferred: true }),
      ),
      "enqueue",
    );
  });

  it("running turn + empty composer + waiting item: Enter arms the head", () => {
    assert.equal(
      resolveComposerSubmitAction(ctx({ running: true, queueHasDeferred: true })),
      "promote-head",
    );
  });

  it("running turn + empty composer + nothing waiting: Stop stays reachable", () => {
    assert.equal(resolveComposerSubmitAction(ctx({ running: true })), "stop");
  });

  it("idle session never promotes — an idle queue is sent from the row", () => {
    assert.equal(
      resolveComposerSubmitAction(ctx({ queueHasDeferred: true })),
      "noop",
    );
  });
});
