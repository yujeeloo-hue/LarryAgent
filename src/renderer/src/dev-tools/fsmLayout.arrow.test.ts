/**
 * edgeArrowSegment — epsilon arrow-carrier segment along an edge's end
 * tangent (bezier + corridor path forms).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { edgeArrowSegment } from "./fsmLayout.js";

describe("edgeArrowSegment", () => {
  it("follows the horizontal tangent of an editor bezier", () => {
    // Ends at (300, 50), last control point (260, 50) → +x direction.
    const d = "M 100 50 C 140 50, 260 50, 300 50";
    const seg = edgeArrowSegment(d);
    assert.ok(seg);
    assert.match(seg!, /^M 299\.99 50 L 300 50$/);
  });

  it("follows the end direction of a corridor polyline", () => {
    // Final segment goes up-left: (120, 80) → (100, 60).
    const d = "M 20 20 L 60 20 Q 68 20 68 28 L 68 60 L 120 80 L 100 60";
    const seg = edgeArrowSegment(d);
    assert.ok(seg);
    // Unit vector of (-20,-20) is (-0.7071…): 100 + 0.00707 ≈ 100.007.
    assert.match(seg!, /^M 100\.0070\d* 60\.0070\d* L 100 60$/);
  });

  it("falls back to horizontal for degenerate last points", () => {
    const seg = edgeArrowSegment("M 10 10 L 10 10");
    assert.ok(seg);
    assert.match(seg!, /^M 9\.99 10 L 10 10$/);
  });

  it("returns null for paths without two points", () => {
    assert.equal(edgeArrowSegment("M 10 10"), null);
    assert.equal(edgeArrowSegment(""), null);
  });
});
