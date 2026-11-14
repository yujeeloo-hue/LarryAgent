import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyStepInProgress,
  buildPlanStepsFromSpecs,
  getBlockedSteps,
  getReadySteps,
  parseCreatePlanArgs,
  validatePlanStepGraph,
} from "./plan.js";

describe("plan DAG helpers", () => {
  it("chains plain-string steps by default", () => {
    const parsed = parseCreatePlanArgs({
      steps: ["First", "Second", "Third"],
    });
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    const steps = buildPlanStepsFromSpecs(parsed.stepSpecs);
    assert.deepEqual(steps[0]?.dependsOn, undefined);
    assert.deepEqual(steps[1]?.dependsOn, ["s1"]);
    assert.deepEqual(steps[2]?.dependsOn, ["s2"]);
  });

  it("allows parallel-ready steps with explicit empty dependsOn", () => {
    const steps = buildPlanStepsFromSpecs([
      { title: "A", dependsOn: [] },
      { title: "B", dependsOn: [] },
      { title: "C", dependsOn: ["s1", "s2"], chainDefault: false },
    ]);
    assert.deepEqual(getReadySteps(steps).map((s) => s.id), ["s1", "s2"]);
    assert.deepEqual(getBlockedSteps(steps).map((b) => b.step.id), ["s3"]);
  });

  it("rejects cycles and unknown dependency ids", () => {
    const cycle = validatePlanStepGraph([
      { id: "s1", title: "a", status: "pending", dependsOn: ["s2"] },
      { id: "s2", title: "b", status: "pending", dependsOn: ["s1"] },
    ]);
    assert.equal(cycle.ok, false);

    assert.throws(() =>
      buildPlanStepsFromSpecs([
        { title: "A", dependsOn: ["s9"] },
        { title: "B", chainDefault: true },
      ]),
    );
  });

  it("rejects object steps from create_plan args (serial string[] only)", () => {
    const parsed = parseCreatePlanArgs({
      steps: [
        { title: "A", dependsOn: ["s9"] },
        "B",
      ],
    });
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /non-empty string/i);
  });

  it("strips self-edges when building from internal specs", () => {
    const steps = buildPlanStepsFromSpecs([
      { title: "Continue work", dependsOn: ["s1"] },
      { title: "Follow-up", dependsOn: ["s2", "s1"] },
      { title: "Wrap up", dependsOn: ["s2"] },
    ]);
    assert.equal(steps[0]?.id, "s1");
    assert.equal(steps[0]?.dependsOn, undefined);
    assert.deepEqual(steps[1]?.dependsOn, ["s1"]);
    assert.deepEqual(steps[2]?.dependsOn, ["s2"]);
  });

  it("blocks in_progress until deps complete and caps in_progress at 1", () => {
    const steps = buildPlanStepsFromSpecs([
      { title: "A", dependsOn: [] },
      { title: "B", dependsOn: ["s1"] },
    ]);
    const blocked = applyStepInProgress(steps, "s2");
    assert.equal(blocked.ok, false);

    const started = applyStepInProgress(
      steps.map((s) => (s.id === "s1" ? { ...s, status: "completed" as const } : s)),
      "s2",
    );
    assert.equal(started.ok, true);

    const parallel = buildPlanStepsFromSpecs([
      { title: "1", dependsOn: [] },
      { title: "2", dependsOn: [] },
    ]);
    const first = applyStepInProgress(parallel, "s1");
    assert.equal(first.ok, true);
    const second = applyStepInProgress(first.ok ? first.steps : parallel, "s2");
    assert.equal(second.ok, false);
  });
});
