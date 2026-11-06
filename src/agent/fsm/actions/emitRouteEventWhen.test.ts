import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { NodeActionExecArgs } from "../types.js";
import { NodeActionEmitRouteEventWhen } from "./NodeActionEmitRouteEventWhen.js";

function hostWithBlackboard(
  store: Record<string, unknown>,
): FsmHostCapabilities {
  return {
    blackboardGet: (key: string) => store[key],
  } as unknown as FsmHostCapabilities;
}

function makeArgs(
  turnContext: Record<string, unknown> = {},
  host?: FsmHostCapabilities,
): NodeActionExecArgs {
  return host
    ? { turnContext, nodeContext: {}, host }
    : { turnContext, nodeContext: {} };
}

const BASE = {
  key: "count",
  type: "int",
  operator: ">",
  value: 2,
  event: "escalate",
};

describe("NodeActionEmitRouteEventWhen", () => {
  it("met condition writes routeEvent with source blackboard", () => {
    const action = new NodeActionEmitRouteEventWhen(BASE);
    const out = action.Exec(makeArgs({ count: 3 }));
    assert.equal(out.status, "continue");
    assert.deepEqual(out.nodeContextPatch, {
      routeEvent: "escalate",
      routeEventSource: "blackboard",
    });
  });

  it("unmet condition writes nothing (earlier routeEvent stays intact)", () => {
    const action = new NodeActionEmitRouteEventWhen(BASE);
    const out = action.Exec(makeArgs({ count: 1 }));
    assert.equal(out.status, "continue");
    assert.equal(out.nodeContextPatch, undefined);
  });

  it("string conditions are lexicographic", () => {
    const action = new NodeActionEmitRouteEventWhen({
      key: "state",
      type: "string",
      operator: "==",
      value: "done",
      event: "finish",
    });
    assert.deepEqual(
      action.Exec(makeArgs({ state: "done" })).nodeContextPatch,
      { routeEvent: "finish", routeEventSource: "blackboard" },
    );
    assert.equal(
      action.Exec(makeArgs({ state: "pending" })).nodeContextPatch,
      undefined,
    );
  });

  it("missing key / type mismatch degrade per strict", () => {
    const lax = new NodeActionEmitRouteEventWhen(BASE);
    assert.equal(lax.Exec(makeArgs({})).status, "continue");

    const strictMissing = new NodeActionEmitRouteEventWhen({
      ...BASE,
      strict: true,
    });
    const strictOut = strictMissing.Exec(makeArgs({}));
    assert.equal(strictOut.status, "halt");
    assert.match(strictOut.errorMessage ?? "", /not a finite number/);

    const strictMismatch = new NodeActionEmitRouteEventWhen({
      ...BASE,
      strict: true,
    });
    assert.equal(
      strictMismatch.Exec(makeArgs({ count: "abc" })).status,
      "halt",
    );
  });

  it("reserved keys always halt", () => {
    const action = new NodeActionEmitRouteEventWhen({
      ...BASE,
      key: "routeEvent",
    });
    assert.match(action.Exec(makeArgs({ count: 3 })).errorMessage ?? "", /reserved/);
  });

  it("session scope reads through the host capability and degrades per strict", () => {
    const store: Record<string, unknown> = { count: 9 };
    const action = new NodeActionEmitRouteEventWhen({
      ...BASE,
      scope: "session",
    });
    assert.deepEqual(
      action.Exec(makeArgs({}, hostWithBlackboard(store))).nodeContextPatch,
      { routeEvent: "escalate", routeEventSource: "blackboard" },
    );

    const lax = new NodeActionEmitRouteEventWhen({ ...BASE, scope: "session" });
    assert.equal(lax.Exec(makeArgs()).status, "continue");

    const strict = new NodeActionEmitRouteEventWhen({
      ...BASE,
      scope: "session",
      strict: true,
    });
    assert.equal(strict.Exec(makeArgs()).status, "halt");
  });

  it("empty event name is an authoring halt", () => {
    const action = new NodeActionEmitRouteEventWhen({ ...BASE, event: "" });
    const out = action.Exec(makeArgs({ count: 3 }));
    assert.equal(out.status, "halt");
    assert.match(out.errorMessage ?? "", /event/);
  });
});
