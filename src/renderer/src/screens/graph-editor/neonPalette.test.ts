import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NEON_PALETTE } from "./neonPalette.js";

describe("neonPalette", () => {
  it("holds exactly 64 unique valid #rrggbb colors", () => {
    assert.equal(NEON_PALETTE.length, 64);
    assert.equal(new Set(NEON_PALETTE).size, 64);
    for (const color of NEON_PALETTE) {
      assert.match(color, /^#[0-9a-f]{6}$/);
    }
  });

  it("anchors: systematic grid ends match the generated banks", () => {
    // Bank 1 row 1 starts pink, bank 2 row 4 ends yellow (bright→dark ramp).
    assert.equal(NEON_PALETTE[0], "#ff8095");
    assert.equal(NEON_PALETTE[NEON_PALETTE.length - 1], "#f5f500");
  });
});
