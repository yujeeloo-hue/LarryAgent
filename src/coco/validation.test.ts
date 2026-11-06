import test from "node:test";
import assert from "node:assert/strict";
import { checkRuleRunBrief, RULE_RUN_BRIEF_LIMITS, validatePlan, validateRule } from "./validation.js";

/** Minimal valid rule (production weekly-report shape, week cadence). */
const weekRule = (cadence: unknown) => ({ id: "r1", name: "Weekly git report", objective: "Generate the weekly report", mode: "fixed", scope: { all: false, workspaceIds: ["p"], excludedWorkspaceIds: [] }, enabled: true, confirmed: true, providerId: "", cadence, events: [], acceptance: [], nextRunAt: 0, createdAt: 0 });

test("rule validation canonicalizes unsorted/duplicated week weekdays", () => {
  const rule = validateRule(weekRule({ kind: "week", weekdays: [5, 1, 5], time: "16:00" }));
  assert.deepEqual(rule.cadence, { kind: "week", weekdays: [1, 5], time: "16:00" });
});

test("rule schedule errors name the accepted cadence shapes (dayOfWeek production failure)", () => {
  assert.throws(() => validateRule(weekRule({ kind: "week", dayOfWeek: 5, time: "16:00" })), /weekdays:\[0-6\].*0=Sun\.\.6=Sat/s);
  assert.throws(() => validateRule(weekRule({ kind: "weekly", time: "16:00" })), /Invalid schedule\. Supported cadence shapes:/);
});

test("plan ruleSuggestions go through the same cadence canonicalization", () => {
  const work = [{ key: "w", title: "T", objective: "o", workspaceId: "p", steps: ["s"], acceptance: [{ description: "d", kind: "review" }] }];
  const bad = validatePlan({ reply: "ok", work, ruleSuggestions: [{ ...weekRule({ kind: "week", weekdays: [4, 0, 4], time: "09:30" }) }] }, new Set(["p"]), new Set());
  assert.deepEqual(bad.ruleSuggestions[0]?.cadence, { kind: "week", weekdays: [0, 4], time: "09:30" });
  assert.throws(() => validatePlan({ reply: "ok", work, ruleSuggestions: [{ ...weekRule({ kind: "week", dayOfWeek: 5, time: "16:00" }) }] }, new Set(["p"]), new Set()), /weekdays/);
});


test("plan validation treats null optional fields as absent", () => {
  const plan = validatePlan({ reply: "ok", changes: null, ruleSuggestions: null, work: [{ key: "w", title: "Audit", objective: "Check fonts", workspaceId: "p", priority: 50, deadlineAt: null, userPriority: null, sessionStrategy: null, steps: ["Scan"], acceptance: [{ description: "Scanned", kind: "review" }] }] }, new Set(["p"]), new Set());
  assert.equal(plan.work[0]?.deadlineAt, undefined);
  assert.equal(plan.work[0]?.userPriority, undefined);
  assert.deepEqual(plan.changes, []);
  assert.throws(() => validatePlan({ reply: "ok", work: [{ key: "w", title: "Audit", objective: "o", workspaceId: "p", deadlineAt: "tomorrow", steps: ["s"], acceptance: [{ description: "d", kind: "review" }] }] }, new Set(["p"]), new Set()), /integer/);
});

test("rule-run briefs pass when short and name every oversized field otherwise", () => {
  const L = RULE_RUN_BRIEF_LIMITS;
  const brief = (over: Record<string, unknown> = {}) => ({ reply: "ok", work: [{ key: "w", title: "Full test", objective: "Run the commit-gated full test suite.", workspaceId: "p", steps: ["Check the gate", "Run npm test"], acceptance: [{ description: "Entry recorded", kind: "review" }], ...over }] });
  checkRuleRunBrief(brief());
  checkRuleRunBrief({ reply: "no action", work: [] });
  const error = (() => { try { checkRuleRunBrief(brief({ objective: "x".repeat(L.objective + 1), steps: ["s", "y".repeat(L.step + 1), "s", "s", "s", "s"], acceptance: Array.from({ length: L.acceptance + 1 }, () => ({ description: "d", kind: "review" })) })); } catch (e) { return String(e); } return ""; })();
  assert.match(error, new RegExp(`objective is ${L.objective + 1} characters`));
  assert.match(error, /work\[0\] has 6 steps/);
  assert.match(error, /steps\[1\] is \d+ characters/);
  assert.match(error, /acceptance criteria \(max 3\)/);
  assert.match(error, /submit_coco_result again/);
});
