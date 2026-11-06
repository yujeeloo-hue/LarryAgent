import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import type { NodeActionExecArgs } from "../types.js";
import {
  NodeActionCompare,
  validateNodeActionCompareParams,
} from "./NodeActionCompare.js";
import { NodeActionRouteTo } from "./NodeActionRouteTo.js";
import { buildDemoConfirmMessage } from "../../../session/demoConfirm.js";

function hostWithBlackboard(
  store: Record<string, unknown>,
  session?: { plan?: unknown; planDoc?: { path?: string } | null },
): FsmHostCapabilities {
  return {
    blackboardGet: (key: string) => store[key],
    session,
  } as unknown as FsmHostCapabilities;
}

function makeArgs(
  turnContext: Record<string, unknown> = {},
  host?: FsmHostCapabilities,
  nodeContext: Record<string, unknown> = {},
): NodeActionExecArgs {
  return host
    ? { turnContext, nodeContext, host }
    : { turnContext, nodeContext };
}

describe("NodeActionCompare + RouteTo when-table", () => {
  it("first matching when row wins", async () => {
    const route = new NodeActionRouteTo({
      when: [
        { key: "a", to: "analyser" },
        { key: "b", to: "planner" },
      ],
    });
    assert.deepEqual(
      (await route.Exec(makeArgs({ a: true, b: true }))).nodeContextPatch,
      { routeTarget: "analyser" },
    );
    assert.deepEqual(
      (await route.Exec(makeArgs({ a: false, b: true }))).nodeContextPatch,
      { routeTarget: "planner" },
    );
    assert.equal(
      (await route.Exec(makeArgs({ a: false, b: false }))).nodeContextPatch,
      undefined,
    );
  });

  it("allOf row requires every flag (legacy)", async () => {
    const route = new NodeActionRouteTo({
      when: [{ allOf: ["a", "b"], to: "executor" }],
    });
    assert.equal(
      (await route.Exec(makeArgs({ a: true, b: false }))).nodeContextPatch,
      undefined,
    );
    assert.deepEqual(
      (await route.Exec(makeArgs({ a: true, b: true }))).nodeContextPatch,
      { routeTarget: "executor" },
    );
  });

  it("expr row supports && and ||", async () => {
    const route = new NodeActionRouteTo({
      when: [{ expr: "a && b || c", to: "executor" }],
    });
    assert.deepEqual(
      (await route.Exec(makeArgs({ a: true, b: false, c: true })))
        .nodeContextPatch,
      { routeTarget: "executor" },
    );
    assert.equal(
      (await route.Exec(makeArgs({ a: false, b: false, c: false })))
        .nodeContextPatch,
      undefined,
    );
  });

  it("legacy pin + key still works", async () => {
    const compare = new NodeActionCompare({
      key: "count",
      type: "int",
      operator: ">",
      value: 2,
      asKey: "flag.gt2",
    });
    const route = new NodeActionRouteTo({ key: "flag.gt2", pin: "next" });
    const cmpOut = compare.Exec(makeArgs({ count: 3 }));
    const routeOut = await route.Exec(
      makeArgs({ count: 3, ...cmpOut.turnContextPatch }),
    );
    assert.deepEqual(routeOut.nodeContextPatch, { routeTarget: "next" });
  });

  it("onlyIfRouteTargetUnset skips when Approve already routed", async () => {
    const route = new NodeActionRouteTo({
      when: [{ key: "flag", to: "analyser" }],
      onlyIfRouteTargetUnset: true,
    });
    const out = await route.Exec(
      makeArgs({ flag: true }, undefined, { routeTarget: "planner" }),
    );
    assert.equal(out.nodeContextPatch, undefined);
  });

  it("session blackboard + planOpenSteps sources", () => {
    const phaseCmp = new NodeActionCompare({
      source: "blackboard",
      key: "phase",
      scope: "session",
      type: "string",
      operator: "==",
      value: "executing",
      asKey: "resume.phase.executing",
    });
    const openCmp = new NodeActionCompare({
      source: "planOpenSteps",
      operator: "==",
      value: "true",
      asKey: "resume.planOpen.executing",
    });
    const host = hostWithBlackboard(
      { phase: "executing" },
      {
        plan: {
          status: "active",
          steps: [{ id: "s1", status: "in_progress", title: "A" }],
        },
      },
    );
    assert.deepEqual(phaseCmp.Exec(makeArgs({}, host)).turnContextPatch, {
      "resume.phase.executing": true,
    });
    assert.deepEqual(openCmp.Exec(makeArgs({}, host)).turnContextPatch, {
      "resume.planOpen.executing": true,
    });
  });

  it("event rows take precedence over blackboard rows when routeEvent is set", async () => {
    const action = new NodeActionRouteTo({
      when: [{ key: "flag", to: "planner" }],
      routes: { stay: "agent", leave: "end", direct: "agent" },
    });
    const out = await action.Exec(
      makeArgs(
        { flag: true },
        undefined,
        { routeEvent: "direct", routeEventSource: "fsm_route", toolsRan: true },
      ),
    );
    assert.equal(out.status, "continue");
    assert.equal(out.nodeContextPatch?.routeTarget, "agent");
  });

  it("blackboard rows run when routeEvent is unset", async () => {
    const action = new NodeActionRouteTo({
      when: [{ key: "flag", to: "planner" }],
      routes: { stay: "agent", leave: "end" },
    });
    const out = await action.Exec(makeArgs({ flag: true }));
    assert.equal(out.nodeContextPatch?.routeTarget, "planner");
  });

  it("defaultPin applies when no when row matches", async () => {
    const action = new NodeActionRouteTo({
      when: [{ key: "flag", to: "planner" }],
      onlyIfRouteTargetUnset: true,
      defaultPin: "analyser",
    });
    const out = await action.Exec(makeArgs({}));
    assert.equal(out.nodeContextPatch?.routeTarget, "analyser");
  });
});

