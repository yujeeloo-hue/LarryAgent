import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configureUserMemoryRoot } from "../memory/store.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { Session, ToolCallPart } from "../session/types.js";
import { upsertTool } from "../tools/registry.js";
import type { PermissionGateState, ToolHandler } from "../tools/types.js";
import { runTools } from "./runTools.js";

let dataRoot = "";
before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "tool-interrupt-"));
  configureUserMemoryRoot(dataRoot);
});
after(async () => { await rm(dataRoot, { recursive: true, force: true }); });

function register(name: string, execute: ToolHandler, permission: 0 | 2 = 0) {
  upsertTool({ name, description: name, parameters: { type: "object" },
    defaultPermissionLevel: permission }, execute);
}

function batch(names: string[], interrupt: AbortController, gate?: PermissionGateState) {
  const calls: ToolCallPart[] = names.map((name, index) => ({
    type: "tool_call", id: `call-${index}`, name, arguments: {},
    argumentsRaw: "{}", status: "pending",
  }));
  const session = {
    id: "tool-interrupt", type: "agent", workspacePath: dataRoot,
    messages: [{ id: "assistant", role: "assistant", createdAt: Date.now(), parts: calls }],
  } as Session;
  let id = 0;
  return { session, calls, run: () => runTools({
    session, assistantMessageId: "assistant", toolCalls: calls,
    gate: gate ?? { fullPermissionsEnabled: true } as PermissionGateState,
    interruptSignal: interrupt.signal, createId: () => `result-${++id}`,
  }) };
}

const success = () => ({ returnCode: ToolReturnCode.Success,
  content: [{ type: "text" as const, text: "completed" }] });

it("finishes an active write but never starts the remaining stale writes", async () => {
  const interrupt = new AbortController();
  const executed: string[] = [];
  register("audit_write_active", async (_args, context) => {
    executed.push("active");
    interrupt.abort();
    await Promise.resolve();
    assert.equal(context.signal?.aborted, false, "an active write is protected");
    return success();
  });
  register("audit_write_pending", async () => {
    executed.push("pending");
    return success();
  });
  const input = batch(["audit_write_active", "audit_write_pending"], interrupt);
  const result = await input.run();
  assert.equal(result.cancelled, false, "interrupt does not terminate the turn");
  assert.deepEqual(executed, ["active"]);
  assert.deepEqual(input.calls.map((call) => call.status), ["done", "cancelled"]);
  assert.equal(input.session.messages.filter((message) => message.role === "tool").length, 2,
    "every model tool call has exactly one result before the next user message");
});

it("does not execute a stale write after an outstanding permission is answered", async () => {
  const interrupt = new AbortController();
  let executions = 0;
  register("audit_write_permission", async () => { executions++; return success(); }, 2);
  const input = batch(["audit_write_permission"], interrupt, {
    fullPermissionsEnabled: false,
    enableFullPermissions() {},
    requestUserAsk: async () => null,
    requestConfirmation: async () => { interrupt.abort(); return true; },
  });
  await input.run();
  assert.equal(executions, 0);
  assert.equal(input.calls[0]?.status, "cancelled");
});

it("seals an interruptible handler AbortError as cancellation and skips later tools", async () => {
  const interrupt = new AbortController();
  register("read_file", async (_args, context) => {
    interrupt.abort();
    assert.equal(context.signal?.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  });
  let writes = 0;
  register("audit_write_after_read", async () => { writes++; return success(); });
  const input = batch(["read_file", "audit_write_after_read"], interrupt);
  const result = await input.run();
  assert.equal(result.cancelled, false);
  assert.equal(writes, 0);
  assert.deepEqual(input.calls.map((call) => call.status), ["cancelled", "cancelled"]);
  assert.equal(result.toolFailureCount, 0, "deliberate cancellation is not a tool failure");
});

it("interrupting the last tool in a batch does not count as a tool failure", async () => {
  const interrupt = new AbortController();
  register("read_file", async () => {
    interrupt.abort();
    return { returnCode: ToolReturnCode.Cancelled, content: [] };
  });
  const input = batch(["read_file"], interrupt);
  const result = await input.run();
  assert.equal(result.cancelled, false);
  assert.equal(result.toolFailureCount, 0);
  assert.equal(input.calls[0]?.status, "cancelled");
});
