import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { QueuedPrompt, QueuedPromptMode } from "../agent/ipcTypes.js";
import type { SessionStatus } from "../session/types.js";
import {
  demoteArmedOnTurnEnd,
  enqueuePrompt,
  hasArmedInterrupt,
  moveQueuedToFront,
  normalizeQueuedPromptMode,
  PROMPT_QUEUE_MAX,
  promptQueueDrainDecision,
  removeQueued,
  setQueuedMode,
  takeArmedInterrupts,
  updateQueuedText,
} from "./promptQueue.js";

let seq = 0;
function add(
  items: QueuedPrompt[],
  text: string,
  mode: QueuedPromptMode = "deferred",
): QueuedPrompt[] {
  seq += 1;
  const result = enqueuePrompt(items, {
    sessionId: "s1",
    userText: text,
    attachments: [],
    mode,
    id: `q${seq}`,
    createdAt: 1000 + seq,
  });
  assert.ok(result.ok, `enqueue ${text} must succeed`);
  return result.items;
}

const ids = (items: QueuedPrompt[]): string[] => items.map((i) => i.id);
const texts = (items: QueuedPrompt[]): string[] => items.map((i) => i.userText);

describe("enqueuePrompt", () => {
  it("appends in submission order (no last-wins replacement)", () => {
    let items: QueuedPrompt[] = [];
    items = add(items, "first");
    items = add(items, "second");
    items = add(items, "third");
    assert.deepEqual(texts(items), ["first", "second", "third"]);
  });

  it("defaults are caller-supplied; deferred never auto-arms", () => {
    const items = add([], "hello");
    assert.equal(items[0]?.mode, "deferred");
    assert.equal(hasArmedInterrupt(items), false);
  });

  it("trims text and rejects an empty prompt with no attachments", () => {
    const trimmed = add([], "  padded  ");
    assert.equal(trimmed[0]?.userText, "padded");

    const empty = enqueuePrompt([], {
      sessionId: "s1",
      userText: "   \n ",
      attachments: [],
      mode: "deferred",
      id: "x",
      createdAt: 1,
    });
    assert.equal(empty.ok, false);
    assert.equal(empty.ok === false && empty.reason, "empty");
  });

  it("accepts an attachment-only prompt (no text)", () => {
    const result = enqueuePrompt([], {
      sessionId: "s1",
      userText: "",
      attachments: [
        { path: "/tmp/a.png", name: "a.png", kind: "image", mimeType: "image/png" },
      ],
      mode: "deferred",
      id: "x",
      createdAt: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.items.length, 1);
  });

  it("rejects past the cap and leaves the queue untouched", () => {
    let items: QueuedPrompt[] = [];
    for (let i = 0; i < PROMPT_QUEUE_MAX; i += 1) {
      items = add(items, `p${i}`);
    }
    const result = enqueuePrompt(items, {
      sessionId: "s1",
      userText: "overflow",
      attachments: [],
      mode: "deferred",
      id: "over",
      createdAt: 9,
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "cap");
    assert.equal(result.items.length, PROMPT_QUEUE_MAX);
  });

  it("does not mutate the input array", () => {
    const base = add([], "keep");
    const snapshot = ids(base);
    add(base, "another");
    assert.deepEqual(ids(base), snapshot);
  });
});

describe("removeQueued / updateQueuedText", () => {
  it("removes by id and reports a miss for an unknown id", () => {
    let items = add([], "a");
    items = add(items, "b");
    const hit = removeQueued(items, items[0]!.id);
    assert.equal(hit.ok, true);
    assert.deepEqual(texts(hit.items), ["b"]);

    const miss = removeQueued(items, "nope");
    assert.equal(miss.ok, false);
    assert.equal(miss.items.length, 2);
  });

  it("edits text in place and keeps mode + position", () => {
    let items = add([], "a");
    items = add(items, "b", "interrupt");
    const result = updateQueuedText(items, items[1]!.id, "  edited  ");
    assert.equal(result.ok, true);
    assert.deepEqual(texts(result.items), ["a", "edited"]);
    assert.equal(result.items[1]?.mode, "interrupt");
  });

  it("clearing the text of a text-only item removes it", () => {
    const items = add([], "a");
    const result = updateQueuedText(items, items[0]!.id, "   ");
    assert.equal(result.ok, true);
    assert.equal(result.removed, true);
    assert.equal(result.items.length, 0);
  });

  it("clearing the text of an attachment-carrying item keeps the row", () => {
    const enqueued = enqueuePrompt([], {
      sessionId: "s1",
      userText: "look",
      attachments: [
        { path: "/tmp/a.png", name: "a.png", kind: "image", mimeType: "image/png" },
      ],
      mode: "deferred",
      id: "att",
      createdAt: 1,
    });
    assert.ok(enqueued.ok);
    const result = updateQueuedText(enqueued.items, "att", "");
    assert.equal(result.ok, true);
    assert.notEqual(result.removed, true);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.userText, "");
  });
});

describe("setQueuedMode / moveQueuedToFront", () => {
  it("arms and disarms one item without touching siblings", () => {
    let items = add([], "a");
    items = add(items, "b");
    const armed = setQueuedMode(items, items[1]!.id, "interrupt");
    assert.equal(armed.ok, true);
    assert.deepEqual(
      armed.items.map((i) => i.mode),
      ["deferred", "interrupt"],
    );

    const disarmed = setQueuedMode(armed.items, items[1]!.id, "deferred");
    assert.deepEqual(
      disarmed.items.map((i) => i.mode),
      ["deferred", "deferred"],
    );
  });

  it("reports a miss for an unknown id", () => {
    const items = add([], "a");
    assert.equal(setQueuedMode(items, "nope", "interrupt").ok, false);
    assert.equal(moveQueuedToFront(items, "nope").ok, false);
  });

  it("moves to front and preserves the order of the rest", () => {
    let items = add([], "a");
    items = add(items, "b");
    items = add(items, "c");
    const result = moveQueuedToFront(items, items[2]!.id);
    assert.equal(result.ok, true);
    assert.deepEqual(texts(result.items), ["c", "a", "b"]);
  });

  it("moving the head item is a no-op success", () => {
    let items = add([], "a");
    items = add(items, "b");
    const result = moveQueuedToFront(items, items[0]!.id);
    assert.equal(result.ok, true);
    assert.deepEqual(texts(result.items), ["a", "b"]);
  });
});

describe("takeArmedInterrupts (merge drain)", () => {
  it("takes ALL armed interrupt items in FIFO order, deferred untouched", () => {
    let items = add([], "a");
    items = add(items, "b", "interrupt");
    items = add(items, "c");
    items = add(items, "d", "interrupt");
    const result = takeArmedInterrupts(items);
    assert.deepEqual(texts(result.taken), ["b", "d"]);
    assert.deepEqual(texts(result.items), ["a", "c"]);
  });

  it("returns an empty take when nothing is armed", () => {
    const items = add([], "a");
    const result = takeArmedInterrupts(items);
    assert.deepEqual(result.taken, []);
    assert.equal(result.items.length, 1);
  });
});

describe("normalizeQueuedPromptMode (intake shim)", () => {
  it("maps legacy steer to interrupt, everything else to deferred", () => {
    assert.equal(normalizeQueuedPromptMode("steer"), "interrupt");
    assert.equal(normalizeQueuedPromptMode("interrupt"), "interrupt");
    assert.equal(normalizeQueuedPromptMode("deferred"), "deferred");
    assert.equal(normalizeQueuedPromptMode(undefined), "deferred");
    assert.equal(normalizeQueuedPromptMode("nonsense"), "deferred");
  });

  it("enqueuePrompt stores a legacy steer value as interrupt", () => {
    const result = enqueuePrompt([], {
      sessionId: "s1",
      userText: "legacy",
      attachments: [],
      mode: "steer" as never,
      id: "shim",
      createdAt: 1,
    });
    assert.ok(result.ok);
    assert.equal(result.ok && result.queued.mode, "interrupt");
  });
});

describe("demoteArmedOnTurnEnd", () => {
  it("armed items that missed their window fall back to deferred", () => {
    let items = add([], "a");
    items = add(items, "b", "interrupt");
    const result = demoteArmedOnTurnEnd(items);
    assert.equal(result.changed, true);
    assert.deepEqual(
      result.items.map((i) => i.mode),
      ["deferred", "deferred"],
    );
    // Nothing is dropped — the user still owns the prompts.
    assert.deepEqual(texts(result.items), ["a", "b"]);
  });

  it("is a no-op when nothing was armed", () => {
    const items = add([], "a");
    const result = demoteArmedOnTurnEnd(items);
    assert.equal(result.changed, false);
    assert.equal(result.items, items);
  });
});

const DRAIN = {
  queueLength: 1,
  status: "idle" as SessionStatus,
  hasAbort: false,
  compacting: false,
  waitingInput: false,
  planApprovalTookPrecedence: false,
  draining: false,
};

describe("promptQueueDrainDecision (turn finally)", () => {
  it("drains a queued prompt after a cleanly completed turn", () => {
    assert.deepEqual(promptQueueDrainDecision(DRAIN), { drain: true });
  });

  it("does nothing with an empty queue", () => {
    const decision = promptQueueDrainDecision({ ...DRAIN, queueLength: 0 });
    assert.equal(decision.drain, false);
    assert.equal(decision.reason, "empty");
  });

  it("keeps the queue for every non-clean terminal status", () => {
    for (const status of [
      "paused",
      "cancelled",
      "error",
      "completed",
    ] as SessionStatus[]) {
      const decision = promptQueueDrainDecision({ ...DRAIN, status });
      assert.equal(decision.drain, false, `status ${status} must not drain`);
      assert.equal(decision.reason, "not_completed");
    }
  });

  it("yields to a queued plan approval", () => {
    const decision = promptQueueDrainDecision({
      ...DRAIN,
      planApprovalTookPrecedence: true,
    });
    assert.equal(decision.drain, false);
    assert.equal(decision.reason, "plan_approval");
  });

  it("yields to an in-flight turn, a compaction pass and a waiting card", () => {
    assert.equal(
      promptQueueDrainDecision({ ...DRAIN, hasAbort: true }).reason,
      "turn_in_flight",
    );
    assert.equal(
      promptQueueDrainDecision({ ...DRAIN, compacting: true }).reason,
      "compacting",
    );
    assert.equal(
      promptQueueDrainDecision({ ...DRAIN, waitingInput: true }).reason,
      "waiting_input",
    );
  });

  it("single-flights: a drain already in progress blocks a second one", () => {
    const decision = promptQueueDrainDecision({ ...DRAIN, draining: true });
    assert.equal(decision.drain, false);
    assert.equal(decision.reason, "already_draining");
  });

  it("guard order: single-flight before precedence before status", () => {
    const all = promptQueueDrainDecision({
      queueLength: 2,
      status: "error",
      hasAbort: true,
      compacting: true,
      waitingInput: true,
      planApprovalTookPrecedence: true,
      draining: true,
    });
    assert.equal(all.reason, "already_draining");
  });
});
