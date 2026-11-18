import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectEmittedRouteEvents,
  normalizeRouteBindings,
  resolveRouteEventFromQueue,
  EMIT_ROUTE_EVENTS,
} from "./routeEvents.js";

describe("routeEvents helpers", () => {
  it("normalizes legacy map and array bindings", () => {
    assert.deepEqual(normalizeRouteBindings({ stay: "a", leave: "b" }), [
      { event: "stay", to: "a" },
      { event: "leave", to: "b" },
    ]);
    assert.deepEqual(
      normalizeRouteBindings([{ event: "direct", to: "agent" }]),
      [{ event: "direct", to: "agent" }],
    );
  });

  it("collects x-emitsRouteEvents, CheckPlan slots, and routeGuide targets", () => {
    const events = collectEmittedRouteEvents(
      [
        { type: "NodeActionEmitRouteEvent", params: {} },
        {
          type: "NodeActionCheckPlan",
          params: { onIncomplete: "plan_resume", onComplete: "wrap_up" },
        },
        {
          type: "NodeActionPromptInject",
          params: {
            source: "routeGuide",
            routeGuide: [{ when: "simple", routeTo: "custom_route" }],
          },
        },
        {
          type: "NodeActionRouteTo",
          params: { routes: [] },
        },
      ],
      (type) => {
        if (type === "NodeActionEmitRouteEvent") {
          return { "x-emitsRouteEvents": [...EMIT_ROUTE_EVENTS] };
        }
        if (type === "NodeActionRouteTo") {
          return { "x-emitsRouteEvents": ["stay", "leave"] };
        }
        return undefined;
      },
    );
    assert.ok(events.includes("stay"));
    assert.ok(events.includes("leave"));
    assert.ok(events.includes("doc_written"));
    assert.ok(events.includes("plan_resume"));
    assert.ok(events.includes("wrap_up"));
    assert.ok(events.includes("custom_route"));
  });

  it("resolveRouteEventFromQueue is last-wins", () => {
    assert.deepEqual(
      resolveRouteEventFromQueue([
        { event: "doc_written", source: "tool" },
        { event: "plan", source: "fsm_route" },
      ]),
      { event: "plan", source: "fsm_route" },
    );
    assert.equal(resolveRouteEventFromQueue([]), undefined);
  });
});
