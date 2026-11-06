import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fitGraphInViewport,
  fitHeightScale,
  layoutFsmGraph,
  type FsmEdgeGeom,
  type FsmLayout,
  type FsmLayoutInputGraph,
  type Pt,
} from "./fsmLayout.js";
import { graphConfigForMode } from "../../../agent/fsm/FsmGraphWorkflow.js";

function graph(
  overrides: Partial<FsmLayoutInputGraph> = {},
): FsmLayoutInputGraph {
  return {
    entryNodeId: "start",
    terminalNodeId: "end",
    nodes: [
      { id: "start", selfLoop: false, actionTypes: [] },
      { id: "end", selfLoop: false, actionTypes: [] },
    ],
    edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    ...overrides,
  };
}

// —— Geometry sampling helpers ——

function cubicAt(t: number, p0: Pt, c1: Pt, c2: Pt, p1: Pt): Pt {
  const u = 1 - t;
  const b0 = u * u * u;
  const b1 = 3 * u * u * t;
  const b2 = 3 * u * t * t;
  const b3 = t * t * t;
  return {
    x: b0 * p0.x + b1 * c1.x + b2 * c2.x + b3 * p1.x,
    y: b0 * p0.y + b1 * c1.y + b2 * c2.y + b3 * p1.y,
  };
}

function sampleGeom(geom: FsmEdgeGeom, steps = 64): Pt[] {
  if (geom.type === "poly") {
    const out: Pt[] = [];
    for (let i = 0; i < geom.pts.length - 1; i += 1) {
      const a = geom.pts[i]!;
      const b = geom.pts[i + 1]!;
      for (let j = 0; j < steps; j += 1) {
        const t = j / steps;
        out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    out.push(geom.pts[geom.pts.length - 1]!);
    return out;
  }
  return Array.from({ length: steps + 1 }, (_, i) =>
    cubicAt(i / steps, geom.p0, geom.c1, geom.c2, geom.p1),
  );
}

/** Occlusion invariant: no sample (endpoint-adjacent points excluded)
 *  lands inside any node rect inflated by 1px. */
function assertNoOcclusion(layout: FsmLayout): void {
  for (const edge of layout.edges) {
    const samples = sampleGeom(edge.geom);
    const first = samples[0]!;
    const last = samples[samples.length - 1]!;
    for (const p of samples) {
      if (Math.hypot(p.x - first.x, p.y - first.y) < 6) continue;
      if (Math.hypot(p.x - last.x, p.y - last.y) < 6) continue;
      for (const n of layout.nodes) {
        const inside =
          p.x > n.x - 1 &&
          p.x < n.x + n.w + 1 &&
          p.y > n.y - 1 &&
          p.y < n.y + n.h + 1;
        assert.ok(
          !inside,
          `edge ${edge.from}→${edge.to} sample (${p.x.toFixed(1)}, ${p.y.toFixed(1)}) inside node ${n.id} (${n.x}..${n.x + n.w}, ${n.y}..${n.y + n.h})`,
        );
      }
    }
  }
}

/** Lane invariant: same-side edges sharing a lane keep disjoint lane runs. */
function assertLanesDisjoint(layout: FsmLayout): void {
  const byLane = new Map<string, Array<{ lo: number; hi: number; e: string }>>();
  for (const edge of layout.edges) {
    if (edge.busSide === undefined || edge.geom.type !== "poly") continue;
    const pts = edge.geom.pts;
    const a = pts[2]!;
    const b = pts[3]!;
    const key = `${edge.busSide}#${edge.lane}`;
    const list = byLane.get(key) ?? [];
    list.push({
      lo: Math.min(a.x, b.x),
      hi: Math.max(a.x, b.x),
      e: `${edge.from}→${edge.to}`,
    });
    byLane.set(key, list);
  }
  for (const [key, list] of byLane) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i]!;
        const b = list[j]!;
        assert.ok(
          a.lo > b.hi + 2 || a.hi < b.lo - 2,
          `lane ${key}: ${a.e} [${a.lo.toFixed(0)},${a.hi.toFixed(0)}] overlaps ${b.e} [${b.lo.toFixed(0)},${b.hi.toFixed(0)}]`,
        );
      }
    }
  }
}

/** Slot invariant: same node + same side endpoints are distinct and spaced. */
function assertSideSlotsSpaced(layout: FsmLayout): void {
  const sides = new Map<string, number[]>();
  const record = (key: string, y: number): void => {
    const list = sides.get(key) ?? [];
    list.push(y);
    sides.set(key, list);
  };
  for (const edge of layout.edges) {
    const g = edge.geom;
    if (g.type === "self") continue;
    if (g.type === "poly") {
      const p0 = g.pts[0]!;
      const p1 = g.pts[g.pts.length - 1]!;
      const src = layout.nodes.find((n) => n.id === edge.from)!;
      const dst = layout.nodes.find((n) => n.id === edge.to)!;
      record(
        `${edge.from}|${Math.abs(p0.x - (src.x + src.w)) < 1 ? "R" : "L"}`,
        p0.y,
      );
      record(`${edge.to}|L`, p1.y);
      continue;
    }
    const src = layout.nodes.find((n) => n.id === edge.from)!;
    const dst = layout.nodes.find((n) => n.id === edge.to)!;
    record(
      `${edge.from}|${Math.abs(g.p0.x - (src.x + src.w)) < 1 ? "R" : "L"}`,
      g.p0.y,
    );
    record(
      `${edge.to}|${Math.abs(g.p1.x - dst.x) < 1 ? "L" : "R"}`,
      g.p1.y,
    );
  }
  for (const [key, ys] of sides) {
    if (ys.length < 2) continue;
    const sorted = [...ys].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(
        sorted[i]! - sorted[i - 1]! >= 4,
        `side ${key}: slot y gap ${sorted[i]! - sorted[i - 1]!} < 4`,
      );
    }
  }
}

