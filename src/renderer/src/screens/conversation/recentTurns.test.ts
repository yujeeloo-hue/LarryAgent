import assert from "node:assert/strict";
import test from "node:test";
import { recentTurnMessages } from "./recentTurns.js";

const HOUR = 60 * 60 * 1000;
const now = 10 * HOUR;
const msg = (id: string, role: string, createdAt: number) => ({ id, role, createdAt, parts: [{ type: "text", text: id }] });

test("keeps whole turns with activity inside the window", () => {
  const messages = [
    msg("u1", "user", now - 3 * HOUR),
    msg("a1", "assistant", now - 3 * HOUR + 1),
    msg("u2", "user", now - HOUR - 60_000),
    msg("a2", "assistant", now - 30 * 60_000),
    msg("u3", "user", now - 5 * 60_000),
    msg("a3", "assistant", now - 4 * 60_000),
  ];
  const result = recentTurnMessages(messages, now - HOUR);
  assert.deepEqual(result.messages.map((m) => m.id), ["u2", "a2", "u3", "a3"]);
  assert.equal(result.trimmed, true);
});

test("returns the transcript unchanged when every turn is recent", () => {
  const messages = [msg("u1", "user", now - 10_000), msg("a1", "assistant", now - 5_000)];
  const result = recentTurnMessages(messages, now - HOUR);
  assert.equal(result.messages, messages);
  assert.equal(result.trimmed, false);
});

test("hides everything when nothing happened in the window", () => {
  const messages = [msg("u1", "user", now - 2 * HOUR), msg("a1", "assistant", now - 2 * HOUR)];
  const result = recentTurnMessages(messages, now - HOUR);
  assert.deepEqual(result.messages, []);
  assert.equal(result.trimmed, true);
});

test("prompt-less turns split on turn start ids", () => {
  const messages = [
    msg("u1", "user", now - 2 * HOUR),
    msg("a1", "assistant", now - 2 * HOUR),
    msg("wake", "assistant", now - 10 * 60_000),
  ];
  const result = recentTurnMessages(messages, now - HOUR, new Set(["wake"]));
  assert.deepEqual(result.messages.map((m) => m.id), ["wake"]);
});
