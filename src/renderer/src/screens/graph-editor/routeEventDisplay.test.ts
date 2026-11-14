import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { collectActionEmittedRouteEvents } from "./routeEventDisplay.js";

describe("collectActionEmittedRouteEvents", () => {
  it("merges schema x-emitsRouteEvents with routeGuide routeTo", () => {
    const events = collectActionEmittedRouteEvents(
      { "x-emitsRouteEvents": ["stay", "leave", "done"] },
      {
        routeGuide: [
          { when: "plan ready", routeTo: "ready" },
          { when: "rewrite", routeTo: "rewrite" },
          { when: "dup", routeTo: "ready" },
        ],
      },
    );
    assert.deepEqual(events, ["done", "leave", "ready", "rewrite", "stay"]);
  });

  it("returns routeGuide-only events when schema has no declaration", () => {
    assert.deepEqual(
      collectActionEmittedRouteEvents(undefined, {
        routeGuide: [{ when: "x", routeTo: "custom" }],
      }),
      ["custom"],
    );
  });

  it("returns empty when nothing is declared", () => {
    assert.deepEqual(collectActionEmittedRouteEvents({}, {}), []);
  });
});
