import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { SessionPlan } from "../../session/types.js";
import { planFrontierLines } from "./overlays.js";

function activePlan(steps: SessionPlan["steps"]): SessionPlan {
  return {
    id: "p1",
    title: "Ship auth",
    status: "active",
    steps,
    createdAt: 1,
    updatedAt: 1,
    createToolCallId: "tc1",
  };
}

describe("planFrontierLines", () => {
  it("returns nothing without an active plan", () => {
    assert.deepEqual(planFrontierLines(null), []);
    assert.deepEqual(
      planFrontierLines({ ...activePlan([]), status: "completed", steps: [] }),
      [],
    );
  });

  it("counts completed work and lists only the live frontier", () => {
    const lines = planFrontierLines(
      activePlan([
        { id: "s1", title: "Read module", status: "completed" },
        { id: "s2", title: "Patch store", status: "in_progress" },
        { id: "s3", title: "Add tests", status: "pending", dependsOn: ["s2"] },
        { id: "s4", title: "Docs", status: "pending" },
      ]),
    );
    assert.equal(lines[0], 'Plan: "Ship auth"');
    assert.equal(lines[1], "Progress: 1/4 completed, 3 remaining");
    assert.ok(lines.some((line) => line.startsWith("Now: s2")));
    assert.ok(lines.some((line) => line.startsWith("Next: s3")));
    assert.ok(!lines.some((line) => line.startsWith("Ready:")));
    assert.ok(!lines.some((line) => line.startsWith("Blocked:")));
    assert.ok(!lines.some((line) => line.includes("Read module")));
  });
});
