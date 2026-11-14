import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import { toolCallsByIds } from "../session/pendingUserAsk.js";
import type { AssistantMessage, Session, ToolCallPart, ToolMessage, ToolResultPart } from "../session/types.js";
import { upsertTool } from "../tools/registry.js";
import type { PermissionGateState, ToolExecuteResult } from "../tools/types.js";
import type { HookRunner } from "../hooks/types.js";
import { runTools, type RunToolsInput } from "./runTools.js";

const TOOL_NAME = "execution_dedupe_probe";
let dataRoot = "";
let executions = 0;
let probeEffect: (() => void) | undefined;
let probeSessionPatch: ToolExecuteResult["sessionPatch"];

before(async () => {
  dataRoot = await mkdtemp(join(tmpdir(), "tool-dedupe-"));
  configureUserMemoryRoot(dataRoot);
  upsertTool({
    name: TOOL_NAME, description: "In-memory side-effect counter",
    parameters: { type: "object" }, defaultPermissionLevel: 0,
  }, async () => {
    executions += 1;
    probeEffect?.();
    return { returnCode: ToolReturnCode.Success, content: [{ type: "text", text: "executed" }],
      ...(probeSessionPatch ? { sessionPatch: probeSessionPatch } : {}) };
  });
});
after(async () => { await rm(dataRoot, { recursive: true, force: true }); });

function call(id = "call", status: ToolCallPart["status"] = "pending"): ToolCallPart {
  return { type: "tool_call", id, name: TOOL_NAME, status, arguments: {}, argumentsRaw: "{}" };
}

function assistant(id: string, calls: ToolCallPart[]): AssistantMessage {
  return { id, role: "assistant", createdAt: Date.now(), parts: calls };
}

function result(callId: string, returnCode: number = ToolReturnCode.Success): ToolMessage {
  return { id: `result-${callId}`, role: "tool", toolCallId: callId, createdAt: Date.now(), parts: [{
    type: "tool_result", toolCallId: callId, returnCode, content: [{ type: "text", text: "recorded" }],
  }] };
}

function fixture(calls: ToolCallPart[] = [call()]) {
  const owner = assistant("assistant", calls);
  const session = {
    id: "dedupe-session", type: "agent", workspacePath: dataRoot, messages: [owner],
  } as Session;
  let id = 0;
  const run = (input: Partial<Pick<RunToolsInput, "toolCalls" | "assistantMessageId" | "checkpoint" | "signal" | "applySessionPatch" | "hooks">> = {}) => runTools({
    session, assistantMessageId: owner.id, toolCalls: calls,
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `generated-${++id}`, ...input,
  });
  return { session, owner, run };
}

function results(session: Session): ToolResultPart[] {
  return session.messages.flatMap((message) => message.parts)
    .filter((part): part is ToolResultPart => part.type === "tool_result");
}

describe("runTools execution deduplication", () => {
  it("reuses an existing result even when its tool call still says pending", async () => {
    const input = fixture();
    input.session.messages.push(result("call"));
    const before = executions;
    await input.run();
    assert.equal(executions, before);
    assert.equal(results(input.session).length, 1);
    assert.equal(input.owner.parts[0]!.type === "tool_call" && input.owner.parts[0]!.status, "done");
  });

  it("does not execute or append a second result when the same batch is resumed twice", async () => {
    const input = fixture();
    const before = executions;
    await input.run();
    await input.run();
    assert.equal(executions - before, 1);
    assert.equal(results(input.session).length, 1);
  });

  it("executes only once for duplicate ids inside the same assistant batch", async () => {
    const calls = [call(), call()];
    const input = fixture(calls);
    const before = executions;
    await input.run();
    assert.equal(executions - before, 1);
    assert.equal(results(input.session).length, 1);
    assert.deepEqual(calls.map((item) => item.status), ["done", "done"]);
  });

  for (const status of ["running", "done", "error", "cancelled"] as const) {
    it(`does not retry a historical ${status} call whose result is missing`, async () => {
      const input = fixture([call("call", status)]);
      const before = executions;
      const outcome = await input.run();
      await input.run();
      assert.equal(executions, before);
      assert.equal(results(input.session).length, 1);
      assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.GenericFailure);
      assert.match(JSON.stringify(results(input.session)[0]!.content), /outcome.*unknown.*not retried/i);
      assert.equal(outcome.toolFailureCount, 1);
    });
  }

  it("does not let a detached pending copy retry its recorded running call", async () => {
    const input = fixture([call("call", "running")]);
    const before = executions;
    await input.run({ toolCalls: [call()] });
    assert.equal(executions, before);
    assert.match(JSON.stringify(results(input.session)[0]!.content), /unknown.*not retried/i);
  });

  it("resumes only pending siblings selected from an ask_user continuation", async () => {
    const calls = [call("done-sibling", "done"), call("pending-sibling")];
    const input = fixture(calls);
    input.session.messages.push(result("done-sibling"));
    const selected = toolCallsByIds(input.owner, ["done-sibling", "pending-sibling"]);
    const before = executions;
    await input.run({ toolCalls: selected });
    assert.equal(executions - before, 1);
    assert.equal(results(input.session).length, 2);
  });

  it("keeps a reused call id in another assistant independent, including failure counts", async () => {
    const current = call();
    const input = fixture([current]);
    input.session.messages.unshift(assistant("earlier", [call("call", "error")]),
      result("call", ToolReturnCode.GenericFailure));
    const before = executions;
    const outcome = await input.run();
    assert.equal(executions - before, 1);
    assert.equal(outcome.toolFailureCount, 0);
    assert.equal(results(input.session).length, 2);
  });

  it("does not borrow a later assistant's result for an earlier pending call", async () => {
    const input = fixture();
    input.session.messages.push(assistant("later", [call("call", "done")]), result("call"));
    const before = executions;
    await input.run();
    assert.equal(executions - before, 1);
    assert.equal(input.session.messages[1]!.role, "tool", "new result stays with its owning assistant");
    await input.run();
    assert.equal(executions - before, 1);
  });

  it("keeps identical assistant/call ids in different sessions independent", async () => {
    const first = fixture();
    const second = fixture();
    second.session.id = "other-session";
    const before = executions;
    await first.run();
    await second.run();
    assert.equal(executions - before, 2);
  });
});

