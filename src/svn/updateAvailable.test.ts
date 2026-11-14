import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { svnRevisionIsBehind } from "./updateAvailable.js";

describe("svnRevisionIsBehind", () => {
  it("is behind only when HEAD is a newer revision", () => {
    assert.equal(svnRevisionIsBehind("100", "128"), true);
    assert.equal(svnRevisionIsBehind("128", "128"), false);
    assert.equal(svnRevisionIsBehind("130", "128"), false);
  });

  it("ignores blank or non-numeric output", () => {
    assert.equal(svnRevisionIsBehind("", "10"), false);
    assert.equal(svnRevisionIsBehind("10", "HEAD"), false);
  });
});
