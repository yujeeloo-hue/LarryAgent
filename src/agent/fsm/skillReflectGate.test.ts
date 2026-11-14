/**
 * skill_reflect_gate eligibility: whole-turn iterations (not the budget
 * counter), recovered errors, long runs and skill reads.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { createReactGraphConfig } from "./configs/sampleGraphs.js";
import { FSMGraph } from "./FSMGraph.js";
import {
  makeFakeHost,
  makeScope,
  makeSession,
  makeTurnInput,
} from "./graphScenariosFixtures.js";
import type { TurnHostCounters } from "../turnHost/types.js";

async function visitsReflector(
  counters: Partial<TurnHostCounters>,
  autoSkillSummarize = true,
): Promise<boolean> {
  const session = makeSession({ id: `gate-${Math.random()}` });
  const { host } = makeFakeHost({
    session,
    rounds: [{ text: "Done." }, { text: "Nothing to save." }],
    counterSeed: counters,
  });
  const result = await FSMGraph.run(
    createReactGraphConfig(),
    { turnScope: makeScope(session, "agent") },
    {
      registries: createDefaultActionRegistry(),
      host,
      turnInput: makeTurnInput(session, { autoSkillSummarize }),
    },
  );
  assert.equal(result.reason, "end_node");
  return result.nodesVisited.includes("skill_reflector");
}

describe("skill reflect gate eligibility", () => {
  it("skips an ordinary short turn", async () => {
    assert.equal(await visitsReflector({ turnModelIterations: 3 }), false);
  });

  it("enters after a recovered error in a turn longer than 8 iterations", async () => {
    assert.equal(
      await visitsReflector({ turnModelIterations: 9, toolErrorCount: 1, toolRecoveryCount: 1 }),
      true,
    );
  });

  it("ignores denials and unrecovered errors", async () => {
    assert.equal(
      await visitsReflector({ turnModelIterations: 12, toolFailureCount: 5, toolErrorCount: 2 }),
      false,
    );
  });

  it("uses whole-turn iterations even when the budget counter was reset", async () => {
    assert.equal(
      await visitsReflector({ modelIterations: 1, turnModelIterations: 9, toolRecoveryCount: 1 }),
      true,
    );
    assert.equal(
      await visitsReflector({ modelIterations: 30, turnModelIterations: 3, toolRecoveryCount: 1 }),
      false,
    );
  });

  it("enters on a long run without failures", async () => {
    assert.equal(await visitsReflector({ turnModelIterations: 20 }), true);
  });

  it("enters when a skill was read", async () => {
    assert.equal(await visitsReflector({ turnModelIterations: 2, skillsReadCount: 1 }), true);
  });

  it("stays closed when Self-learning is off", async () => {
    assert.equal(await visitsReflector({ turnModelIterations: 30, skillsReadCount: 2 }, false), false);
  });
});
