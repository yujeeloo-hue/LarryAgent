import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AssistantMessage, Session, ToolCallPart, ToolMessage } from "../session/types.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { sealOrphanToolCallsInSession, sealToolCallsWithCancelledResults } from "./sealOrphanToolCalls.js";

function call(id: string, status: ToolCallPart["status"] = "pending"): ToolCallPart {
  return { type: "tool_call", id, name: "write_file", status, arguments: {}, argumentsRaw: "{}" };
}
function assistant(id: string, calls: ToolCallPart[]): AssistantMessage {
  return { id, role: "assistant", createdAt: 1, parts: calls };
}
function result(id: string): ToolMessage {
  return { id: `result-${id}`, role: "tool", toolCallId: id, createdAt: 1, parts: [{
    type: "tool_result", toolCallId: id, returnCode: 0, content: [],
  }] };
}
const session = (messages: Session["messages"]): Session => ({ id: "s", messages } as Session);

describe("interrupted tool recovery", () => {
  it("seals a duplicated call id only once and uses the recorded execution state", () => {
    const started = call("same", "running");
    const state = session([assistant("owner", [started, call("same", "running")])]);
    assert.equal(sealToolCallsWithCancelledResults(state, () => "recovery", [call("same")], "Not started", "owner").length, 1);
    const result = state.messages[1]!.parts[0]!;
    assert.equal(result.type === "tool_result" && result.returnCode, ToolReturnCode.GenericFailure);
    assert.equal(started.status, "error");
    const duplicates = session([assistant("owner", [call("duplicate"), call("duplicate")])]);
    assert.equal(sealOrphanToolCallsInSession(duplicates, () => "single"), 1);
    assert.equal(duplicates.messages.length, 2);
  });
  it("does not mistake an earlier assistant's reused call id for this call's result", () => {
    const interrupted = call("same", "running");
    const state = session([assistant("old", [call("same", "done")]), result("same"), assistant("new", [interrupted])]);
    assert.equal(sealOrphanToolCallsInSession(state, () => "recovery"), 1);
    const part = state.messages.at(-1)!.parts[0]!;
    assert.equal(part.type === "tool_result" && part.returnCode, ToolReturnCode.GenericFailure);
    assert.match(part.type === "tool_result" ? JSON.stringify(part.content) : "", /outcome is unknown.*not automatically retried/i);
    assert.equal(interrupted.status, "error");
    assert.equal(sealOrphanToolCallsInSession(state, () => "duplicate"), 0);
  });

  it("keeps known-unstarted calls distinct from outcome-unknown calls", () => {
    const state = session([assistant("owner", [call("pending"), call("started", "running")])]);
    assert.equal(sealOrphanToolCallsInSession(state, () => Math.random().toString()), 2);
    const results = state.messages.flatMap((message) => message.parts).filter((part) => part.type === "tool_result");
    assert.deepEqual(results.map((part) => part.returnCode), [ToolReturnCode.Cancelled, ToolReturnCode.GenericFailure]);
  });

  it("preserves only pending calls in an explicitly resumed batch", () => {
    const state = session([assistant("owner", [call("pending"), call("started", "running")])]);
    assert.equal(sealOrphanToolCallsInSession(state, () => "recovery", {
      resumeToolBatch: { assistantMessageId: "owner", toolCallIds: ["pending", "started"] },
    }), 1);
    const pending = state.messages[0]!.parts[0]!;
    assert.equal(pending.type === "tool_call" && pending.status, "pending");
  });

  it("scopes cancellation result lookup and insertion to the supplied assistant", () => {
    const pending = call("same");
    const state = session([assistant("old", [call("same", "done")]), result("same"), assistant("new", [pending])]);
    assert.equal(sealToolCallsWithCancelledResults(state, () => "cancel", [pending], "Not executed", "new").length, 1);
    const part = state.messages.at(-1)!.parts[0]!;
    assert.equal(part.type === "tool_result" && part.returnCode, ToolReturnCode.Cancelled);
  });
});
