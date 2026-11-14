import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { migrateFSMGraphConfig } from "./actionTypeMigration.js";
import { NodeActionRoleRoundBuilder } from "./actions/NodeActionRoleRoundBuilder.js";
import {
  createAskGraphConfig,
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { createDefaultGraphConfig } from "./graphLibrary/defaultGraph.js";
import { validateGraphConfig } from "./graphLibrary/manager.js";

const removed = new Set([
  "NodeActionWriteTurnMemory",
  "NodeActionRecallTurnMemory",
]);

describe("JTimeCapsule integration removal", () => {
  it("omits memory actions from every new built-in graph", () => {
    for (const graph of [
      createDefaultGraphConfig(),
      createReactGraphConfig(),
      createAskGraphConfig(),
      createPlanExecuteV3GraphConfig(),
      createSubagentGraphConfig(),
    ]) {
      for (const node of graph.nodes) {
        assert.ok((node.actions ?? []).every((action) => !removed.has(action.type)));
      }
    }
  });

  it("removes memory actions from saved custom graphs", () => {
    const graph = createDefaultGraphConfig();
    const legacy = {
      ...graph,
      version: 1,
      nodes: graph.nodes.map((node) => ({
        ...node,
        actions: [
          ...(node.actions ?? []),
          { type: "NodeActionRecallTurnMemory", params: {} },
          { type: "NodeActionWriteTurnMemory", params: {} },
        ],
      })),
    };
    const migrated = migrateFSMGraphConfig(legacy);
    for (const node of migrated.nodes) {
      assert.ok((node.actions ?? []).every((action) => !removed.has(action.type)));
    }
    validateGraphConfig(migrated);
  });

  it("does not run a default model round when old composite steps contained only memory actions", async () => {
    const config = createDefaultGraphConfig();
    config.nodes[0]!.actions = [{ type: "NodeActionRoleRoundBuilder", params: {
      steps: [{ type: "NodeActionRecallTurnMemory", params: {} }],
    } }];
    const migrated = migrateFSMGraphConfig({ ...config, version: 1 });
    const action = new NodeActionRoleRoundBuilder(migrated.nodes[0]!.actions![0]!.params);
    const result = await action.Exec({ turnContext: {}, nodeContext: {} });
    assert.equal(result.status, "continue");
    assert.deepEqual(result.turnContextPatch, {});
    assert.deepEqual(result.nodeContextPatch, {});
  });
});
