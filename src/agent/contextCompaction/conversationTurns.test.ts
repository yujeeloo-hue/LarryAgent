import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../../session/types.js";
import { recentConversationTurns } from "./conversationTurns.js";

const msg = (id: string, role: Message["role"], extra: Partial<Message> = {}): Message =>
  ({ id, role, createdAt: 0, parts: [{ type: "text", text: id }], ...extra }) as Message;
const marker = (id: string): Message =>
  ({ id, role: "system", createdAt: 0, parts: [{ type: "context_compaction", id, summary: "s", fromMessageId: "u1", toMessageId: "a1", usedTokensBefore: 0, usedTokensAfter: 0 }] }) as Message;

test("recentConversationTurns keeps the newest N user Turns and drops compaction markers", () => {
  const messages = [msg("u1", "user"), msg("a1", "assistant"), marker("m"), msg("u2", "user"), msg("a2", "assistant"), msg("u3", "user"), msg("a3", "assistant"), msg("a3b", "assistant")];
  assert.deepEqual(recentConversationTurns(messages, 2).map(m => m.id), ["u2", "a2", "u3", "a3", "a3b"]);
  assert.equal(recentConversationTurns(messages, 3), messages, "no older Turn to drop");
  assert.equal(recentConversationTurns(messages, 5), messages);
});

test("recentConversationTurns counts prompt-less Turn starts", () => {
  const messages = [msg("u1", "user"), msg("a1", "assistant"), msg("w1", "assistant"), msg("t1", "tool"), msg("w2", "assistant"), marker("m"), msg("w3", "assistant"), msg("w3b", "assistant")];
  const starts = new Set(["w1", "w2", "w3"]);
  assert.deepEqual(recentConversationTurns(messages, 2, starts).map(m => m.id), ["w2", "w3", "w3b"]);
  assert.equal(recentConversationTurns(messages, 2), messages, "without starts there is a single user Turn");
  assert.equal(recentConversationTurns(messages, 4, starts), messages);
});
