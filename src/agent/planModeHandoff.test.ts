import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { configureUserMemoryRoot } from "../memory/store.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import type { JsonObject, Session, SessionPlanDoc } from "../session/types.js";
import type { PermissionGateState } from "../tools/types.js";
import { clearToolOfferOverride, setToolOfferOverride } from "../tools/offerConfig.js";
import { planDocRevision } from "../session/planDoc.js";
import { setSessionPhaseInMemory } from "../session/sessionPhase.js";
import { runAgentTurn } from "./runAgentTurn.js";
import type { RunAgentTurnInput, StreamChatFn } from "./types.js";

let root = "";
let id = 0;
const body = "# Feature\n\n## Goal\nImplement the approved feature.\n\n## Approach\nUse the existing module.\n\n## Acceptance\nChecks pass.";
before(async () => {
  root = await mkdtemp(join(tmpdir(), "plan-handoff-"));
  configureUserMemoryRoot(root);
  configurePromptDefaults(join(process.cwd(), "resources/prompts"));
  setToolOfferOverride("create_skill", false);
});
after(async () => { clearToolOfferOverride("create_skill"); await rm(root, { recursive: true, force: true }); });

async function sessionWithDoc(bound = true): Promise<{ session: Session; path: string }> {
  const workspacePath = join(root, `ws-${++id}`);
  await mkdir(join(workspacePath, "docs/plans"), { recursive: true });
  const path = join(workspacePath, "docs/plans/design.md");
  await writeFile(path, body);
  const session: Session = {
    id: `session-${++id}`, type: "agent", title: "Handoff", createdAt: 1, updatedAt: 1,
    status: "idle", progressText: "", messages: [], model: "mock", providerId: "mock",
    workspaceId: "ws", workspacePath, pinned: false, archived: false, archivedAt: null,
    contextUsage: { usedTokens: 0 }, plan: null,
    planDoc: bound ? { path, summary: "Feature", updatedAt: 1, revision: planDocRevision(body) } : null,
  };
  return { session, path };
}

type Round = string | { name: string; args: JsonObject };
async function run(session: Session, rounds: Round[], extra: Partial<RunAgentTurnInput> = {}) {
  let index = 0;
  const entered: string[] = [];
  const stream: StreamChatFn = async function* () {
    const round = rounds[index++] ?? "done";
    if (typeof round === "string") yield { type: "text_delta", text: round };
    else yield { type: "tool_call", id: `call-${++id}`, name: round.name, arguments: round.args, argumentsRaw: JSON.stringify(round.args) };
    yield { type: "done", reason: "completed" };
  };
  const result = await runAgentTurn({
    session, userText: "Review this plan", runMode: "plan",
    client: { baseUrl: "http://127.0.0.1:9", apiKey: "test", model: "mock" },
    gate: { fullPermissionsEnabled: true } as PermissionGateState, createId: () => `message-${++id}`,
    streamChat: stream, maxModelIterations: 10,
    blackboardGet: key => session.fsmBlackboard?.[key],
    blackboardSet: (key, value) => {
      if (key === "phase") setSessionPhaseInMemory(session, typeof value === "string" ? value : null);
      else session.fsmBlackboard = { ...(session.fsmBlackboard ?? {}), [key]: value };
      return { ok: true };
    },
    onEvent: event => { if (event.type === "fsm_node" && event.phase === "enter") entered.push(event.nodeId); },
    ...extra,
  });
  assert.equal(result.status, "idle", session.progressText);
  return entered;
}

