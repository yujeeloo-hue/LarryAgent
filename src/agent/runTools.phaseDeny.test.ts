import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { JsonObject, Session, ToolCallPart, ToolResultPart } from "../session/types.js";
import { upsertTool } from "../tools/registry.js";
import type { PermissionGateState } from "../tools/types.js";
import { runTools } from "./runTools.js";

const PROBE_TOOL = "phase_deny_probe";
let dataRoot = "";
let executions = 0;

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "tool-phase-deny-"));
  configureUserMemoryRoot(dataRoot);
  upsertTool({
    name: PROBE_TOOL,
    description: "In-memory execution counter for phase-deny tests",
    parameters: { type: "object", properties: {} },
    defaultPermissionLevel: 0,
  }, async () => {
    executions += 1;
    return { returnCode: ToolReturnCode.Success, content: [] };
  });
});

after(async () => { await rm(dataRoot, { recursive: true, force: true }); });

async function invoke(input: {
  bridged?: boolean;
  deny?: string[];
  allow?: string[];
}) {
  const args: JsonObject = input.bridged ? { name: PROBE_TOOL, arguments: {} } : {};
  const call: ToolCallPart = {
    type: "tool_call", id: "call-probe", name: input.bridged ? "tool_call" : PROBE_TOOL,
    arguments: args, argumentsRaw: JSON.stringify(args), status: "pending",
  };
  const session = {
    id: "tool-phase-deny", type: "agent", workspacePath: dataRoot,
    messages: [{ id: "assistant", role: "assistant", createdAt: Date.now(), parts: [call] }],
  } as Session;
  const beforeExecutions = executions;
  let id = 0;
  const result = await runTools({
    session, assistantMessageId: "assistant", toolCalls: [call],
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `result-${++id}`,
    ...(input.deny ? { phaseDisabledTools: input.deny } : {}),
    ...(input.allow ? { allowedTools: input.allow } : {}),
  });
  const parts = session.messages.flatMap((message) => message.role === "tool" ? message.parts : []);
  const toolResults = parts.filter((part): part is ToolResultPart => part.type === "tool_result");
  assert.equal(result.cancelled, false);
  assert.equal(toolResults.length, 1, "every model call receives exactly one result");
  return { call, result, toolResult: toolResults[0]!, executions: executions - beforeExecutions };
}

function assertPhaseDenied(out: Awaited<ReturnType<typeof invoke>>) {
  assert.equal(out.executions, 0, "denied tools must never reach their handler");
  assert.equal(out.call.status, "error");
  assert.equal(out.toolResult.returnCode, ToolReturnCode.PermissionDenied);
  assert.equal(out.result.toolFailureCount, 1);
  assert.match(JSON.stringify(out.toolResult.content), /not available in the current phase/);
}

describe("runTools phase-deny enforcement", () => {
  it("rejects a stale direct call to a hidden tool", async () => {
    assertPhaseDenied(await invoke({ deny: [PROBE_TOOL] }));
  });

  it("rejects a bridge call when its underlying tool is disabled", async () => {
    assertPhaseDenied(await invoke({ bridged: true, deny: [PROBE_TOOL] }));
  });

  it("rejects a bridge call when the tool_call meta tool is disabled", async () => {
    assertPhaseDenied(await invoke({ bridged: true, deny: ["tool_call"], allow: [PROBE_TOOL] }));
  });

  it("enforces deny globs on direct, underlying and meta tool names", async () => {
    for (const input of [
      { deny: ["phase_deny_*"] },
      { bridged: true, deny: ["PHASE_DENY_*"] },
      { bridged: true, deny: ["tool_*"] },
    ]) {
      assertPhaseDenied(await invoke(input));
    }
  });

  it("keeps exact deny matching case-sensitive and accepts unrelated deny entries", async () => {
    for (const deny of [[PROBE_TOOL.toUpperCase()], ["phase_deny_other"], []]) {
      const out = await invoke({ deny });
      assert.equal(out.executions, 1);
      assert.equal(out.toolResult.returnCode, ToolReturnCode.Success);
    }
  });

  it("applies allowlists to underlying names without requiring meta tool permission", async () => {
    const allowed = await invoke({ bridged: true, allow: [PROBE_TOOL] });
    assert.equal(allowed.executions, 1);
    assert.equal(allowed.toolResult.returnCode, ToolReturnCode.Success);

    const denied = await invoke({ bridged: true, allow: ["phase_deny_other"] });
    assert.equal(denied.executions, 0);
    assert.equal(denied.toolResult.returnCode, ToolReturnCode.PermissionDenied);
    assert.match(JSON.stringify(denied.toolResult.content), /not on the current allowlist/);
  });
});
