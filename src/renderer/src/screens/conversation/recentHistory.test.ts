import assert from "node:assert/strict";
import { test } from "node:test";
import { recentMessages, recentSessionTail } from "./recentHistory.js";

test("the hour is only a display filter, with an inclusive boundary and no source mutation", () => {
  const messages = [{ id: "old", createdAt: 99 }, { id: "boundary", createdAt: 100 }, { id: "new", createdAt: 101 }];
  assert.deepEqual(recentMessages(messages, 100).map(m => m.id), ["boundary", "new"]);
  assert.equal(messages.length, 3); assert.equal(recentMessages(messages), messages);
});

test("load all recent pages and stop at the hour instead of exposing a load-older button", async () => {
  const msg = (id: string, createdAt: number) => ({ id, role: "assistant", createdAt, parts: [{ type: "text", text: id }] });
  const original = { session: { messages: [msg("latest", 300)] }, window: { hasMore: true, firstMessageId: "latest", remainingTurns: 3 } };
  const cursors: string[] = [];
  const bridge = {
    getSessionTail: async () => original,
    getMessagesBefore: async (_id: string, cursor: string) => {
      cursors.push(cursor);
      return cursor === "latest" ? { messages: [msg("middle", 200)], hasMore: true, firstMessageId: "middle", remainingTurns: 2 }
        : { messages: [msg("old", 50), msg("boundary", 100)], hasMore: true, firstMessageId: "old", remainingTurns: 1 };
    },
  };
  const tail = await recentSessionTail(bridge as any, "chat", 100);
  assert.deepEqual(tail?.session.messages.map(m => m.id), ["boundary", "middle", "latest"]);
  assert.deepEqual(cursors, ["latest", "middle"]); assert.equal(tail?.window.hasMore, false);
  assert.equal(original.session.messages.length, 1); assert.equal(original.window.hasMore, true);
});

test("all-old history is empty while the saved session remains available", async () => {
  let pages = 0;
  const tail = await recentSessionTail({ getSessionTail: async () => ({ session: { id: "chat", messages: [{ id: "old", createdAt: 1 }] }, window: { hasMore: true, firstMessageId: "old" } }), getMessagesBefore: async () => { pages++; } } as any, "chat", 100);
  assert.equal(tail?.session.id, "chat"); assert.deepEqual(tail?.session.messages, []); assert.equal(pages, 0);
});
