/**
 * Behavior suite for the FSM graph benchmark scenarios (S1–S8).
 *
 * Asserts run semantics only — exit reason, visit-order invariants, scripted
 * reply delivery, session terminal state. All structural counters and token
 * estimates are delegated to graphBaseline.test.ts (single authority,
 * Review inventory #1), so engine optimizations never require edits here.
 *
 * Run this file only:
 *   node --import tsx --test src/agent/fsm/graphScenarios.test.ts
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  SCENARIOS,
  SCENARIO_NAMES,
  disposeBenchmarkEnv,
  initBenchmarkEnv,
  type ScenarioOutcome,
} from "./graphScenarios.js";

before(async () => {
  await initBenchmarkEnv();
});

after(async () => {
  await disposeBenchmarkEnv();
});

/**
 * Expected trajectories from the characterization probe (all-mock, fully
 * deterministic). These encode BEHAVIOR only; numbers live in the baseline.
 */
const EXPECTED_TRAJECTORY: Record<
  string,
  { exitReason: string; finalNodeId: string; visitOrder: string[] }
> = {
  S1_react_baseline: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "agent", "skill_reflect_gate", "end"],
  },
  S2_react_selfloop: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "agent", "agent", "skill_reflect_gate", "end"],
  },
  S3_v3_direct: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "analyser", "agent", "skill_reflect_gate", "end"],
  },
  S4_v3_plan_lane: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: [
      "start",
      "analyser",
      "plan_writer",
      "plan_reviewer",
      "skill_reflect_gate",
      "end",
    ],
  },
  S5_v3_validator_loop: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: [
      "start",
      "executor",
      "execution_validator",
      "executor",
      "skill_reflect_gate",
      "end",
    ],
  },
  S6_subagent_loop: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "subagent", "end"],
  },
  S7a_skill_reflect_eligible: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: [
      "start",
      "analyser",
      "skill_reflect_gate",
      "skill_reflector",
      "end",
    ],
  },
  S7b_skill_reflect_skip: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "analyser", "skill_reflect_gate", "end"],
  },
  S8_custom_graph_pipeline: {
    exitReason: "end_node",
    finalNodeId: "end",
    visitOrder: ["start", "agent", "skill_reflect_gate", "end"],
  },
};

function assertTrajectory(name: string, outcome: ScenarioOutcome): void {
  const expected = EXPECTED_TRAJECTORY[name];
  assert.ok(expected, `no expected trajectory registered for ${name}`);
  assert.equal(
    outcome.exitReason,
    expected.exitReason,
    `${name}: exit reason drifted`,
  );
  assert.equal(outcome.finalNodeId, expected.finalNodeId, `${name}: final node`);
  assert.deepEqual(
    outcome.metrics.visitOrder,
    expected.visitOrder,
    `${name}: node visit order drifted`,
  );
}

describe("FSM graph benchmark scenarios — behavior", () => {
  for (const name of SCENARIO_NAMES) {
    it(`${name} follows its characterized trajectory`, async () => {
      const outcome = await SCENARIOS[name]!();
      assertTrajectory(name, outcome);

      // Cross-cutting behavioral invariants.
      if (outcome.session) {
        assert.equal(
          outcome.session.status,
          "idle",
          `${name}: session must finish idle`,
        );
      }
      switch (name) {
        case "S1_react_baseline":
        case "S8_custom_graph_pipeline":
          assert.match(outcome.tailText ?? "", /benchmark|Custom graph/);
          break;
        case "S6_subagent_loop":
          assert.equal(outcome.tailText, "Child done.");
          break;
        case "S3_v3_direct":
          assert.equal(outcome.activeRoleAfter, "agent");
          break;
        case "S4_v3_plan_lane":
          assert.equal(outcome.activeRoleAfter, "plan_reviewer");
          assert.equal(outcome.session?.phase, "review");
          assert.equal(outcome.session?.planDoc?.approvalPending, true);
          break;
        case "S5_v3_validator_loop":
          assert.equal(outcome.activeRoleAfter, "executor");
          assert.equal(outcome.session?.phase, "executing");
          assert.equal(
            outcome.session?.plan?.steps.find((s) => s.id === "s1")?.status,
            "completed",
            "validator must commit claimed step s1",
          );
          break;
        case "S7a_skill_reflect_eligible":
          assert.ok(
            outcome.metrics.visitOrder.includes("skill_reflector"),
            "eligible branch must pass through skill_reflector",
          );
          break;
        case "S7b_skill_reflect_skip":
          assert.ok(
            !outcome.metrics.visitOrder.includes("skill_reflector"),
            "skip branch must bypass skill_reflector",
          );
          break;
        case "S2_react_selfloop":
          // Loop shape already covered by the trajectory assertion.
          break;
      }
    });
  }

  it("characterization table covers every scenario", () => {
    for (const name of SCENARIO_NAMES) {
      assert.ok(
        EXPECTED_TRAJECTORY[name],
        `missing EXPECTED_TRAJECTORY entry for ${name}`,
      );
    }
  });
});
