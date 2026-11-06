import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../session/types.js";
import { buildDecisionInput, parseDecision } from "./cocoDecide.js";

const user = (id: string, text: string): Message => ({ id, role: "user", createdAt: 0, parts: [{ type: "text", text }] });
const assistant = (id: string, parts: Message["parts"]): Message => ({ id, role: "assistant", createdAt: 0, parts });

test("decision dialogue keeps user prompts and assistant replies, and drops thinking and tools", () => {
  const messages: Message[] = [
    user("old-user", "Old prompt that the summary replaces"),
    assistant("old-assistant", [{ type: "text", text: "Old reply" }]),
    {
      id: "marker", role: "system", createdAt: 0, parts: [{
        type: "context_compaction", id: "compact", summary: "Earlier the session chose the small parser.",
        fromMessageId: "old-user", toMessageId: "old-assistant", coveredThroughMessageId: "old-assistant",
        usedTokensBefore: 1, usedTokensAfter: 1,
      }],
    },
    user("prompt", "Keep the implementation small"),
    assistant("reply", [
      { type: "reasoning", text: "hidden chain of thought" },
      { type: "text", text: "I will reuse the existing parser." },
      { type: "tool_call", id: "call", name: "read_file", status: "done", arguments: {}, argumentsRaw: JSON.stringify({ path: "x".repeat(5000) }) },
    ]),
    { id: "result", role: "tool", createdAt: 0, toolCallId: "call", parts: [{ type: "tool_result", toolCallId: "call", returnCode: 0, content: [{ type: "text", text: "z".repeat(50000) }] }] },
    { id: "note", role: "system", createdAt: 0, parts: [{ type: "text", text: "Continuing after a pause." }] },
  ];
  const input = buildDecisionInput({ question: "Which parser?", options: ["A", "B"], allowCustom: false, sessionId: "s1" }, messages);
  const encoded = JSON.stringify(input);
  assert.equal(input.summary, "Earlier the session chose the small parser.");
  assert.deepEqual(input.dialogue, [
    { role: "user", text: "Keep the implementation small" },
    { role: "assistant", text: "I will reuse the existing parser." },
  ]);
  assert.deepEqual((input.question as { options: string[] }).options, ["A", "B"]);
  assert.equal((input.question as { allowCustom: boolean }).allowCustom, false);
  assert.equal("work" in input, false);
  assert.equal("priorDecisions" in input, false);
  assert.equal(encoded.includes("Old prompt"), false);
  assert.equal(encoded.includes("hidden chain of thought"), false);
  assert.equal(encoded.includes("read_file"), false);
  assert.equal(encoded.includes("z".repeat(20)), false);
  assert.equal(encoded.includes("Continuing after a pause"), false);
});

test("a live turn keeps its user prompt when the summary cursor sits on a later tool call", () => {
  const messages: Message[] = [
    user("prompt", "Add keyboard navigation"),
    assistant("tools-only", [{ type: "tool_call", id: "call", name: "grep", status: "done", arguments: {}, argumentsRaw: "{}" }]),
    { id: "result", role: "tool", createdAt: 0, toolCallId: "call", parts: [{ type: "tool_result", toolCallId: "call", returnCode: 0, content: [{ type: "text", text: "secret tool output" }] }] },
    assistant("reply", [{ type: "text", text: "Navigation is in place." }]),
    {
      id: "marker", role: "system", createdAt: 1, parts: [{
        type: "context_compaction", id: "compact", summary: "Work is underway.",
        fromMessageId: "prompt", toMessageId: "tools-only", coveredThroughMessageId: "tools-only",
        usedTokensBefore: 1, usedTokensAfter: 1,
      }],
    },
  ];
  const input = buildDecisionInput({ question: "Ship it?", options: [] }, messages);
  assert.deepEqual(input.dialogue, [
    { role: "user", text: "Add keyboard navigation" },
    { role: "assistant", text: "Navigation is in place." },
  ]);
  assert.equal(JSON.stringify(input).includes("secret tool output"), false);
});

test("decision replies parse with or without fences and reject prose", () => {
  assert.deepEqual(parseDecision('```json\n{"action":"answer","answer":"A","reason":"r"}\n```'), { action: "answer", answer: "A", reason: "r" });
  assert.equal(parseDecision("Use option A.")?.action, undefined);
  assert.equal(parseDecision('Sure: {"action":"needs_user","reason":"secret"}')?.action, "needs_user");
});
