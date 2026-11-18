import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { describe, it } from "node:test";
import { SESSION_DB_SQL } from "../../session/db/schema.js";
import { upsertSession } from "../../session/db/sessionRepository.js";
import { getSubagentRun, loadSubagentMessages } from "../../session/db/subagentRepository.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { Session, ToolCallPart } from "../../session/types.js";
import type { PermissionGateState } from "../../tools/types.js";
import type { RunAgentTurnInput, RunAgentTurnResult } from "../types.js";
import { SubagentManager } from "./manager.js";

let parentSequence = 0;

function parentSession(): Session {
  return {
    id: `checkpoint-parent-${++parentSequence}`, type: "agent", title: "parent",
    createdAt: 0, updatedAt: 0, status: "idle", progressText: "", messages: [],
    model: "test-model", providerId: "test-provider", workspaceId: "ws",
    workspacePath: process.cwd(), pinned: false, archived: false, archivedAt: null,
    contextUsage: { usedTokens: 0 }, plan: null,
  };
}

function startChild(db?: DatabaseSync) {
  const parent = parentSession();
  if (db) upsertSession(db, parent);
  let child: RunAgentTurnInput | undefined;
  let complete!: () => void;
  let id = 0;
  const manager = new SubagentManager({
    parentSession: parent, client: { baseUrl: "https://unused.invalid", apiKey: "test", model: "test" },
    gate: { fullPermissionsEnabled: true } as PermissionGateState,
    createId: () => `${parent.id}-${++id}`,
    subagentSystemPrompt: "Test checkpoint forwarding.",
    ...(db ? { db } : {}),
    runTurn: (input) => {
      child = input;
      return new Promise<RunAgentTurnResult>((resolve) => {
        complete = () => resolve({ status: "completed", modelIterations: 1 });
      });
    },
  });
  const dispatched = manager.dispatch({
    prompt: "Check durable child state", batchId: "checkpoint-batch",
    name: "checkpoint-child", role: "general", parentToolCallId: "dispatch-call",
  });
  assert.ok(dispatched.ok);
  assert.ok(child, "dispatch must pass its child input to runTurn");
  return {
    child, runId: dispatched.id,
    async finish() {
      complete();
      await manager.awaitRuns([dispatched.id]);
      manager.dispose();
    },
  };
}

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(SESSION_DB_SQL);
  return db;
}

function appendRunningCall(session: Session): ToolCallPart {
  const call: ToolCallPart = {
    type: "tool_call", id: "child-call", name: "test_action", status: "running",
    arguments: {}, argumentsRaw: "{}",
  };
  session.messages.push({
    id: "child-assistant", role: "assistant", createdAt: Date.now(), parts: [call],
  });
  return call;
}

describe("SubagentManager durable checkpoints", () => {
  it("persists the child's running state and completed tool result through its injected checkpoint", async () => {
    const db = memoryDb();
    const harness = startChild(db);
    try {
      const checkpoint = harness.child.checkpoint;
      assert.ok(checkpoint);
      const call = appendRunningCall(harness.child.session);
      await checkpoint();
      assert.equal(getSubagentRun(db, harness.runId)?.status, "running");
      const running = loadSubagentMessages(db, harness.runId);
      assert.equal(running.length, 1);
      const persistedCall = running[0]!.parts.find((part) => part.type === "tool_call");
      assert.equal(persistedCall?.status, "running");

      call.status = "done";
      harness.child.session.messages.push({
        id: "child-tool-result", role: "tool", toolCallId: call.id, createdAt: Date.now(), parts: [{
          type: "tool_result", toolCallId: call.id, returnCode: ToolReturnCode.Success,
          content: [{ type: "text", text: "completed" }],
        }],
      });
      await checkpoint();
      const completed = loadSubagentMessages(db, harness.runId);
      assert.equal(completed[0]!.parts.find((part) => part.type === "tool_call")?.status, "done");
      const result = completed[1]!.parts.find((part) => part.type === "tool_result");
      assert.equal(result?.toolCallId, call.id);
      assert.equal(result?.returnCode, ToolReturnCode.Success);
    } finally {
      await harness.finish();
      db.close();
    }
  });

  it("propagates both run and message database errors instead of swallowing checkpoint failures", async () => {
    const db = memoryDb();
    const harness = startChild(db);
    try {
      const checkpoint = harness.child.checkpoint;
      assert.ok(checkpoint);
      appendRunningCall(harness.child.session);
      await checkpoint();
      db.exec(`CREATE TRIGGER reject_checkpoint_run BEFORE INSERT ON subagent_runs
        BEGIN SELECT RAISE(ABORT, 'checkpoint run rejected'); END;`);
      await assert.rejects(async () => checkpoint(), /checkpoint run rejected/);
      db.exec("DROP TRIGGER reject_checkpoint_run");

      db.exec(`CREATE TRIGGER reject_checkpoint_message BEFORE INSERT ON subagent_messages
        BEGIN SELECT RAISE(ABORT, 'checkpoint message rejected'); END;`);
      harness.child.session.messages.push({
        id: "new-child-message", role: "user", createdAt: Date.now(), parts: [{ type: "text", text: "new" }],
      });
      await assert.rejects(async () => checkpoint(), /checkpoint message rejected/);
      assert.equal(loadSubagentMessages(db, harness.runId).length, 1,
        "a failed message replacement must roll back to its last checkpoint");
    } finally {
      db.exec("DROP TRIGGER IF EXISTS reject_checkpoint_run; DROP TRIGGER IF EXISTS reject_checkpoint_message;");
      await harness.finish();
      db.close();
    }
  });

  it("does not inject a checkpoint when the manager has no database", async () => {
    const harness = startChild();
    try {
      assert.equal("checkpoint" in harness.child, false);
    } finally {
      await harness.finish();
    }
  });
});
