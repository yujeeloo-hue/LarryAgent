import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { openSessionDb, loadAllSessions, upsertSession } from "../session/db/index.js";
import { ToolReturnCode } from "../session/returnCodes.js";
import type { AssistantMessage, Session, ToolCallPart, ToolResultPart } from "../session/types.js";
import { upsertTool } from "../tools/registry.js";
import type { PermissionGateState } from "../tools/types.js";
import { sealOrphanToolCallsInSession } from "./sealOrphanToolCalls.js";
import { createCocoPolicy } from "../coco/policy.js";
import { createTurnHost } from "./turnHost/createTurnHost.js";

let root = "";
let executeProbe: () => void;
const toolName = "sqlite_checkpoint_probe";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "jellybot-checkpoint-"));
  configureUserMemoryRoot(root);
  upsertTool({ name: toolName, description: "In-memory execution probe", parameters: { type: "object" },
    defaultPermissionLevel: 0 }, async () => {
    executeProbe();
    return { returnCode: ToolReturnCode.Success, content: [{ type: "text", text: "effect completed" }] };
  });
});
after(async () => { await rm(root, { recursive: true, force: true }); });

function fixture(id: string) {
  const call: ToolCallPart = { type: "tool_call", id: "call", name: toolName, status: "pending",
    arguments: {}, argumentsRaw: "{}" };
  const owner: AssistantMessage = { id: "owner", role: "assistant", parts: [call], createdAt: 1 };
  const session: Session = {
    id, type: "agent", title: "Checkpoint recovery", status: "idle", progressText: "", createdAt: 1, updatedAt: 1,
    messages: [owner], model: "m", providerId: "p", workspaceId: "w", workspacePath: root,
    pinned: false, archived: false, archivedAt: null, contextUsage: { usedTokens: 0 }, plan: null,
  };
  const db = openSessionDb(join(root, id));
  upsertSession(db, session);
  const reload = () => loadAllSessions(db)[0]!;
  let sequence = 0;
  function host(state: Session, checkpoint: () => void) {
    return createTurnHost({ session: state, client: { baseUrl: "http://127.0.0.1:9", apiKey: "test", model: "m" },
      gate: { fullPermissionsEnabled: true } as PermissionGateState, createId: () => `${id}-${++sequence}`,
      checkpoint, runChildTurn: async () => { throw new Error("No child expected"); } });
  }
  return { db, session, owner, call, reload, host };
}
function results(session: Session): ToolResultPart[] {
  return session.messages.flatMap((message) => message.parts).filter((part): part is ToolResultPart => part.type === "tool_result");
}

