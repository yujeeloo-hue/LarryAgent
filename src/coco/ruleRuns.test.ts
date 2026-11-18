import assert from "node:assert/strict";
import { test } from "node:test";
import { chatRuns, recentRuns, ruleRunAcceptance, ruleRunAt } from "./ruleRuns.js";
import type { CocoMessage, CocoRuleRun, CocoVerification, CocoWork } from "./types.js";

const work = (id: string, patch: Partial<CocoWork> = {}): CocoWork => ({ id, goalId: "g", title: `Work ${id}`, objective: "o", workspaceId: "p1", status: "queued", priority: 50, dependsOn: [], steps: [], acceptance: [{ id: "c1", description: "d", kind: "review" }, { id: "c2", description: "d", kind: "review" }], deliverables: [], ruleIds: ["r1"], revision: 1, repairs: 0, fullPermissions: true, providerId: "", createdAt: 0, updatedAt: 0, summary: "", timeline: [], ...patch });
const verification = (workId: string, at: number, passed: boolean[], revision = 1): CocoVerification => ({ id: `${workId}-${at}`, workId, revision, at, passed: passed.every(Boolean), summary: "", checks: passed.map((p, i) => ({ criterionId: `c${i + 1}`, passed: p, evidence: p ? "ok" : `Criterion ${i + 1} still fails` })) });
const run = (workIds: string[]): CocoRuleRun => ({ id: "j1", ruleId: "r1", ruleName: "Rule", startedAt: 0, status: "planned", attempts: 1, workIds });

test("latest verification summarizes passed and failed criteria", () => {
  const result = ruleRunAcceptance(run(["a", "b"]), [work("a", { status: "completed" }), work("b", { status: "queued", revision: 2 })], [verification("a", 1, [false, true]), verification("a", 2, [true, true]), verification("b", 3, [true, false], 2)]);
  assert.deepEqual(result.map(r => [r.tone, r.summary]), [["passed", "2/2 criteria passed"], ["failed", "1/2 criteria passed · Criterion 2 still fails"]]);
});

test("chat requests that planned work become runs anchored at completion", () => {
  const messages: CocoMessage[] = [
    { id: "m1", role: "user", text: "Scan   the codebase\nfor Chinese text", at: 100 },
    { id: "reply-1", role: "assistant", text: "Planned a baseline scan.", at: 110, goalId: "m1", status: "completed" },
    { id: "m2", role: "user", text: "Fix the build", at: 200 },
    { id: "m3", role: "user", text: "Just chatting", at: 300 },
  ];
  const runs = chatRuns([
    work("a", { goalId: "m1", ruleIds: [], status: "completed", updatedAt: 900 }),
    work("b", { goalId: "other", goalIds: ["other", "m1"], ruleIds: [], status: "cancelled", updatedAt: 500 }),
    work("c", { goalId: "m2", ruleIds: [], status: "executing", updatedAt: 250 }),
  ], messages);
  assert.deepEqual(runs.map(r => [r.id, r.source, r.ruleName, r.status, r.endedAt, r.workIds, r.summary]), [
    ["chat-m1", "chat", "Scan the codebase for Chinese text", "planned", 900, ["a", "b"], "Planned a baseline scan."],
    ["chat-m2", "chat", "Fix the build", "running", undefined, ["c"], undefined],
  ]);
  assert.deepEqual([ruleRunAt(runs[0]!), ruleRunAt(runs[1]!)], [900, 200]);
  const rule = { ...run([]), id: "rule-run", startedAt: 800, endedAt: 1000 };
  assert.deepEqual(recentRuns([rule, ...runs], 1).map(r => r.id), ["chat-m1", "chat-m2"]);
});

test("unverified, cancelled, decision and missing work get a readable state", () => {
  const result = ruleRunAcceptance(run(["a", "b", "c", "gone"]), [work("a", { status: "executing" }), work("b", { status: "cancelled" }), work("c", { status: "to_decide", decision: "Choose a font stack" })], [verification("a", 1, [false, false], 0)]);
  assert.deepEqual(result.map(r => [r.workId, r.tone, r.summary]), [["a", "pending", "Acceptance pending · 2 criteria"], ["b", "neutral", "Cancelled"], ["c", "failed", "Choose a font stack"]]);
});
