import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_TAIL_TURNS,
  clampTailTurns,
  isContextClearMessage,
  isTurnStartUserMessage,
  sliceSessionTailWindow,
  sliceSessionWindowBefore,
} from "./messageWindow.js";
import { STEER_CONTINUATION_PART_ID, RETRY_CONTINUATION_PART_ID, type Message } from "./types.js";

let seq = 0;
function msg(
  role: Message["role"],
  opts?: { id?: string; steer?: boolean; retryContinuation?: boolean; clear?: boolean },
): Message {
  seq += 1;
  const id = opts?.id ?? `m${seq}`;
  const parts: Message["parts"] = [];
  if (opts?.clear) {
    parts.push({ type: "context_clear", id: `${id}-clear`, clearedMessageCount: 0 });
  } else if (role === "user" && opts?.steer) {
    parts.push({ type: "text", text: "steer", id: STEER_CONTINUATION_PART_ID });
  } else if (role === "user" && opts?.retryContinuation) {
    parts.push({
      type: "text",
      text: "continue the task",
      id: RETRY_CONTINUATION_PART_ID,
    });
  } else if (role !== "system") {
    parts.push({ type: "text", text: `body ${id}` });
  }
  if (role === "tool") {
    return { id, role, parts, createdAt: seq, toolCallId: `${id}-call` };
  }
  return { id, role, parts, createdAt: seq };
}

function userTurn(n: number): Message[] {
  return [msg("user", { id: `u${n}` }), msg("assistant", { id: `a${n}` })];
}

describe("isTurnStartUserMessage", () => {
  it("plain user starts a turn", () => {
    assert.equal(isTurnStartUserMessage(msg("user", { id: "x" })), true);
  });

  it("steer continuation does not", () => {
    assert.equal(
      isTurnStartUserMessage(msg("user", { id: "x", steer: true })),
      false,
    );
  });

  it("hidden retry continuation does not", () => {
    assert.equal(
      isTurnStartUserMessage(msg("user", { id: "x", retryContinuation: true })),
      false,
    );
  });

  it("non-user roles never start a turn", () => {
    assert.equal(isTurnStartUserMessage(msg("assistant")), false);
    assert.equal(isTurnStartUserMessage(msg("tool")), false);
  });
});

describe("isContextClearMessage", () => {
  it("detects only the context_clear system marker", () => {
    assert.equal(isContextClearMessage(msg("system", { clear: true })), true);
    assert.equal(isContextClearMessage(msg("user")), false);
  });
});

describe("clampTailTurns", () => {
  it("defaults, floors, and caps", () => {
    assert.equal(clampTailTurns(undefined), DEFAULT_TAIL_TURNS);
    assert.equal(clampTailTurns(0), 1);
    assert.equal(clampTailTurns(3.9), 3);
    assert.equal(clampTailTurns(9999), 50);
  });
});

describe("sliceSessionTailWindow", () => {
  it("returns last N turns and reports the remainder", () => {
    const messages = [
      ...userTurn(1),
      ...userTurn(2),
      ...userTurn(3),
      ...userTurn(4),
    ];
    const win = sliceSessionTailWindow(messages, 2);
    assert.deepEqual(
      win.messages.map((m) => m.id),
      ["u3", "a3", "u4", "a4"],
    );
    assert.equal(win.firstMessageId, "u3");
    assert.equal(win.hasMore, true);
    assert.equal(win.remainingTurns, 2);
  });

  it("includes everything when the session fits", () => {
    const messages = [...userTurn(1), ...userTurn(2)];
    const win = sliceSessionTailWindow(messages, 5);
    assert.equal(win.messages.length, messages.length);
    assert.equal(win.hasMore, false);
    assert.equal(win.remainingTurns, 0);
  });

  it("steer continuations ride inside the open turn", () => {
    const messages = [
      ...userTurn(1),
      ...userTurn(2),
      msg("user", { id: "s1", steer: true }),
      msg("assistant", { id: "sa1" }),
    ];
    const win = sliceSessionTailWindow(messages, 1);
    assert.deepEqual(
      win.messages.map((m) => m.id),
      ["u2", "a2", "s1", "sa1"],
    );
    assert.equal(win.hasMore, true);
    assert.equal(win.remainingTurns, 1);
  });

  it("/clear marker is the floor and rides the window when visible range fits", () => {
    const messages = [
      ...userTurn(1),
      msg("system", { id: "clear", clear: true }),
      ...userTurn(2),
    ];
    const win = sliceSessionTailWindow(messages, 5);
    assert.deepEqual(
      win.messages.map((m) => m.id),
      ["clear", "u2", "a2"],
    );
    assert.equal(win.hasMore, false);
  });

  it("/clear bounds hasMore even when turns exceed the window", () => {
    const messages = [
      ...userTurn(1),
      ...userTurn(2),
      msg("system", { id: "clear", clear: true }),
      ...userTurn(3),
      ...userTurn(4),
      ...userTurn(5),
    ];
    const win = sliceSessionTailWindow(messages, 2);
    assert.deepEqual(
      win.messages.map((m) => m.id),
      ["u4", "a4", "u5", "a5"],
    );
    assert.equal(win.hasMore, true);
    assert.equal(win.remainingTurns, 1);
  });

  it("empty session yields an empty window", () => {
    const win = sliceSessionTailWindow([], 5);
    assert.deepEqual(win.messages, []);
    assert.equal(win.firstMessageId, null);
    assert.equal(win.hasMore, false);
  });
});

