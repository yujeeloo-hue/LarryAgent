import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  WIRE_DEFAULTS,
  blueprintEdgePath,
  blueprintPreviewPath,
  blueprintSelfLoopGeom,
  blueprintWireGeom,
  inPin,
  outPin,
} from "./wirePath.js";

const box = (x: number, y: number, w = 150, h = 46) => ({ x, y, w, h });

describe("blueprintWireGeom", () => {
  it("keeps tangents horizontal at both pins", () => {
    // Ascending wire: no sag bias, both tangents exactly horizontal.
    const g = blueprintWireGeom({ x: 200, y: 160 }, { x: 420, y: 100 });
    assert.equal(g.c1.y, g.p0.y);
    assert.equal(g.c2.y, g.p3.y);
    assert.ok(g.c1.x > g.p0.x);
    assert.ok(g.c2.x < g.p3.x);
  });

  it("clamps tangent length between minT and maxT", () => {
    const near = blueprintWireGeom({ x: 100, y: 0 }, { x: 120, y: 0 });
    assert.equal(near.c1.x - near.p0.x, WIRE_DEFAULTS.minT);

    const far = blueprintWireGeom({ x: 0, y: 0 }, { x: 2000, y: 0 });
    assert.equal(far.c1.x - far.p0.x, WIRE_DEFAULTS.maxT);
  });

  it("widens backward wires from the vertical delta", () => {
    // Target left of source, 200px below: tangent ≥ |Δy| × backFactor = 150.
    const g = blueprintWireGeom({ x: 400, y: 0 }, { x: 200, y: 200 });
    const m = g.c1.x - g.p0.x;
    assert.ok(m >= 200 * WIRE_DEFAULTS.backFactor);
    assert.ok(m >= WIRE_DEFAULTS.backMin);
    // Both tangents still extend outward (loop, not a crossing S).
    assert.ok(g.c1.x > g.p0.x);
    assert.ok(g.c2.x < g.p3.x);
  });

  it("droops control points downward for descending wires", () => {
    const g = blueprintWireGeom({ x: 0, y: 0 }, { x: 200, y: 100 });
    assert.ok(g.c1.y > g.p0.y);
    assert.ok(g.c2.y > g.p3.y);
    // Ascending wires stay flat.
    const up = blueprintWireGeom({ x: 0, y: 100 }, { x: 200, y: 0 });
    assert.equal(up.c1.y, up.p0.y);
  });
});

describe("blueprintSelfLoopGeom", () => {
  it("loops below the node between the side pins", () => {
    const n = box(0, 0);
    const g = blueprintSelfLoopGeom(n);
    assert.deepEqual(g.p0, outPin(n));
    assert.deepEqual(g.p3, inPin(n));
    assert.ok(g.c1.y > n.y + n.h);
    assert.ok(g.c2.y > n.y + n.h);
    assert.ok(g.c1.x > g.p0.x);
    assert.ok(g.c2.x < g.p3.x);
  });
});

describe("blueprintEdgePath", () => {
  it("routes a self edge through the below-node loop on identity", () => {
    const n = box(10, 20);
    const d = blueprintEdgePath(n, n);
    const self = blueprintSelfLoopGeom(n);
    assert.equal(d, `M ${self.p0.x} ${self.p0.y} C ${self.c1.x} ${self.c1.y}, ${self.c2.x} ${self.c2.y}, ${self.p3.x} ${self.p3.y}`);
  });

  it("uses pin anchors for distinct nodes", () => {
    const a = box(0, 0);
    const b = box(300, 100);
    const d = blueprintEdgePath(a, b);
    const nums = d.match(/-?[\d.]+/g)!.map(Number);
    assert.equal(nums[0], outPin(a).x);
    assert.equal(nums[1], outPin(a).y);
    assert.equal(nums[6], inPin(b).x);
    assert.equal(nums[7], inPin(b).y);
  });
});

describe("blueprintPreviewPath", () => {
  it("extends the out tangent even when the cursor is behind the pin", () => {
    const a = box(200, 0);
    const d = blueprintPreviewPath(a, { x: 50, y: 120 });
    const nums = d.match(/-?[\d.]+/g)!.map(Number);
    assert.equal(nums[0], outPin(a).x);
    assert.ok(nums[2] > nums[0]); // first control point still right of pin
  });
});
