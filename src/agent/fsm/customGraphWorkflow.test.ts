import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FsmGraphWorkflow } from "./FsmGraphWorkflow.js";
import { createReactGraphConfig } from "./configs/sampleGraphs.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { FSMGraph } from "./FSMGraph.js";
import { resolveCustomFsmGraphForTurn } from "./graphLibrary/manager.js";
import type { FsmGraphLibraryRecord } from "./graphLibrary/types.js";
import type { FSMGraphConfig } from "./types.js";
import { createFSMGraphConfig } from "./types.js";
import { createTurnHost } from "../turnHost/createTurnHost.js";
import { makeSession, makeTurnInput } from "./graphScenariosFixtures.js";

describe("FsmGraphWorkflow custom config", () => {
  it("runs a v1 configured graph through the compatibility boundary", async () => {
    const session = makeSession();
    const input = makeTurnInput(session);
    const config = { ...createFSMGraphConfig({
      entryNodeId: "review", nodes: [
        { id: "review", actions: [{ type: "NodeActionBumpReplanCount" }] }, { id: "end" },
      ], edges: [{ from: "review", to: "end", type: "EdgeAlways" }],
    }), version: 1 as const };
    const workflow = new FsmGraphWorkflow({ mode: "ask", graphConfig: config });
    const host = createTurnHost({ ...input, runChildTurn: async () => { throw new Error("unexpected child turn"); } });
    assert.deepEqual(await workflow.run(host, input), { status: "idle", modelIterations: 0 });
    assert.equal(config.nodes[0]!.actions![0]!.type, "NodeActionBumpReplanCount");
  });
  it("runs an explicit graphConfig to end (ignores mode builtin)", async () => {
    const config = createReactGraphConfig();
    const workflow = new FsmGraphWorkflow({
      mode: "ask",
      graphConfig: config,
    });
    assert.equal(workflow.mode, "ask");
    const result = await FSMGraph.run(config, {}, {
      registries: createDefaultActionRegistry(),
    });
    assert.equal(result.reason, "end_node");
  });
});

describe("resolveCustomFsmGraphForTurn", () => {
  const validConfig = (): FSMGraphConfig => createReactGraphConfig();

  it("rejects missing graph id", async () => {
    await assert.rejects(
      () => resolveCustomFsmGraphForTurn(null, async () => null),
      /requires a saved FSM graph/,
    );
    await assert.rejects(
      () => resolveCustomFsmGraphForTurn("   ", async () => null),
      /requires a saved FSM graph/,
    );
  });

  it("rejects unknown graph id", async () => {
    await assert.rejects(
      () =>
        resolveCustomFsmGraphForTurn("missing-id", async () => null),
      /Custom FSM graph not found: missing-id/,
    );
  });

  it("returns validated config for a known graph", async () => {
    const config = validConfig();
    const record: FsmGraphLibraryRecord = {
      id: "g1",
      name: "Test",
      createdAt: 1,
      updatedAt: 1,
      config,
      origin: "user",
      enabled: true,
    };
    const resolved = await resolveCustomFsmGraphForTurn("g1", async (id) => {
      assert.equal(id, "g1");
      return record;
    });
    assert.equal(resolved.id, "g1");
    assert.ok(resolved.config.nodes.length > 0);
  });
});
