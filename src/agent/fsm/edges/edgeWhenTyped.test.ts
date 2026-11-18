import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EdgeEvalArgs } from "../types.js";
import {
  edgeWhenPredicateFromParams,
  edgeWhenTurnEqualsPredicate,
} from "./EdgeWhen.js";

function args(turn: Record<string, unknown>, node: Record<string, unknown> = {}) {
  return {
    edgeId: "e1",
    fromNodeId: "a",
    toNodeId: "b",
    turnContext: turn,
    nodeContext: node,
  };
}

describe("EdgeWhen typed comparison", () => {
  it("typed params route through the shared comparator", () => {
    const gt = edgeWhenPredicateFromParams({
      turnKey: "count",
      type: "int",
      operator: ">",
      value: 2,
    });
    assert.equal(gt(args({ count: 3 })), true);
    assert.equal(gt(args({ count: 2 })), false);
    assert.equal(gt(args({ count: "5" })), true);
  });

  it("float and string comparisons", () => {
    const ratio = edgeWhenPredicateFromParams({
      turnKey: "ratio",
      type: "float",
      operator: "<=",
      value: "0.5",
    });
    assert.equal(ratio(args({ ratio: 0.25 })), true);
    assert.equal(ratio(args({ ratio: 0.75 })), false);

    const state = edgeWhenPredicateFromParams({
      turnKey: "state",
      type: "string",
      operator: "==",
      value: "done",
    });
    assert.equal(state(args({ state: "done" })), true);
    assert.equal(state(args({ state: "pending" })), false);
  });

  it("source=node reads nodeContext, default reads turnContext", () => {
    const nodeSource = edgeWhenPredicateFromParams({
      turnKey: "sig",
      type: "string",
      operator: "==",
      value: "x",
      source: "node",
    });
    assert.equal(nodeSource(args({}, { sig: "x" })), true);
    assert.equal(nodeSource(args({ sig: "x" })), false);

    const turnSource = edgeWhenPredicateFromParams({
      turnKey: "sig",
      type: "string",
      operator: "==",
      value: "x",
    });
    assert.equal(turnSource(args({ sig: "x" })), true);
  });

  it("comparison errors eval to false (no-match handling surfaces them)", () => {
    const missing = edgeWhenPredicateFromParams({
      turnKey: "count",
      type: "int",
      operator: ">",
      value: 1,
    });
    assert.equal(missing(args({})), false);

    const malformed = edgeWhenPredicateFromParams({
      turnKey: "count",
      operator: ">",
      value: 1,
    });
    assert.equal(malformed(args({ count: 5 })), false);
  });

  it("legacy equals predicate is preserved when no typed params exist", () => {
    const legacy = edgeWhenPredicateFromParams({
      turnKey: "mode",
      equals: "fast",
    });
    assert.equal(legacy(args({ mode: "fast" })), true);
    assert.equal(legacy(args({ mode: "slow" })), false);

    const direct = edgeWhenTurnEqualsPredicate("mode", "fast");
    assert.equal(direct(args({ mode: "fast" })), true);
  });

  it("source=session reads session.phase with unlessNodeKey and incomplete plan", () => {
    const pred = edgeWhenPredicateFromParams({
      turnKey: "phase",
      equals: "executing",
      source: "session",
      unlessNodeKey: "routeTarget",
      requireIncompletePlan: true,
    });
    const base = {
      edgeId: "e1",
      fromNodeId: "start",
      toNodeId: "executor",
      turnContext: {},
      nodeContext: {},
      session: {
        phase: "executing",
        plan: {
          id: "p1",
          title: "T",
          status: "active" as const,
          steps: [{ id: "s1", title: "A", status: "pending" as const }],
          createdAt: 1,
          updatedAt: 1,
          createToolCallId: "call_p1",
        },
      },
    } satisfies EdgeEvalArgs;
    assert.equal(pred(base), true);
    assert.equal(
      pred({ ...base, nodeContext: { routeTarget: "planner" } }),
      false,
    );
    assert.equal(
      pred({
        ...base,
        session: {
          phase: "executing",
          plan: {
            ...base.session!.plan!,
            steps: [{ id: "s1", title: "A", status: "completed" as const }],
          },
        },
      }),
      false,
    );
    assert.equal(
      pred({
        ...base,
        session: { phase: "planning", plan: base.session!.plan },
      }),
      false,
    );
  });
});
