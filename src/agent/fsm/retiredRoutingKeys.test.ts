/**
 * Retired-routing guard: the legacy control-plane vocabulary is gone for
 * good. All four graphs are V3-shaped (self-contained role rounds + semantic
 * routeTarget edges, node source); shared Actions are semantic-only.
 *
 * This file is the single legal home for the retired literals — other test
 * files must not reference them.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createAskGraphConfig,
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { FSMGraph } from "./FSMGraph.js";

const RETIRED_NODE_IDS = [
  "loop_head",
  "router",
  "run_tools",
  "await_batches",
  "skill_reflect_head",
  "skill_reflect",
  "skill_reflect_router",
  "skill_run_tools",
];

const RETIRED_TURN_KEYS = [
  "routerBranch",
  "fsmContinue",
  "skillReflectBranch",
  "loopHeadPassed",
  "awaitWait",
];

/** Edge turnKeys retired by the pin model (docs/fsm-pins.md D3). */
const RETIRED_EDGE_KEYS = ["controlResult", "activeRole"];

const RETIRED_ACTION_TYPES = [
  "NodeActionLoopHead",
  "NodeActionSkillReflectHead",
  "NodeActionPreferSkills",
  "NodeActionPrepareSkillReflect",
  "NodeActionSkillReflectRound",
  "NodeActionRouteSkillReflect",
  "NodeActionRouteAfterRound",
  "NodeActionApplyPlanEffects",
  "NodeActionEnsurePlanInProgress",
  "NodeActionRouteToWhen",
  "NodeActionRouteToIf",
  "NodeActionAdvanceRole",
  "NodeActionRoundHead",
];

const GRAPH_FACTORIES = [
  ["react", createReactGraphConfig] as const,
  ["ask", createAskGraphConfig] as const,
  ["subagent", createSubagentGraphConfig] as const,
  ["plan_execute", createPlanExecuteV3GraphConfig] as const,
];

describe("retired routing vocabulary (four graphs are V3-shaped)", () => {
  for (const [name, factory] of GRAPH_FACTORIES) {
    it(`${name}: zero control nodes`, () => {
      const config = factory();
      const ids = new Set(config.nodes.map((n) => n.id));
      for (const retired of RETIRED_NODE_IDS) {
        assert.ok(!ids.has(retired), `${name} must not contain "${retired}"`);
      }
    });

    it(`${name}: no edge keys on retired turn signals`, () => {
      const config = factory();
      for (const edge of config.edges) {
        const key = (edge.params as { turnKey?: string } | undefined)?.turnKey;
        assert.ok(
          key === undefined || !RETIRED_TURN_KEYS.includes(key),
          `${name} edge ${edge.from}→${edge.to} keys on retired signal "${key}"`,
        );
        assert.ok(
          key === undefined || !RETIRED_EDGE_KEYS.includes(key),
          `${name} edge ${edge.from}→${edge.to} uses retired edge key "${key}" (use routeTarget + pin.name)`,
        );
      }
    });

    it(`${name}: routing nodes declare pins when they emit routeTarget edges`, () => {
      const config = factory();
      const nodesWithRouteEdges = new Set(
        config.edges
          .filter(
            (e) =>
              e.type === "EdgeWhen" &&
              (e.params as { turnKey?: string })?.turnKey === "routeTarget",
          )
          .map((e) => e.from),
      );
      for (const node of config.nodes) {
        if (!nodesWithRouteEdges.has(node.id)) continue;
        assert.ok(
          (node.pins?.length ?? 0) > 0,
          `${name} node "${node.id}" has routeTarget edges but no pins`,
        );
      }
    });
  }

  it("registry: legacy gate/head Actions are unregistered", () => {
    const catalog = createDefaultActionRegistry().listActionCatalog();
    for (const type of RETIRED_ACTION_TYPES) {
      assert.ok(
        !catalog.some((c) => c.type === type),
        `${type} must not be registered`,
      );
    }
  });

  it("react stub turn: retired turn keys never written", async () => {
    const result = await FSMGraph.run(
      createReactGraphConfig(),
      { stubForceToolCalls: true },
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    for (const key of [...RETIRED_TURN_KEYS, "toolsRan", "hasPendingToolCalls"]) {
      assert.equal(
        (result.turnContext as Record<string, unknown>)[key],
        undefined,
        `turnContext.${key} must never be written`,
      );
    }
  });
});
