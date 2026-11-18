import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addAction,
  removeAction,
  reorderAction,
  removeWire,
  wireNodeToNode,
  type GraphConfigJson,
} from "./graphConfigEdit.js";

function bareGraph(): GraphConfigJson {
  return {
    version: 1,
    nodes: [
      { id: "start", pins: [], actions: [] },
      { id: "mid", pins: [], actions: [] },
      { id: "end", pins: [], actions: [] },
    ],
    edges: [],
  };
}

describe("removeWire", () => {
  it("drops pin + EdgeWhen for a wired pair", () => {
    let config = wireNodeToNode(bareGraph(), "start", "mid");
    assert.ok(config.edges.some((e) => e.from === "start" && e.to === "mid"));
    const start = config.nodes.find((n) => n.id === "start")!;
    assert.ok((start.pins ?? []).some((p) => p.name === "mid"));

    config = removeWire(config, "start", "mid");
    assert.equal(
      config.edges.some((e) => e.from === "start" && e.to === "mid"),
      false,
    );
    const after = config.nodes.find((n) => n.id === "start")!;
    assert.equal(
      (after.pins ?? []).some((p) => p.name === "mid"),
      false,
    );
  });
});

describe("reorderAction", () => {
  function graphWithActions(): GraphConfigJson {
    const config = addAction(
      addAction(
        addAction(bareGraph(), "start", "NodeActionWriteBlackboard"),
        "start",
        "NodeActionRoundGate",
      ),
      "start",
      "NodeActionRouteTo",
    );
    return config;
  }

  it("moves an action down (splice order, not swap)", () => {
    const next = reorderAction(graphWithActions(), "start", 0, 2);
    const actions = next.nodes.find((n) => n.id === "start")!.actions!;
    assert.deepEqual(
      actions.map((a) => a.type),
      ["NodeActionRoundGate", "NodeActionRouteTo", "NodeActionWriteBlackboard"],
    );
  });

  it("moves an action up", () => {
    const next = reorderAction(graphWithActions(), "start", 2, 0);
    const actions = next.nodes.find((n) => n.id === "start")!.actions!;
    assert.deepEqual(
      actions.map((a) => a.type),
      ["NodeActionRouteTo", "NodeActionWriteBlackboard", "NodeActionRoundGate"],
    );
  });

  it("same index / out-of-range are no-ops; other nodes untouched", () => {
    const before = graphWithActions();
    assert.deepEqual(reorderAction(before, "start", 1, 1), before);
    assert.deepEqual(reorderAction(before, "start", -1, 0), before);
    assert.deepEqual(reorderAction(before, "start", 0, 99), before);
    assert.deepEqual(reorderAction(before, "nope", 0, 1), before);
    const next = reorderAction(before, "start", 0, 1);
    assert.deepEqual(
      next.nodes.find((n) => n.id === "mid")!.actions ?? [],
      [],
    );
  });
});
