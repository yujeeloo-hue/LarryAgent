import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Message, MessagePart } from "../../session/types.js";
import { decideEmptyAssistant } from "./emptyAssistant.js";

let seq = 0;
function user(text: string): Message {
  return { id: `u${++seq}`, role: "user", createdAt: seq, parts: [{ type: "text", text }] };
}
function assistant(parts: MessagePart[]): AssistantMessage {
  return { id: `a${++seq}`, role: "assistant", createdAt: seq, parts };
}
const routeCall: MessagePart = {
  type: "tool_call",
  id: "call_route",
  name: "fsm_route",
  status: "done",
  arguments: { route: "done" },
  argumentsRaw: "{\"route\":\"done\"}",
};

describe("decideEmptyAssistant", () => {
  it("keeps a reflector closing round when the turn already answered", () => {
    const last = assistant([{ type: "reasoning", text: "" }, routeCall]);
    const messages = [user("fix it"), assistant([{ type: "text", text: "Done." }]), last];
    assert.equal(decideEmptyAssistant({ messages, assistant: last, reasoningText: "route done" }), "keep");
  });

  it("surfaces reasoning when the turn has no visible reply", () => {
    const last = assistant([]);
    const messages = [user("hi"), last];
    assert.equal(decideEmptyAssistant({ messages, assistant: last, reasoningText: "thinking" }), "surface_reasoning");
  });

  it("ignores replies from before the latest user message", () => {
    const last = assistant([]);
    const messages = [user("a"), assistant([{ type: "text", text: "old" }]), user("b"), last];
    assert.equal(decideEmptyAssistant({ messages, assistant: last, reasoningText: "thinking" }), "surface_reasoning");
  });

  it("never drops a tool-call round without reasoning", () => {
    const last = assistant([routeCall]);
    assert.equal(decideEmptyAssistant({ messages: [user("x"), last], assistant: last, reasoningText: "" }), "keep");
  });

  it("drops a fully empty round", () => {
    const last = assistant([]);
    assert.equal(decideEmptyAssistant({ messages: [user("x"), last], assistant: last, reasoningText: "  " }), "drop");
  });
});