describe("Compare source demoConfirm (turn-level user input signal)", () => {
  const runCompare = (userText?: string) =>
    new NodeActionCompare({
      source: "demoConfirm",
      asKey: "turn.demoConfirm",
    }).Exec(
      userText === undefined
        ? ({ turnContext: {}, nodeContext: {} } as NodeActionExecArgs)
        : ({
            turnContext: {},
            nodeContext: {},
            turnInput: { userText },
          } as unknown as NodeActionExecArgs),
    );

  it("true for a D7 marker confirm message", async () => {
    const text = buildDemoConfirmMessage({
      toolCallId: "tc-1",
      paramsJson: '{"accent":"#f1f2f4"}',
      note: "ship it",
    });
    assert.deepEqual((await runCompare(text)).turnContextPatch, {
      "turn.demoConfirm": true,
    });
  });

  it("false for plain user text (even when it mentions demos)", async () => {
    for (const text of [
      "make the sidebar narrower please",
      "Demo confirmed would be nice but this is not the marker",
    ]) {
      assert.deepEqual((await runCompare(text)).turnContextPatch, {
        "turn.demoConfirm": false,
      });
    }
  });

  it("false (no halt) when turnInput is absent — stub / editor preview", async () => {
    const out = await runCompare(undefined);
    assert.equal(out.status, "continue");
    assert.deepEqual(out.turnContextPatch, { "turn.demoConfirm": false });
  });

  it("validator: asKey required, key not", () => {
    assert.throws(() =>
      validateNodeActionCompareParams({ source: "demoConfirm" }, "t"),
    );
    assert.doesNotThrow(() =>
      validateNodeActionCompareParams(
        { source: "demoConfirm", asKey: "turn.demoConfirm" },
        "t",
      ),
    );
    assert.throws(() =>
      validateNodeActionCompareParams(
        { source: "demoConfirm", asKey: "bad key!" },
        "t",
      ),
    );
  });

  it("operator== false branch inverts the flag", async () => {
    const out = await new NodeActionCompare({
      source: "demoConfirm",
      operator: "!=",
      value: "true",
      asKey: "no.confirm",
    }).Exec({
      turnContext: {},
      nodeContext: {},
      turnInput: { userText: "just feedback" },
    } as unknown as NodeActionExecArgs);
    assert.deepEqual(out.turnContextPatch, { "no.confirm": true });
  });
});
