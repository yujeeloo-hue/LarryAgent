/**
 * Submit-gesture matrix — verbatim port of the desktop promptQueueGesture
 * tests so Mac and web keep the same queue-vs-send semantics.
 */
import test from "node:test";
import assert from "node:assert/strict";

import {
  resolveComposerSubmitAction,
  type ComposerSubmitContext,
} from "../src/promptQueueGesture.js";

const ctx = (over: Partial<ComposerSubmitContext> = {}): ComposerSubmitContext => ({
  hasContent: false,
  running: false,
  queueHasDeferred: false,
  ...over,
});

test("idle session: content sends, empty is ignored", () => {
  assert.equal(resolveComposerSubmitAction(ctx({ hasContent: true })), "send");
  assert.equal(resolveComposerSubmitAction(ctx()), "noop");
});

test("running turn + content: queues instead of steering (new default)", () => {
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

test("running turn + empty composer + waiting item: Enter arms the head", () => {
  assert.equal(
    resolveComposerSubmitAction(ctx({ running: true, queueHasDeferred: true })),
    "promote-head",
  );
});

test("running turn + empty composer + nothing waiting: Stop stays reachable", () => {
  assert.equal(resolveComposerSubmitAction(ctx({ running: true })), "stop");
});

test("idle session never promotes — an idle queue is sent from the row", () => {
  assert.equal(
    resolveComposerSubmitAction(ctx({ queueHasDeferred: true })),
    "noop",
  );
});
