import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  compileRouteWhenExpr,
  evaluateRouteWhenExpr,
  legacyWhenRowToExpr,
  validateRouteWhenExpr,
} from "./routeWhenExpr.js";

describe("routeWhenExpr", () => {
  it("evaluates && with higher precedence than ||", () => {
    const compiled = compileRouteWhenExpr("a && b || c");
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    assert.equal(compiled.eval({ a: true, b: false, c: true }), true);
    assert.equal(compiled.eval({ a: true, b: true, c: false }), true);
    assert.equal(compiled.eval({ a: false, b: false, c: false }), false);
  });

  it("supports parentheses", () => {
    const compiled = compileRouteWhenExpr("(a || b) && c");
    assert.equal(compiled.ok, true);
    if (!compiled.ok) return;
    assert.equal(compiled.eval({ a: false, b: true, c: true }), true);
    assert.equal(compiled.eval({ a: true, b: false, c: false }), false);
  });

  it("treats string true as truthy", () => {
    const out = evaluateRouteWhenExpr("flag", { flag: "true" }, "test");
    assert.deepEqual(out, { kind: "met", met: true });
  });

  it("legacyWhenRowToExpr converts allOf to &&", () => {
    assert.equal(
      legacyWhenRowToExpr({ allOf: ["a", "b"], to: "x" }),
      "a && b",
    );
  });

  it("validateRouteWhenExpr rejects bad syntax", () => {
    assert.match(
      validateRouteWhenExpr("a &&", "RouteTo") ?? "",
      /invalid when expression/,
    );
  });
});
