import assert from "node:assert/strict";
import { test } from "node:test";
import { shownTurnStarts, textOnlyMessages } from "./textOnlyMessages.js";
import { splitMessagesIntoTurns } from "./turnModifiedFiles.js";

test("hide only marked automatic reasoning and its context tools; keep normal failed tools", () => {
  const messages = [
    { id:"normal", role:"assistant", parts:[{type:"reasoning",text:"Keep this"},{type:"tool_call",id:"patch",name:"patch",status:"error"}] },
    { id:"normal-result", role:"tool", parts:[{type:"tool_result",toolCallId:"patch",returnCode:1}] },
    { id:"auto", role:"assistant", parts:[{type:"reasoning",text:"Internal"},{type:"tool_call",id:"context",name:"coco_context"},{type:"text",text:"Progress update"}] },
    { id:"auto-result", role:"tool", parts:[{type:"tool_result",toolCallId:"context",returnCode:0}] },
    { id:"auto-thinking-only", role:"assistant", parts:[{type:"reasoning",text:"No speech"}] },
  ];
  const result = textOnlyMessages(messages, new Set(["auto","auto-thinking-only"]));
  assert.deepEqual(result.map(m => m.id), ["normal","normal-result","auto"]);
  assert.equal(result[0], messages[0]); assert.equal(result[1], messages[1]);
  assert.deepEqual(result[2]!.parts, [{type:"text",text:"Progress update"}]);
  assert.equal(messages[2]!.parts.length, 3);
});

test("a prompt-less turn splits from the previous prompt, also when its first round is hidden", () => {
  const messages = [
    { id:"u1", role:"user", parts:[{type:"text",text:"hello"}] },
    { id:"a1", role:"assistant", parts:[{type:"text",text:"hi"}] },
    { id:"auto-1", role:"assistant", parts:[{type:"reasoning",text:"check"}] },
    { id:"auto-2", role:"assistant", parts:[{type:"text",text:"No news."}] },
    { id:"u2", role:"user", parts:[{type:"text",text:"thanks"}] },
  ];
  assert.deepEqual(splitMessagesIntoTurns(messages).map(t => t.map(m => m.id)), [["u1","a1","auto-1","auto-2"],["u2"]]);
  assert.deepEqual(
    splitMessagesIntoTurns(messages, new Set(["auto-1"])).map(t => t.map(m => m.id)),
    [["u1","a1"],["auto-1","auto-2"],["u2"]],
  );
  const shown = textOnlyMessages(messages, new Set(["auto-1","auto-2"]));
  const starts = shownTurnStarts(messages, shown, new Set(["auto-1"]));
  assert.deepEqual([...starts], ["auto-2"]);
  assert.deepEqual(splitMessagesIntoTurns(shown, starts).map(t => t.map(m => m.id)), [["u1","a1"],["auto-2"],["u2"]]);
  assert.deepEqual([...shownTurnStarts(messages, messages.filter(m => !m.id.startsWith("auto")), new Set(["auto-1"]))], [], "a turn that shows nothing has no start");
});
