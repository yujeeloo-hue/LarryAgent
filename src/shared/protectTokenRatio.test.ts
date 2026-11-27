import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isValidProtectTokenRatio,
  parseProtectTokenRatioArg,
  PROTECT_TOKEN_RATIO_MAX,
} from "./protectTokenRatio.js";

describe("isValidProtectTokenRatio (shared bounds)", () => {
  it("accepts ratios within (0, 0.9]", () => {
    assert.equal(isValidProtectTokenRatio(0.01), true);
    assert.equal(isValidProtectTokenRatio(0.05), true);
    assert.equal(isValidProtectTokenRatio(0.2), true);
    assert.equal(isValidProtectTokenRatio(PROTECT_TOKEN_RATIO_MAX), true);
  });

  it("rejects zero, negatives, above max, non-finite, and non-numbers", () => {
    for (const bad of [
      0,
      -0.1,
      0.91,
      1,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      "0.1",
      null,
      undefined,
    ]) {
      assert.equal(isValidProtectTokenRatio(bad), false);
    }
  });
});

describe("parseProtectTokenRatioArg (/compact <keep>)", () => {
  it("parses plain decimal ratios in bounds", () => {
    assert.equal(parseProtectTokenRatioArg("0.1"), 0.1);
    assert.equal(parseProtectTokenRatioArg(".5"), 0.5);
    assert.equal(parseProtectTokenRatioArg("  0.35  "), 0.35);
    assert.equal(parseProtectTokenRatioArg("0.9"), 0.9);
  });

  it("rejects out-of-bounds numbers, exponent form, flags, and prose", () => {
    for (const bad of [
      "0",
      "0.95",
      "10",
      "1e-1",
      "0.1x",
      "x0.1",
      "--force",
      "keep 0.1",
      "",
      "   ",
    ]) {
      assert.equal(parseProtectTokenRatioArg(bad), null, bad);
    }
  });
});