describe("runTools durable execution checkpoints", () => {
  it("persists running before the handler and the result after execution", async () => {
    const input = fixture();
    const snapshots: Array<{ status: unknown; resultCount: number; executions: number }> = [];
    const before = executions;
    await input.run({ toolCalls: [structuredClone(input.owner.parts[0]) as ToolCallPart], checkpoint: () => {
      snapshots.push({ status: input.owner.parts[0]!.type === "tool_call" ? input.owner.parts[0]!.status : null,
        resultCount: results(input.session).length, executions: executions - before });
    } });
    assert.deepEqual(snapshots, [
      { status: "running", resultCount: 0, executions: 0 },
      { status: "done", resultCount: 1, executions: 1 },
    ]);
  });

  it("fails closed without executing when the running checkpoint fails", async () => {
    const input = fixture();
    const before = executions;
    const outcome = await input.run({ checkpoint: () => { throw new Error("storage unavailable"); } });
    assert.equal(executions, before);
    assert.match(outcome.persistenceError ?? "", /storage unavailable/);
    assert.equal(results(input.session).length, 1);
    assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.GenericFailure);
    assert.match(JSON.stringify(results(input.session)[0]!.content), /not executed/i);
  });

  for (const missing of ["assistant", "tool call"] as const) {
    it(`does not execute a durable call when its owning ${missing} is missing`, async () => {
      const input = fixture();
      if (missing === "assistant") input.session.messages = [];
      else input.owner.parts = [];
      const before = executions;
      const outcome = await input.run({ checkpoint: () => {} });
      assert.equal(executions, before);
      assert.match(outcome.persistenceError ?? "", /Missing owning assistant\/tool call/);
      assert.match(JSON.stringify(results(input.session)[0]!.content), /not executed/i);
    });
  }

  it("keeps the real result and stops the batch when its checkpoint fails", async () => {
    const input = fixture([call("first"), call("second")]);
    const before = executions;
    let checkpoints = 0;
    const outcome = await input.run({ checkpoint: () => {
      checkpoints += 1;
      if (checkpoints === 2) throw new Error("result save failed");
    } });
    assert.equal(executions - before, 1);
    assert.match(outcome.persistenceError ?? "", /result save failed/);
    assert.equal(results(input.session).length, 1, "persistence failure must not overwrite the real result");
    assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.Success);
    assert.equal(input.owner.parts[1]!.type === "tool_call" && input.owner.parts[1]!.status, "pending");
    await input.run({ toolCalls: [input.owner.parts[0] as ToolCallPart] });
    assert.equal(executions - before, 1, "in-memory success must not be retried");
  });

  it("does not execute when cancellation arrives while saving the running checkpoint", async () => {
    const input = fixture();
    const controller = new AbortController();
    const before = executions;
    const outcome = await input.run({ signal: controller.signal, checkpoint: () => { controller.abort(); } });
    assert.equal(outcome.cancelled, true);
    assert.equal(executions, before);
    assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.Cancelled);
  });

  it("persists the real result before cancelling remaining calls after execution", async () => {
    const input = fixture([call("first"), call("second")]);
    const controller = new AbortController();
    const before = executions;
    const snapshots: number[][] = [];
    probeEffect = () => controller.abort();
    try {
      const outcome = await input.run({ signal: controller.signal, checkpoint: () => {
        snapshots.push(results(input.session).map((part) => part.returnCode));
      } });
      assert.equal(outcome.cancelled, true);
      assert.equal(executions - before, 1);
      assert.deepEqual(snapshots, [[], [ToolReturnCode.Success], [ToolReturnCode.Success, ToolReturnCode.Cancelled]]);
      assert.deepEqual(results(input.session).map((part) => part.returnCode), [ToolReturnCode.Success, ToolReturnCode.Cancelled]);
      await input.run({ toolCalls: [input.owner.parts[0] as ToolCallPart] });
      assert.equal(executions - before, 1, "the completed operation must not run again");
    } finally {
      probeEffect = undefined;
    }
  });

  it("records an unknown outcome when an operation has side effects then throws during abort", async () => {
    const input = fixture([call("first"), call("second")]);
    const controller = new AbortController();
    const before = executions;
    probeEffect = () => { controller.abort(); throw new Error("connection lost after side effect"); };
    try {
      const outcome = await input.run({ signal: controller.signal, checkpoint: () => {} });
      assert.equal(outcome.cancelled, true);
      assert.equal(executions - before, 1);
      const first = results(input.session).find((part) => part.toolCallId === "first")!;
      assert.equal(first.returnCode, ToolReturnCode.GenericFailure);
      assert.match(JSON.stringify(first.content), /outcome.*unknown.*not automatically retried/i);
      await input.run({ toolCalls: [input.owner.parts[0] as ToolCallPart] });
      assert.equal(executions - before, 1);
    } finally {
      probeEffect = undefined;
    }
  });

  for (const stage of ["applySessionPatch", "postHook"] as const) {
    it(`preserves a successful result and stops siblings when ${stage} throws`, async () => {
      const input = fixture([call("first"), call("second")]);
      const before = executions;
      const snapshots: number[][] = [];
      if (stage === "applySessionPatch") probeSessionPatch = { plan: null };
      const hooks: HookRunner = {
        run: async (event) => {
          if (event === "postToolUse") throw new Error("postHook failed");
          return { permission: "allow", denied: false };
        },
        listEntries: () => [],
        reload: async () => {},
        paths: () => ({ user: "", project: "" }),
      };
      try {
        const outcome = await input.run({
          checkpoint: () => { snapshots.push(results(input.session).map((part) => part.returnCode)); },
          ...(stage === "applySessionPatch"
            ? { applySessionPatch: () => { throw new Error("applySessionPatch failed"); } }
            : { hooks }),
        });
        assert.equal(executions - before, 1);
        assert.match(outcome.processingError ?? "", new RegExp(`${stage} failed`));
        assert.equal(outcome.persistenceError, undefined);
        assert.deepEqual(snapshots, [[], [ToolReturnCode.Success]]);
        assert.equal(results(input.session).length, 1);
        assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.Success);
        assert.deepEqual(results(input.session)[0]!.content, [{ type: "text", text: "executed" }]);
        assert.deepEqual(input.owner.parts.map((part) => part.type === "tool_call" ? part.status : null), ["done", "pending"]);
        await input.run({ toolCalls: [input.owner.parts[0] as ToolCallPart] });
        assert.equal(executions - before, 1, "a result-processing failure must not retry the completed operation");
      } finally {
        probeSessionPatch = undefined;
      }
    });
  }

  it("keeps the original result when saving it also fails after a post-processing error", async () => {
    const input = fixture([call("first"), call("second")]);
    const before = executions;
    let checkpoints = 0;
    probeSessionPatch = { plan: null };
    try {
      const outcome = await input.run({
        applySessionPatch: () => { throw new Error("patch processing failed"); },
        checkpoint: () => {
          checkpoints += 1;
          if (checkpoints === 2) throw new Error("result persistence failed");
        },
      });
      assert.equal(executions - before, 1);
      assert.match(outcome.persistenceError ?? "", /result persistence failed/);
      assert.equal(outcome.processingError, undefined, "report the persistence failure through its own contract");
      assert.equal(results(input.session).length, 1);
      assert.equal(results(input.session)[0]!.returnCode, ToolReturnCode.Success);
      await input.run({ toolCalls: [input.owner.parts[0] as ToolCallPart] });
      assert.equal(executions - before, 1);
    } finally {
      probeSessionPatch = undefined;
    }
  });
});