describe("sliceSessionWindowBefore", () => {
  function sixTurns(): Message[] {
    return [1, 2, 3, 4, 5, 6].flatMap(userTurn);
  }

  it("pages older turns before the cursor", () => {
    const messages = sixTurns();
    const tail = sliceSessionTailWindow(messages, 2);
    assert.equal(tail.firstMessageId, "u5");
    const page = sliceSessionWindowBefore(messages, tail.firstMessageId!, 2)!;
    assert.deepEqual(
      page.messages.map((m) => m.id),
      ["u3", "a3", "u4", "a4"],
    );
    assert.equal(page.hasMore, true);
    assert.equal(page.remainingTurns, 2);
    assert.equal(page.firstMessageId, "u3");

    const last = sliceSessionWindowBefore(messages, page.firstMessageId!, 2)!;
    assert.deepEqual(
      last.messages.map((m) => m.id),
      ["u1", "a1", "u2", "a2"],
    );
    assert.equal(last.hasMore, false);
  });

  it("final page includes the /clear marker exactly once", () => {
    const messages = [
      ...userTurn(1),
      msg("system", { id: "clear", clear: true }),
      ...userTurn(2),
      ...userTurn(3),
    ];
    const tail = sliceSessionTailWindow(messages, 1);
    assert.equal(tail.firstMessageId, "u3");
    const page = sliceSessionWindowBefore(messages, tail.firstMessageId!, 1)!;
    // Turn 2 above fits in one page; marker included as the floor.
    assert.deepEqual(
      page.messages.map((m) => m.id),
      ["clear", "u2", "a2"],
    );
    assert.equal(page.hasMore, false);
  });

  it("pre-clear history never leaks into pages", () => {
    const messages = [
      ...userTurn(1),
      msg("system", { id: "clear", clear: true }),
      ...userTurn(2),
      ...userTurn(3),
      ...userTurn(4),
    ];
    const tail = sliceSessionTailWindow(messages, 1);
    const page = sliceSessionWindowBefore(messages, tail.firstMessageId!, 1)!;
    const last = sliceSessionWindowBefore(messages, page.firstMessageId!, 5)!;
    assert.deepEqual(
      last.messages.map((m) => m.id),
      ["clear", "u2", "a2"],
    );
    // Nothing above the marker: u1/a1 stay dead.
    const empty = sliceSessionWindowBefore(messages, last.firstMessageId!, 5)!;
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.hasMore, false);
  });

  it("unknown cursor id returns null (stale window signal)", () => {
    const messages = sixTurns();
    assert.equal(sliceSessionWindowBefore(messages, "nope", 2), null);
  });

  it("cursor at index 0 returns an empty window", () => {
    const messages = sixTurns();
    const empty = sliceSessionWindowBefore(messages, messages[0]!.id, 2)!;
    assert.deepEqual(empty.messages, []);
    assert.equal(empty.hasMore, false);
  });

  it("walking to the very top terminates", () => {
    const messages = sixTurns();
    let cursor: string | null = sliceSessionTailWindow(messages, 2)
      .firstMessageId;
    let pages = 0;
    while (cursor) {
      const page = sliceSessionWindowBefore(messages, cursor, 2);
      if (!page) break;
      pages += 1;
      assert.ok(pages < 10, "paging must terminate");
      cursor = page.hasMore ? page.firstMessageId : null;
    }
    assert.equal(pages, 2);
  });
});