describe("fsm layout layering", () => {
  it("linear graph layers left to right and classifies forward edges", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "worker", selfLoop: false, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "worker", type: "EdgeAlways" },
          { from: "worker", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    const layers = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    assert.equal(layers.get("start"), 0);
    assert.equal(layers.get("worker"), 1);
    assert.equal(layers.get("end"), 2);
    assert.ok(layout.edges.every((edge) => edge.kind === "forward"));
    const xs = new Map(layout.nodes.map((n) => [n.id, n.x]));
    assert.ok((xs.get("start") ?? 0) < (xs.get("worker") ?? 0));
    assert.ok((xs.get("worker") ?? 0) < (xs.get("end") ?? 0));
    assertNoOcclusion(layout);
  });

  it("breaks cycles: back edge detected, layering terminates, routed below", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "a", selfLoop: false, actionTypes: [] },
          { id: "b", selfLoop: false, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "a", type: "EdgeAlways" },
          { from: "a", to: "b", type: "EdgeAlways" },
          { from: "b", to: "a", type: "EdgeWhen", when: "routeTarget=a" },
          { from: "b", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    const layers = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    assert.equal(layers.get("start"), 0);
    assert.equal(layers.get("a"), 1);
    assert.equal(layers.get("b"), 2);
    const back = layout.edges.find(
      (edge) => edge.from === "b" && edge.to === "a",
    );
    assert.equal(back?.kind, "back");
    assert.equal(back?.when, "routeTarget=a");
    assert.equal(back?.busSide, "bottom");
    // Back lane sits strictly below every node row.
    for (const n of layout.nodes) {
      if (back?.geom.type === "poly") {
        assert.ok(
          back.geom.pts[3]!.y > n.y + n.h,
          `back lane ${back.geom.pts[3]!.y} must sit below node ${n.id} (${n.y + n.h})`,
        );
      }
    }
    assertNoOcclusion(layout);
    assertSideSlotsSpaced(layout);
  });

  it("self loops are classified, arced above the node, never affect layering", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "loop", selfLoop: true, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "loop", type: "EdgeAlways" },
          { from: "loop", to: "loop", type: "EdgeWhen", when: "self" },
          { from: "loop", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    const selfEdge = layout.edges.find((edge) => edge.kind === "self");
    assert.ok(selfEdge);
    assert.equal(selfEdge.from, "loop");
    assert.equal(selfEdge.to, "loop");
    const layers = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    assert.equal(layers.get("loop"), 1);
    assert.equal(layers.get("end"), 2);
    // Arc apex clears the node top.
    if (selfEdge.geom.type === "self") {
      const apex = cubicAt(0.5, selfEdge.geom.p0, selfEdge.geom.c1, selfEdge.geom.c2, selfEdge.geom.p1);
      const loop = layout.nodes.find((n) => n.id === "loop")!;
      assert.ok(apex.y < loop.y - 1);
    }
    assertNoOcclusion(layout);
  });

  it("terminal node is pinned to the rightmost layer", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "a", selfLoop: false, actionTypes: [] },
          { id: "b", selfLoop: false, actionTypes: [] },
          { id: "c", selfLoop: false, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "end", type: "EdgeAlways" },
          { from: "start", to: "a", type: "EdgeAlways" },
          { from: "a", to: "b", type: "EdgeAlways" },
          { from: "b", to: "c", type: "EdgeAlways" },
        ],
      }),
    );
    const layers = new Map(layout.nodes.map((n) => [n.id, n.layer]));
    assert.equal(layers.get("c"), 3);
    assert.equal(layers.get("end"), 3);
    const skip = layout.edges.find(
      (edge) => edge.from === "start" && edge.to === "end",
    );
    assert.equal(skip?.kind, "forward");
    assert.equal(skip?.busSide, "top");
    assertNoOcclusion(layout);
    assertLanesDisjoint(layout);
  });

  it("merges parallel edges with joined when labels", () => {
    const layout = layoutFsmGraph(
      graph({
        edges: [
          {
            from: "start",
            to: "end",
            type: "EdgeWhen",
            when: "controlResult=discarded",
          },
          {
            from: "start",
            to: "end",
            type: "EdgeWhen",
            when: "controlResult=rejected",
          },
        ],
      }),
    );
    assert.equal(layout.edges.length, 1);
    assert.equal(
      layout.edges[0]?.when,
      "controlResult=discarded / controlResult=rejected",
    );
  });

  it("edges referencing unknown nodes are dropped", () => {
    const layout = layoutFsmGraph(
      graph({
        edges: [
          { from: "start", to: "ghost", type: "EdgeAlways" },
          { from: "phantom", to: "end", type: "EdgeAlways" },
          { from: "start", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    assert.equal(layout.edges.length, 1);
    assert.equal(layout.edges[0]?.from, "start");
    assert.equal(layout.edges[0]?.to, "end");
    const end = layout.nodes.find((n) => n.id === "end");
    assert.equal(end?.x + end?.w, layout.width - 28);
  });

  it("fan-out source distributes right-side slots without overlap", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "a", selfLoop: false, actionTypes: [] },
          { id: "b", selfLoop: false, actionTypes: [] },
          { id: "c", selfLoop: false, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "a", type: "EdgeAlways" },
          { from: "start", to: "b", type: "EdgeAlways" },
          { from: "start", to: "c", type: "EdgeAlways" },
          { from: "a", to: "end", type: "EdgeAlways" },
          { from: "b", to: "end", type: "EdgeAlways" },
          { from: "c", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    assertNoOcclusion(layout);
    assertSideSlotsSpaced(layout);
  });

  it("overlapping skip-forwards on the top bus get distinct lanes", () => {
    const layout = layoutFsmGraph(
      graph({
        nodes: [
          { id: "start", selfLoop: false, actionTypes: [] },
          { id: "m", selfLoop: false, actionTypes: [] },
          { id: "n", selfLoop: false, actionTypes: [] },
          { id: "end", selfLoop: false, actionTypes: [] },
        ],
        edges: [
          { from: "start", to: "m", type: "EdgeAlways" },
          { from: "m", to: "n", type: "EdgeAlways" },
          { from: "n", to: "end", type: "EdgeAlways" },
          { from: "start", to: "n", type: "EdgeAlways" },
          { from: "m", to: "end", type: "EdgeAlways" },
        ],
      }),
    );
    const skips = layout.edges.filter((e) => e.busSide === "top");
    assert.equal(skips.length, 2);
    assert.notEqual(skips[0]?.lane, skips[1]?.lane);
    assertNoOcclusion(layout);
    assertLanesDisjoint(layout);
  });

  it("width/height reflect the column grid", () => {
    const layout = layoutFsmGraph(graph());
    assert.ok(layout.width > 0 && layout.height > 0);
    const end = layout.nodes.find((n) => n.id === "end");
    assert.equal(end?.x + end?.w, layout.width - 28);
  });
});

describe("fsm layout real graphs (acceptance)", () => {
  for (const mode of [
    "react",
    "react_v2",
    "ask",
    "plan_execute",
    "subagent",
  ] as const) {
    it(`${mode}: no occlusion, disjoint lanes, spaced slots`, () => {
      const layout = layoutFsmGraph(
        graphConfigForMode(mode) as unknown as FsmLayoutInputGraph,
      );
      assert.ok(layout.nodes.length > 0);
      assertNoOcclusion(layout);
      assertLanesDisjoint(layout);
      assertSideSlotsSpaced(layout);
    });
  }
});

describe("fsm layout fit scaling", () => {
  it("returns 1 when the layout already fits", () => {
    const layout = layoutFsmGraph(graph());
    assert.equal(fitHeightScale(layout, layout.height + 100), 1);
  });

  it("scales down proportionally when too tall", () => {
    const layout = layoutFsmGraph(graph());
    const scale = fitHeightScale(layout, layout.height / 2);
    assert.ok(Math.abs(scale - 0.5) < 1e-9);
  });
});

describe("fsm camera fitGraphInViewport", () => {
  it("centers a smaller graph without scaling up", () => {
    const cam = fitGraphInViewport(
      { width: 200, height: 100 },
      { width: 800, height: 400 },
      16,
    );
    assert.ok(cam);
    assert.equal(cam!.scale, 1);
    assert.equal(cam!.panX, (800 - 200) / 2);
    assert.equal(cam!.panY, (400 - 100) / 2);
  });

  it("scales down a wide graph and keeps equal left/right margins", () => {
    const cam = fitGraphInViewport(
      { width: 2000, height: 200 },
      { width: 800, height: 400 },
      16,
    );
    assert.ok(cam);
    const inner = 800 - 32;
    assert.ok(Math.abs(cam!.scale - inner / 2000) < 1e-9);
    const scaledW = 2000 * cam!.scale;
    assert.ok(Math.abs(cam!.panX - (800 - scaledW) / 2) < 1e-9);
    assert.ok(Math.abs(cam!.panX - (800 - scaledW - cam!.panX)) < 1e-9);
  });

  it("returns null when the viewport is not laid out yet", () => {
    assert.equal(
      fitGraphInViewport({ width: 200, height: 100 }, { width: 0, height: 400 }, 16),
      null,
    );
  });
});
