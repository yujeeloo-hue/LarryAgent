import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenAiChatMessage } from "../../llm/types.js";
import { formatPlanSummary } from "../../session/plan.js";
import type {
  Message,
  PlanStepStatus,
  SessionPlan,
  ToolResultPart,
} from "../../session/types.js";
import {
  PLAN_PIN_HEADER,
  activePlanPin,
  ensurePlanPinOnWire,
  formatPlanPin,
} from "./planPin.js";

function plan(
  statuses: PlanStepStatus[],
  overrides: Partial<SessionPlan> = {},
): SessionPlan {
  return {
    id: "p1",
    title: "Refactor",
    status: "active",
    steps: statuses.map((status, i) => ({ id: `s${i + 1}`, title: `Step ${i + 1}`, status })),
    createdAt: 1,
    updatedAt: 1,
    createToolCallId: "c1",
    ...overrides,
  };
}

function planResult(id: string, callId: string, p: SessionPlan, returnCode = 0): Message {
  const result: ToolResultPart = {
    type: "tool_result",
    toolCallId: callId,
    returnCode,
    content: [{ type: "text", text: formatPlanSummary(p) }],
  };
  return { id, role: "tool", toolCallId: callId, parts: [result], createdAt: 1 };
}

const clearMarker: Message = {
  id: "clear",
  role: "system",
  parts: [{ type: "context_clear", id: "c" } as never],
  createdAt: 1,
};

describe("activePlanPin", () => {
  it("pins the active plan's newest result in scope without plan_json", () => {
    const live = plan(["completed", "in_progress"]);
    const scope = [
      planResult("t1", "c1", plan(["in_progress", "pending"])),
      planResult("t2", "c2", live),
      planResult("t3", "c3", plan(["completed", "completed"]), 5),
    ];
    const pin = activePlanPin(scope, live);
    assert.equal(pin?.toolCallId, "c2");
    assert.match(pin!.text, /^Plan "Refactor" \[active\] 1\/2 done/);
    assert.match(pin!.text, /- \[in_progress\] s2: Step 2/);
    assert.doesNotMatch(pin!.text, /plan_json:/);
  });

  it("does not pin finished, replaced or missing plans", () => {
    const scope = [planResult("t1", "c1", plan(["completed", "in_progress"]))];
    assert.equal(activePlanPin(scope, plan(["completed", "completed"], { status: "completed" })), null);
    assert.equal(activePlanPin(scope, plan(["in_progress"], { id: "p2" })), null);
    assert.equal(activePlanPin(scope, null), null);
    assert.equal(
      activePlanPin([...scope, clearMarker], plan(["completed", "in_progress"])),
      null,
    );
  });

  it("carries the live Session.plan state when the newest result is stale", () => {
    const scope = [planResult("t1", "c1", plan(["completed", "in_progress"]))];
    const reverted = plan(["in_progress", "pending"]);
    const pin = activePlanPin(scope, reverted);
    assert.equal(pin?.toolCallId, "c1");
    assert.match(pin!.text, /- \[in_progress\] s1: Step 1\n- \[pending\] s2: Step 2/);
  });

  it("keeps the summarized result when a newer result is still live", () => {
    const covered = planResult("t1", "c1", plan(["in_progress", "pending"]));
    const newer = planResult("t2", "c2", plan(["completed", "in_progress"]));
    const pin = activePlanPin([covered], plan(["completed", "completed"]), [covered, newer]);
    assert.match(pin!.text, /- \[in_progress\] s1: Step 1/);
  });
});

describe("ensurePlanPinOnWire", () => {
  const pin = { toolCallId: "c3", text: 'Plan "New" [active] 1/2 done' };
  const prefix: OpenAiChatMessage = { role: "system", content: "[AGENT]" };

  it("inserts the pin after the system prefix when the result was cut", () => {
    const out = ensurePlanPinOnWire([prefix, { role: "user", content: "continue" }], 1, pin);
    assert.equal(out.length, 3);
    assert.equal(out[1]?.role, "system");
    assert.equal(out[1]?.content, formatPlanPin(pin));
    assert.ok(String(out[1]?.content).startsWith(PLAN_PIN_HEADER));
  });

  it("leaves the wire alone when the raw result or the same pin is kept", () => {
    const withRaw: OpenAiChatMessage[] = [
      prefix,
      { role: "tool", tool_call_id: "c3", content: "raw" },
    ];
    assert.equal(ensurePlanPinOnWire(withRaw, 1, pin), withRaw);
    const withSummaryPin: OpenAiChatMessage[] = [
      prefix,
      { role: "system", content: `Previous conversation summary:\n…\n\n${formatPlanPin(pin)}` },
    ];
    assert.equal(ensurePlanPinOnWire(withSummaryPin, 1, pin), withSummaryPin);
    assert.equal(ensurePlanPinOnWire(withRaw, 1, null), withRaw);
  });
});