describe("Host tool checkpoints survive SQLite reload", () => {
  it("resumes a saved ask_user batch without sealing pending siblings or repeating completed ones", async () => {
    const f = fixture("ask-continuation");
    try {
      const answered: ToolCallPart = { ...f.call, id: "answered-ask", name: "ask_user", status: "done" };
      f.owner.parts.unshift(answered);
      f.session.messages.push({ id: "answer", role: "tool", toolCallId: answered.id, createdAt: 1,
        parts: [{ type: "tool_result", toolCallId: answered.id, returnCode: 0, content: [{ type: "text", text: "User answered" }] }] });
      upsertSession(f.db, f.session);
      let effects = 0;
      executeProbe = () => { effects += 1; };
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const restored = f.reload();
        const result = await f.host(restored, () => upsertSession(f.db, restored)).startTurn({
          userText: "", suppressUserMessage: true,
          resumeToolBatch: { assistantMessageId: f.owner.id, toolCallIds: [answered.id, f.call.id] },
        });
        assert.equal(result, "ok");
      }
      assert.equal(effects, 1);
      assert.deepEqual(results(f.reload()).map((part) => part.returnCode), [0, 0]);
    } finally { f.db.close(); }
  });

  it("native Trash rewrites still require Coco modification permission", async () => {
    const f = fixture("coco-readonly-trash");
    try {
      // Deliberately absent target + force: a failing regression cannot touch the user's Trash.
      const target = join(root, "absent-trash-probe");
      upsertTool({ name: "run_shell", description: "Rewrite policy probe", parameters: { type: "object" }, defaultPermissionLevel: 0,
        assessRisk: () => ({ action: "allow", rewrite: { type: "trash", targets: [target], force: true, originalCommand: "rm missing" } }) }, async () => { throw new Error("No raw shell execution expected"); });
      f.call.name = "run_shell";
      const policy = createCocoPolicy(root, [], false, () => true, { assertMcp: () => undefined });
      const host = createTurnHost({ session: f.session, client: { baseUrl: "http://127.0.0.1:9", apiKey: "test", model: "m" },
        gate: { fullPermissionsEnabled: false, authorizeTool: policy.assertTool, assertPath: policy.assertPath } as PermissionGateState,
        createId: () => "trash-result", checkpoint: () => upsertSession(f.db, f.session), runChildTurn: async () => { throw new Error("No child"); } });
      await host.runToolsPhase(f.owner, [f.call]);
      assert.equal(results(f.session).at(-1)?.returnCode, ToolReturnCode.GenericFailure);
      assert.match(JSON.stringify(results(f.session)), /read-only/);
    } finally { f.db.close(); }
  });

  it("saves running before the effect and reuses the saved result after reload", async () => {
    const f = fixture("success");
    try {
      let effects = 0;
      executeProbe = () => {
        const stored = f.reload().messages[0]!.parts[0]!;
        assert.equal(stored.type === "tool_call" && stored.status, "running");
        effects += 1;
      };
      assert.equal((await f.host(f.session, () => upsertSession(f.db, f.session)).runToolsPhase(f.owner, [f.call])).kind, "ok");
      const restored = f.reload();
      assert.equal(results(restored)[0]!.returnCode, ToolReturnCode.Success);
      const owner = restored.messages[0] as AssistantMessage;
      assert.equal((await f.host(restored, () => upsertSession(f.db, restored)).runToolsPhase(owner, owner.parts as ToolCallPart[])).kind, "ok");
      assert.equal(effects, 1);
      assert.equal(results(f.reload()).length, 1);
    } finally { f.db.close(); }
  });

  it("a failed result save stops the Host and a restored running call is never retried", async () => {
    const f = fixture("post-effect-failure");
    try {
      let effects = 0;
      let saves = 0;
      executeProbe = () => { effects += 1; };
      const result = await f.host(f.session, () => {
        if (++saves > 1) throw new Error("Simulated unavailable disk");
        upsertSession(f.db, f.session);
      }).runToolsPhase(f.owner, [f.call]);
      assert.equal(result.kind, "error");
      assert.equal(results(f.session)[0]!.returnCode, ToolReturnCode.Success, "known result remains authoritative in memory");
      const restored = f.reload();
      assert.equal(results(restored).length, 0, "database contains the pre-execution checkpoint");
      sealOrphanToolCallsInSession(restored, () => "recovery");
      assert.match(JSON.stringify(results(restored)[0]!.content), /outcome is unknown.*not automatically retried/i);
      upsertSession(f.db, restored);
      const owner = restored.messages[0] as AssistantMessage;
      await f.host(restored, () => upsertSession(f.db, restored)).runToolsPhase(owner, owner.parts as ToolCallPart[]);
      assert.equal(effects, 1);
      assert.equal(results(f.reload()).length, 1);
    } finally { f.db.close(); }
  });

  it("an unavailable pre-execution save prevents the effect", async () => {
    const f = fixture("pre-effect-failure");
    try {
      let effects = 0;
      executeProbe = () => { effects += 1; };
      const result = await f.host(f.session, () => { throw new Error("Simulated unavailable disk"); }).runToolsPhase(f.owner, [f.call]);
      assert.equal(result.kind, "error");
      assert.equal(effects, 0);
      const stored = f.reload().messages[0]!.parts[0]!;
      assert.equal(stored.type === "tool_call" && stored.status, "pending");
    } finally { f.db.close(); }
  });
});
