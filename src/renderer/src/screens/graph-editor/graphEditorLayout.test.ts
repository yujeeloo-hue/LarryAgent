import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { layoutFsmGraph, type FsmLayoutInputGraph } from "../../dev-tools/fsmLayout.js";
import { layoutForEditor } from "./graphEditorLayout.js";

function graph(): FsmLayoutInputGraph {
  return {
    entryNodeId: "start",
    terminalNodeId: "end",
    nodes: [
      { id: "start", selfLoop: false, actionTypes: [] },
      { id: "a", selfLoop: false, actionTypes: [] },
      { id: "b", selfLoop: false, actionTypes: [] },
      { id: "end", selfLoop: false, actionTypes: [] },
    ],
    edges: [
      { from: "start", to: "a", type: "EdgeAlways" },
      { from: "a", to: "b", type: "EdgeAlways" },
      { from: "b", to: "end", type: "EdgeAlways" },
      // Back edge drives corridor routing (bottom bus polyline).
      { from: "b", to: "a", type: "EdgeWhen", when: "retry" },
    ],
  };
}

describe("layoutForEditor edge routing", () => {
  it("keeps the viewer corridor routing while no manual layout exists", () => {
    const viewer = layoutFsmGraph(graph());
    const { layout, nodeLayout } = layoutForEditor(graph(), undefined);

    // Node positions identical to the viewer layout.
    for (const node of viewer.nodes) {
      assert.deepEqual(nodeLayout[node.id], { x: node.x, y: node.y });
    }
    // Edge paths + kinds identical (corridor routing, not follow-bezier).
    assert.equal(layout.edges.length, viewer.edges.length);
    for (const edge of viewer.edges) {
      const match = layout.edges.find(
        (e) => e.from === edge.from && e.to === edge.to,
      );
      assert.ok(match, `missing edge ${edge.from}→${edge.to}`);
      assert.equal(match.path, edge.path);
      assert.equal(match.kind, edge.kind);
    }
    const back = viewer.edges.find((e) => e.kind === "back");
    assert.ok(back, "fixture must contain a back edge");
  });

  it("treats an empty manual layout map as auto", () => {
    const { layout } = layoutForEditor(graph(), {});
    const viewer = layoutFsmGraph(graph());
    for (const edge of viewer.edges) {
      const match = layout.edges.find(
        (e) => e.from === edge.from && e.to === edge.to,
      );
      assert.ok(match);
      assert.equal(match.path, edge.path);
    }
  });

  it("switches to follow-the-node Blueprint wires once positions are pinned", () => {
    const manual = {
      start: { x: 40, y: 40 },
      a: { x: 260, y: 20 },
      b: { x: 480, y: 90 },
      end: { x: 700, y: 40 },
    };
    const { layout, nodeLayout } = layoutForEditor(graph(), manual);

    for (const [id, pos] of Object.entries(manual)) {
      assert.deepEqual(nodeLayout[id], pos);
    }
    // Semantic kinds survive manual arrangement (no forward collapse).
    const viewer = layoutFsmGraph(graph());
    for (const v of viewer.edges) {
      const match = layout.edges.find(
        (e) => e.from === v.from && e.to === v.to,
      );
      assert.ok(match, `missing edge ${v.from}→${v.to}`);
      assert.equal(match.kind, v.kind);
    }
    for (const edge of layout.edges) {
      // Blueprint path starts at the from-node's right edge center.
      const nums = edge.path.match(/-?[\d.]+/g)!.map(Number);
      const from = layout.nodes.find((n) => n.id === edge.from)!;
      assert.equal(nums[0], from.x + from.w);
      assert.equal(nums[1], from.y + from.h / 2);
    }
  });

  it("seeds missing node positions from the auto layout when partially pinned", () => {
    const { nodeLayout } = layoutForEditor(graph(), { a: { x: 500, y: 300 } });
    assert.deepEqual(nodeLayout.a, { x: 500, y: 300 });
    assert.ok(nodeLayout.b);
    assert.notEqual(nodeLayout.b!.x, 500);
  });
});
