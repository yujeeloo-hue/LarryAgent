import assert from "node:assert/strict";
import test from "node:test";
import type { CocoJob, CocoSnapshot, CocoWork } from "../../../../coco/types.js";
import { cocoRuntimeLabel } from "./runtimeLabel.js";

type Snapshot = Parameters<typeof cocoRuntimeLabel>[0];
const base: Snapshot = { state: "working", work: [] };
const job = (kind: CocoJob["kind"], status: CocoJob["status"] = "running"): CocoJob => ({ id: kind, kind, status, at: 0, priority: 0 });

test("running jobs describe the actual phase in three words", () => {
  for (const [kind, verb] of [["plan", "planning"], ["execute", "executing"], ["verify", "verifying"], ["recover", "recovering"], ["inspect", "inspecting"], ["report", "reporting"], ["cleanup", "summarizing"], ["decision", "reviewing"], ["followup", "updating"]] as const) {
    assert.equal(cocoRuntimeLabel({ ...base, activeJob: job(kind) }), `CoCo is ${verb}`);
  }
});

test("a live planning action leads parallel execution and chat, without reading queued jobs as running", () => {
  const snapshot = { ...base, planningJob: job("plan"), executionJob: job("execute"), chatJob: job("chat") };
  assert.equal(cocoRuntimeLabel(snapshot), "CoCo is planning");
  assert.equal(cocoRuntimeLabel({ ...snapshot, planningJob: job("plan", "done") }), "CoCo is executing");
  assert.equal(cocoRuntimeLabel({ ...base, state: "idle", activeJob: job("plan", "queued"), pendingPlans: [{ requestId: "plan", title: "Review", status: "queued" }] }), "Ready for your next goal");
});

test("paused, blocked, cooldown and stopping override stale running metadata", () => {
  for (const [state, title] of [["paused", "Automatic work is paused"], ["blocked", "CoCo needs attention"], ["cooldown", "Automatic work is cooling down"], ["stopping", "CoCo is stopping"]] as const) {
    assert.equal(cocoRuntimeLabel({ ...base, state, planningJob: job("plan") }), title);
  }
});

test("live background checks and work stages fill missing job metadata, while completed and waiting work stay quiet", () => {
  const check: NonNullable<CocoSnapshot["backgroundTasks"]>[number] = { id: "check", sessionId: "session", purpose: "verify", title: "Check result", status: "running", startedAt: 0, updatedAt: 0, progress: "", summary: "" };
  assert.equal(cocoRuntimeLabel({ ...base, backgroundTasks: [check] }), "CoCo is verifying");
  assert.equal(cocoRuntimeLabel({ ...base, state: "idle", backgroundTasks: [{ ...check, status: "completed" }] }), "Ready for your next goal");
  const work = { status: "executing" } as CocoWork;
  assert.equal(cocoRuntimeLabel({ ...base, work: [work] }), "CoCo is executing");
  assert.equal(cocoRuntimeLabel({ ...base, work: [{ ...work, waitingForSession: true }] }), "CoCo is preparing");
  assert.equal(cocoRuntimeLabel({ ...base, work: [{ ...work, budgetHold: true }] }), "CoCo is preparing");
  assert.equal(cocoRuntimeLabel({ ...base, pendingPlans: [{ requestId: "plan", title: "Review", status: "running" }] }), "CoCo is planning");
});

test("conversation-only activity shows responding or a pending answer, while parallel work keeps its own phase", () => {
  const chat: NonNullable<CocoSnapshot["chat"]> = { sessionId: "chat", status: "running" };
  assert.equal(cocoRuntimeLabel({ ...base, state: "idle", chatJob: job("chat"), chat }), "CoCo is responding");
  const waiting = { ...chat, question: { requestId: "question" } as NonNullable<typeof chat.question> };
  assert.equal(cocoRuntimeLabel({ ...base, state: "idle", chat: waiting }), "Awaiting your answer");
  assert.equal(cocoRuntimeLabel({ ...base, executionJob: job("execute"), chat: waiting }), "CoCo is executing");
  assert.equal(cocoRuntimeLabel({ ...base, state: "idle", chatJob: job("chat"), chat: { ...chat, status: "completed" } }), "Ready for your next goal");
});
