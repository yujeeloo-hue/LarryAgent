import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { NodeActionRouteTo } from "./NodeActionRouteTo.js";
import { NodeActionEmitRouteEvent } from "./NodeActionEmitRouteEvent.js";
import { NodeActionCheckPlan } from "./NodeActionCheckPlan.js";

describe("NodeActionRouteTo event subscription", () => {
  it("maps routeEvent to pin via routes", async () => {
    const action = new NodeActionRouteTo({
      routes: {
        stay: "analyser",
        leave: "skill_reflect_gate",
        direct: "agent",
      },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {
        routeEvent: "direct",
        routeEventSource: "fsm_route",
        toolsRan: true,
      },
    });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch?.routeTarget, "agent");
  });

  it("falls back to stay when tools ran and no event", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "agent", leave: "skill_reflect_gate" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: { toolsRan: true },
    });
    assert.equal(result.nodeContextPatch?.routeTarget, "agent");
  });

  it("falls back to leave when no tools", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "agent", leave: "skill_reflect_gate" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
    });
    assert.equal(result.nodeContextPatch?.routeTarget, "skill_reflect_gate");
  });

  it("falls back to stay when the round was interrupted (roundInterrupted)", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "agent", leave: "skill_reflect_gate" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: { roundInterrupted: true },
    });
    assert.equal(result.nodeContextPatch?.routeTarget, "agent");
  });

  it("an interrupt takes precedence over a plan or tool route event", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "agent", leave: "end", plan: "planner" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: { roundInterrupted: true, routeEvent: "plan" },
    });
    assert.equal(result.nodeContextPatch?.routeTarget, "agent");
  });

  it("a prompt queued after stream completion stays for the boundary drain", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "agent", leave: "end" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {},
      host: { hasPendingSteer: () => true } as never,
    });
    assert.equal(result.nodeContextPatch?.routeTarget, "agent");
  });

  it("stays instead of halting when an fsm_route event is unbound", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "analyser", leave: "skill_reflect_gate" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {
        routeEvent: "direct",
        routeEventSource: "fsm_route",
        toolsRan: true,
      },
    });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch?.routeTarget, "analyser");
  });

  it("reports the routes it binds for fsm_route validation", () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "analyser", leave: "skill_reflect_gate", plan: "plan_writer" },
    });
    assert.deepEqual(action.declaredRouteEvents(), ["stay", "leave", "plan"]);
  });

  it("preserves DetectStepClaim routeTarget", async () => {
    const action = new NodeActionRouteTo({
      routes: { stay: "executor", leave: "skill_reflect_gate" },
    });
    const result = await action.Exec({
      turnContext: {},
      nodeContext: {
        stepClaimed: true,
        routeTarget: "execution_validator",
      },
    });
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContextPatch, undefined);
  });
});

describe("NodeActionEmitRouteEvent routeEvent flush", () => {
  it("flushes last queue entry onto routeEvent", () => {
    const action = new NodeActionEmitRouteEvent({});
    const result = action.Exec({
      turnContext: {},
      nodeContext: {
        toolsRan: true,
        routeEventQueue: [
          { event: "doc_written", source: "tool" },
          { event: "plan", source: "fsm_route" },
        ],
      },
    });
    assert.equal(result.nodeContextPatch?.routeEvent, "plan");
    assert.equal(result.nodeContextPatch?.routeEventSource, "fsm_route");
    assert.equal(result.nodeContextPatch?.routeEventQueue, undefined);
  });

  it("clears routeEvent when queue is empty", () => {
    const action = new NodeActionEmitRouteEvent({});
    const result = action.Exec({
      turnContext: {},
      nodeContext: {
        toolsRan: true,
        routeEvent: "stale",
        routeEventQueue: [],
      },
    });
    assert.equal(result.nodeContextPatch?.routeEvent, undefined);
    assert.equal(result.nodeContextPatch?.routeEventSource, undefined);
  });
});

describe("NodeActionCheckPlan", () => {
  it("emits onIncomplete when plan has open steps and no tools", () => {
    const action = new NodeActionCheckPlan({ onIncomplete: "plan_resume" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: {
        session: {
          plan: {
            id: "p1",
            title: "T",
            status: "active",
            steps: [
              { id: "s1", title: "A", status: "in_progress" },
              { id: "s2", title: "B", status: "pending" },
            ],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      } as never,
    });
    assert.equal(result.nodeContextPatch?.routeEvent, "plan_resume");
    assert.equal(result.nodeContextPatch?.routeEventSource, "check_plan");
  });

  it("emits onComplete when plan is finished", () => {
    const action = new NodeActionCheckPlan({
      onIncomplete: "plan_resume",
      onComplete: "done",
    });
    const result = action.Exec({
      turnContext: {},
      nodeContext: {},
      host: {
        session: {
          plan: {
            id: "p1",
            title: "T",
            status: "completed",
            steps: [{ id: "s1", title: "A", status: "completed" }],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      } as never,
    });
    assert.equal(result.nodeContextPatch?.routeEvent, "done");
  });

  it("skips when toolsRan and onlyWhenNoTools default", () => {
    const action = new NodeActionCheckPlan({ onIncomplete: "plan_resume" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { toolsRan: true },
      host: {
        session: {
          plan: {
            id: "p1",
            title: "T",
            status: "active",
            steps: [{ id: "s1", title: "A", status: "pending" }],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      } as never,
    });
    assert.equal(result.nodeContextPatch, undefined);
  });

  it("does not overwrite an existing routeEvent", () => {
    const action = new NodeActionCheckPlan({ onIncomplete: "plan_resume" });
    const result = action.Exec({
      turnContext: {},
      nodeContext: { routeEvent: "direct" },
      host: {
        session: {
          plan: {
            id: "p1",
            title: "T",
            status: "active",
            steps: [{ id: "s1", title: "A", status: "pending" }],
            createdAt: 1,
            updatedAt: 1,
          },
        },
      } as never,
    });
    assert.equal(result.nodeContextPatch, undefined);
  });
});
