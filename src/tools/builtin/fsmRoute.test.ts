import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ToolReturnCode } from "../../session/returnCodes.js";
import { fsmRouteHandler, parseFsmRouteArgs } from "./fsmRoute.js";

describe("fsm_route", () => {
  it("parses a route without binding it to a node", () => {
    assert.deepEqual(parseFsmRouteArgs({ route: "direct", reason: "small" }), {
      ok: true,
      route: "direct",
      reason: "small",
    });
    assert.equal(parseFsmRouteArgs({ route: "custom_future_route" }).ok, true);
  });

  it("rejects an empty route", async () => {
    const result = await fsmRouteHandler(
      { route: "" },
      { workspacePath: "/tmp", fullPermissionsEnabled: false },
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
  });

  it("rejects a route the current node does not bind", async () => {
    const result = await fsmRouteHandler(
      { route: "doc_written", reason: "doc is written" },
      {
        workspacePath: "/tmp",
        fullPermissionsEnabled: false,
        boundRouteEvents: ["stay", "leave", "ready", "rewrite"],
      },
    );
    assert.equal(result.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(result.routeEvent, undefined);
    const text = result.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    assert.match(text, /ready, rewrite/);
  });

  it("accepts a bound route", async () => {
    const result = await fsmRouteHandler(
      { route: "ready", reason: "plan is settled" },
      {
        workspacePath: "/tmp",
        fullPermissionsEnabled: false,
        boundRouteEvents: ["stay", "leave", "ready", "rewrite"],
      },
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(result.routeEvent, { event: "ready", source: "fsm_route" });
  });

  it("emits sessionPatch for ready / rewrite", async () => {
    const doc = {
      path: "/tmp/ws/docs/plans/a.md",
      summary: "Ship",
      updatedAt: 1,
      approvalPending: false,
    };
    const ready = await fsmRouteHandler(
      { route: "ready", reason: "done" },
      {
        workspacePath: "/tmp",
        fullPermissionsEnabled: false,
        planDocSnapshot: doc,
      },
    );
    assert.equal(ready.returnCode, ToolReturnCode.Success);
    assert.deepEqual(ready.routeEvent, {
      event: "ready",
      source: "fsm_route",
    });
    assert.deepEqual(ready.sessionPatch, {
      planDoc: { ...doc, approvalPending: true },
    });

    const rewrite = await fsmRouteHandler(
      { route: "rewrite", reason: "fix" },
      {
        workspacePath: "/tmp",
        fullPermissionsEnabled: false,
        planDocSnapshot: { ...doc, approvalPending: true },
      },
    );
    assert.deepEqual(rewrite.sessionPatch, {
      planDoc: { path: doc.path, summary: doc.summary, updatedAt: doc.updatedAt },
    });
  });
});
