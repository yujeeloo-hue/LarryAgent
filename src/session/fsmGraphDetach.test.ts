import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planFsmGraphDetach } from "./fsmGraphDetach.js";
import type { FsmGraphDetachInputSession } from "./fsmGraphDetach.js";

function session(
  id: string,
  overrides: Partial<FsmGraphDetachInputSession> = {},
): FsmGraphDetachInputSession {
  return {
    id,
    title: `Session ${id}`,
    running: false,
    composerRunMode: "custom",
    composerFsmGraphId: "graph-1",
    ...overrides,
  };
}

describe("planFsmGraphDetach", () => {
  it("returns empty plan for an empty/whitespace graph id", () => {
    const plan = planFsmGraphDetach(
      [session("s1"), session("s2")],
      "   ",
    );
    assert.deepEqual(plan, { flip: [], blocked: [] });
  });

  it("collects only sessions pinning the exact graph in custom mode", () => {
    const plan = planFsmGraphDetach(
      [
        session("s1"),
        session("s2", { composerFsmGraphId: "graph-2" }),
        session("s3", { composerRunMode: "agent", composerFsmGraphId: "graph-1" }),
        session("s4", { composerRunMode: null, composerFsmGraphId: "graph-1" }),
        session("s5", { composerRunMode: "custom", composerFsmGraphId: null }),
        session("s6", {
          composerRunMode: "custom",
          composerFsmGraphId: null,
        }),
      ],
      "graph-1",
    );
    assert.deepEqual(
      plan.flip.map((s) => s.id),
      ["s1"],
    );
    assert.deepEqual(plan.blocked, []);
  });

  it("splits running sessions into blocked and idle ones into flip", () => {
    const plan = planFsmGraphDetach(
      [
        session("idle-a"),
        session("busy", { running: true }),
        session("idle-b"),
      ],
      " graph-1 ",
    );
    assert.deepEqual(
      plan.flip.map((s) => s.id),
      ["idle-a", "idle-b"],
    );
    assert.deepEqual(
      plan.blocked.map((s) => s.id),
      ["busy"],
    );
    assert.equal(plan.blocked[0]?.title, "Session busy");
  });

  it("returns empty plan when no session uses the graph", () => {
    const plan = planFsmGraphDetach(
      [session("s1", { composerRunMode: "agent" })],
      "graph-1",
    );
    assert.deepEqual(plan, { flip: [], blocked: [] });
  });
});
