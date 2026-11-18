import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "../session/types.js";
import { buildVerifyInput } from "./cocoVerifyInput.js";
import type { CocoWorkResult } from "../coco/types.js";

const user = (id: string, text: string): Message => ({ id, role: "user", createdAt: 0, parts: [{ type: "text", text }] });
const assistant = (id: string, parts: Message["parts"]): Message => ({ id, role: "assistant", createdAt: 0, parts });

test("verification review is plain text and drops thinking and tools", () => {
  const messages: Message[] = [
    user("prompt", "Keep the implementation small"),
    assistant("reply", [
      { type: "reasoning", text: "hidden chain of thought" },
      { type: "text", text: "I will reuse the existing parser." },
      { type: "tool_call", id: "call", name: "read_file", status: "done", arguments: {}, argumentsRaw: "{}" },
    ]),
    { id: "result", role: "tool", createdAt: 0, toolCallId: "call", parts: [{ type: "tool_result", toolCallId: "call", returnCode: 0, content: [{ type: "text", text: "secret tool output" }] }] },
  ];
  const text = buildVerifyInput({
    objective: "Add a short project summary",
    steps: ["Read the README"],
    acceptance: [{ id: "summary", description: "README opens with a summary", kind: "review" }],
  }, messages);
  assert.equal(text.startsWith("{"), false);
  assert.match(text, /^Add a short project summary\n\nSteps:\nRead the README\n\nAcceptance criteria:\nREADME opens with a summary\n\nConversation:\n\nUser:\nKeep the implementation small\n\nAssistant:\nI will reuse the existing parser\.$/);
  assert.equal(text.includes("hidden chain of thought"), false);
  assert.equal(text.includes("secret tool output"), false);
});

test("verification reads the latest saved content of each report instead of an earlier draft", () => {
  const report: CocoWorkResult = {id:"old",workId:"work",revision:1,at:1,capturedAt:1,title:"Weekly findings",markdown:"Outdated draft",source:"report",path:"/project/report.md"};
  const text=buildVerifyInput({objective:"Deliver the report",steps:[],acceptance:[]},[],[report,{...report,id:"latest",at:2,capturedAt:2,markdown:"Final concrete findings"}]);
  assert.match(text,/Saved task reports/); assert.match(text,/Final concrete findings/);
  assert.equal(text.includes("Outdated draft"),false);
});
