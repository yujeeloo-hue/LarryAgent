import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { Session, ToolCallPart, ToolResultPart } from "../session/types.js";
import { upsertTool } from "../tools/registry.js";
import type { PermissionGateState } from "../tools/types.js";
import { runTools } from "./runTools.js";

const PROBE_TOOL = "receipt_probe";
let dataRoot = "";
let sawFlag: boolean | undefined;

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "tool-receipt-"));
  configureUserMemoryRoot(dataRoot);
  upsertTool({
    name: PROBE_TOOL,
    description: "Returns a structured receipt when the FSM asks for one",
    parameters: { type: "object", properties: {} },
    defaultPermissionLevel: 0,
  }, async (_args, context) => {
    sawFlag = context.shellStructuredReceipt;
    return {
      returnCode: ToolReturnCode.Success,
      content: [{ type: "text", text: "visible" }],
      ...(context.shellStructuredReceipt ? { receipt: { exitCode: 0 } } : {}),
    };
  });
});

after(async () => { await rm(dataRoot, { recursive: true, force: true }); });

async function invoke(extra?: Record<string, unknown>) {
  const call: ToolCallPart = {
    type: "tool_call", id: "call-receipt", name: PROBE_TOOL,
    arguments: {}, argumentsRaw: "{}", status: "pending",
  };
  const session = {
    id: "tool-receipt", type: "agent", workspacePath: dataRoot,
    messages: [{ id: "assistant", role: "assistant", createdAt: Date.now(), parts: [call] }],
  } as Session;
  let id = 0;
  const result = await runTools({
    session, assistantMessageId: "assistant", toolCalls: [call],
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `result-${++id}`,
    ...(extra ? { toolContextExtra: extra } : {}),
  });
  const toolResult = session.messages
    .flatMap((m) => (m.role === "tool" ? m.parts : []))
    .find((p): p is ToolResultPart => p.type === "tool_result")!;
  return { result, toolResult };
}

describe("runTools structured receipts", () => {
  it("forwards the FSM flag and returns the receipt to the caller only", async () => {
    const { result, toolResult } = await invoke({ shellStructuredReceipt: true });
    assert.equal(sawFlag, true);
    assert.deepEqual(result.receipts, [{
      toolCallId: "call-receipt",
      name: PROBE_TOOL,
      returnCode: ToolReturnCode.Success,
      receipt: { exitCode: 0 },
    }]);
    // Persisted / model-facing result never carries the receipt.
    assert.equal("receipt" in toolResult, false);
    assert.doesNotMatch(JSON.stringify(toolResult), /exitCode/);
  });

  it("omits the flag and receipt by default", async () => {
    const { result } = await invoke();
    assert.equal(sawFlag, undefined);
    assert.deepEqual(result.receipts, [{
      toolCallId: "call-receipt",
      name: PROBE_TOOL,
      returnCode: ToolReturnCode.Success,
    }]);
  });
});