describe("Plan-mode document handoff through the real host/tool pipeline", () => {
  it("bound document overrides an empty phase and stale gathering phase", async () => {
    for (const phase of [null, "gathering"]) {
      const { session } = await sessionWithDoc();
      setSessionPhaseInMemory(session, phase);
      const entered = await run(session, ["reviewed"]);
      assert.equal(entered[1], "plan_reviewer");
      assert.ok(!entered.includes("analyser") && !entered.includes("agent"));
    }
  });

  it("Agent writes a design; Plan adopts the same file and honors 开工 after review", async () => {
    const { session, path } = await sessionWithDoc(false);
    const agent = await run(session, [
      { name: "write_file", args: { path, content: body } },
      `Design saved at ${path}`,
    ], { runMode: "agent", userText: "Write the design document" });
    assert.equal(agent[1], "agent");
    assert.equal(session.planDoc, null);
    const entered = await run(session, [
      { name: "fsm_route", args: { route: "ready", reason: "design unchanged and settled" } },
      { name: "create_plan", args: { title: "Feature", steps: ["Implement", "Verify"] } },
      "implementation step ready",
    ], { userText: "开工" });
    assert.deepEqual(entered.slice(0, 4), ["start", "plan_reviewer", "planner", "executor"]);
    assert.ok(!entered.includes("agent") && !entered.includes("plan_writer"));
    const adoptedDoc = (session as Session).planDoc as SessionPlanDoc | null;
    assert.equal(adoptedDoc?.path, path);
    assert.equal(adoptedDoc?.approvedRevision, planDocRevision(body));
    assert.equal(session.plan?.status, "active");
    assert.equal(await readFile(path, "utf8"), body);
    const resumed = await run(session, ["continue step"], { userText: "继续" });
    assert.equal(resumed[1], "executor");
    assert.equal(session.plan?.steps[0]?.status, "in_progress");
  });

  it("approved document resumes planner even with no phase", async () => {
    const { session } = await sessionWithDoc();
    session.planDoc!.approvedRevision = session.planDoc!.revision!;
    const entered = await run(session, ["plan next"]);
    assert.equal(entered[1], "planner");
  });

  it("UI approval records a revision and resumes planner", async () => {
    const { session } = await sessionWithDoc();
    setSessionPhaseInMemory(session, "review");
    session.planDoc!.approvalPending = true;
    session.planDoc!.reviewedRevision = session.planDoc!.revision!;
    const entered = await run(session, ["plan next"], { userText: "", controlIntent: "approve", suppressUserMessage: true });
    assert.equal(entered[1], "planner");
    assert.equal(session.planDoc?.approvedRevision, planDocRevision(body));
    assert.equal(session.planDoc?.approvalPending, undefined);
  });

  it("an external edit invalidates approval and goes back to review", async () => {
    const { session, path } = await sessionWithDoc();
    session.planDoc!.approvedRevision = session.planDoc!.revision!;
    setSessionPhaseInMemory(session, "planning");
    await writeFile(path, `${body}\nChanged design`);
    const entered = await run(session, ["review changed design"]);
    assert.equal(entered[1], "plan_reviewer");
    assert.equal(session.planDoc?.approvedRevision, undefined);
    assert.equal(session.planDoc?.revision, planDocRevision(`${body}\nChanged design`));
  });

  it("a stale Approve click cannot approve an externally changed file", async () => {
    const { session, path } = await sessionWithDoc();
    setSessionPhaseInMemory(session, "review");
    session.planDoc!.approvalPending = true;
    await writeFile(path, `${body}\nChanged design`);
    const entered = await run(session, [], { userText: "", controlIntent: "approve", suppressUserMessage: true });
    assert.ok(!entered.includes("planner"));
    assert.equal(session.planDoc?.approvedRevision, undefined);
    const secondClick = await run(session, [], { userText: "", controlIntent: "approve", suppressUserMessage: true });
    assert.ok(!secondClick.includes("planner"), "must review the new version before approving again");
  });

  it("go-ahead does not authorize a version changed since the last discussion", async () => {
    const { session, path } = await sessionWithDoc();
    await writeFile(path, `${body}\nChanged after discussion`);
    const entered = await run(session, [{ name: "fsm_route", args: { route: "ready", reason: "updated review" } }], { userText: "开工" });
    assert.equal(entered[1], "plan_reviewer");
    assert.ok(!entered.includes("planner"));
    assert.equal(session.planDoc?.executionRequestedRevision, undefined);
    assert.equal(session.planDoc?.approvedRevision, undefined);
    assert.equal(session.planDoc?.approvalPending, true);
  });

  it("unapproved versioned planning state recovers into review", async () => {
    const { session } = await sessionWithDoc();
    setSessionPhaseInMemory(session, "planning");
    const entered = await run(session, ["review first"]);
    assert.equal(entered[1], "plan_reviewer");
  });

  it("older already-approved sessions gain revision metadata and keep their phase", async () => {
    const { session } = await sessionWithDoc();
    delete session.planDoc!.revision;
    setSessionPhaseInMemory(session, "planning");
    const entered = await run(session, ["resume approved legacy plan"]);
    assert.equal(entered[1], "planner");
    assert.equal(session.planDoc?.approvedRevision, planDocRevision(body));
  });

  it("missing bound files cannot resume planner", async () => {
    const { session, path } = await sessionWithDoc();
    session.planDoc!.approvedRevision = session.planDoc!.revision!;
    setSessionPhaseInMemory(session, "planning");
    await rm(path);
    const entered = await run(session, ["collect replacement context"]);
    assert.equal(entered[1], "analyser");
    assert.equal(session.planDoc, null);
  });

  it("reviewer rejects unsupported routes in the real tool execution layer", async () => {
    const { session } = await sessionWithDoc();
    const entered = await run(session, [
      { name: "fsm_route", args: { route: "direct", reason: "try bypass" } },
      { name: "fsm_route", args: { route: "plan_approved", reason: "try self-approval" } },
      "review only",
    ]);
    assert.ok(!entered.includes("planner") && !entered.includes("agent"));
    const failures = session.messages.flatMap(m => m.parts).filter(p => p.type === "tool_result" && p.returnCode !== 0);
    assert.equal(failures.length, 2);
  });

  it("ordinary document references go to review without granting approval", async () => {
    const { session, path } = await sessionWithDoc(false);
    const entered = await run(session, [
      { name: "fsm_route", args: { route: "ready", reason: "ready" } },
    ], { userText: `看看 ${path}` });
    assert.equal(entered[1], "plan_reviewer");
    assert.ok(!entered.includes("planner"));
    assert.equal(session.planDoc?.approvalPending, true);
    assert.equal(session.planDoc?.approvedRevision, undefined);
  });

  it("analyser can adopt an unbound current-task file without writing another plan", async () => {
    const { session, path } = await sessionWithDoc(false);
    const entered = await run(session, [
      { name: "adopt_plan_doc", args: { path } },
      { name: "fsm_route", args: { route: "ready", reason: "reviewed" } },
    ], { userText: "Review the design we discussed" });
    assert.deepEqual(entered.slice(0, 3), ["start", "analyser", "plan_reviewer"]);
    assert.equal(session.planDoc?.path, path);
    assert.equal(await readFile(path, "utf8"), body);
  });

  it("does not auto-select an unrelated old plan from the workspace or older turns", async () => {
    const { session, path } = await sessionWithDoc(false);
    session.messages = [
      { id: "old-user", role: "user", createdAt: 1, parts: [{ type: "text", text: "Old task" }] },
      { id: "old-assistant", role: "assistant", createdAt: 2, parts: [{ type: "text", text: `Saved ${path}` }] },
      { id: "new-user", role: "user", createdAt: 3, parts: [{ type: "text", text: "Discuss a different task" }] },
      { id: "new-assistant", role: "assistant", createdAt: 4, parts: [{ type: "text", text: "New task design agreed" }] },
    ];
    const entered = await run(session, ["collect current-task context"], { userText: "开工" });
    assert.equal(entered[1], "analyser");
    assert.equal(session.planDoc, null);
  });

  it("Direct Q&A denies native and tool_call-wrapped writes at runtime", async () => {
    const { session } = await sessionWithDoc(false);
    const target = join(session.workspacePath!, "should-not-exist.txt");
    const entered = await run(session, [
      { name: "fsm_route", args: { route: "direct", reason: "question" } },
      { name: "write_file", args: { path: target, content: "bad" } },
      { name: "tool_call", args: { name: "write_file", arguments: { path: target, content: "bad" } } },
      { name: "tool_call", args: { name: "create_skill", arguments: { name: "should-not-create", description: "Blocked write", body: "Must not execute." } } },
      { name: "create_plan", args: { title: "Bypass", steps: ["One", "Two"] } },
      "answer only",
    ], { userText: "Explain this file" });
    assert.ok(entered.includes("agent"));
    await assert.rejects(readFile(target), { code: "ENOENT" });
    assert.equal(session.plan, null);
    const failures = session.messages.flatMap(m => m.parts).filter(p => p.type === "tool_result" && p.returnCode !== 0);
    assert.equal(failures.length, 4);
    assert.ok(failures.some(p => p.type === "tool_result" && p.content.some(c => c.type === "text" && c.text.includes('"create_skill"') && c.text.includes("allowlist"))));
  });
});
