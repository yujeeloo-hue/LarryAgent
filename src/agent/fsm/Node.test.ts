import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Node } from "./Node.js";
import { NodeActionBase } from "./NodeActionBase.js";
import type {
  NodeActionExecArgs,
  NodeActionExecResult,
} from "./types.js";

/** Test-only Action — naming follows NodeActionXXX. Topology-blind: no nodeId. */
class NodeActionRecordVisit extends NodeActionBase {
  readonly type = "NodeActionRecordVisit";

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const visits = Array.isArray(args.nodeContext.visits)
      ? (args.nodeContext.visits as string[])
      : [];
    visits.push("visit");
    const count =
      typeof args.turnContext.visitCount === "number"
        ? (args.turnContext.visitCount as number)
        : 0;
    return {
      status: "continue",
      nodeContextPatch: { visits },
      turnContextPatch: { visitCount: count + 1 },
    };
  }
}

class NodeActionHaltWithError extends NodeActionBase {
  readonly type = "NodeActionHaltWithError";

  Exec(_args: NodeActionExecArgs): NodeActionExecResult {
    return {
      status: "halt",
      errorMessage: "stopped",
      turnContextPatch: { halted: true },
    };
  }
}

class NodeActionShouldNotRun extends NodeActionBase {
  readonly type = "NodeActionShouldNotRun";
  ran = false;

  Exec(_args: NodeActionExecArgs): NodeActionExecResult {
    this.ran = true;
    return { status: "continue" };
  }
}

describe("fsm Node + NodeActionBase", () => {
  it("runs Actions in order (topology-blind args) and merges patches", async () => {
    const node = new Node({
      id: "planner",
      name: "Planner",
      actions: [new NodeActionRecordVisit(), new NodeActionRecordVisit()],
    });
    const turnContext: Record<string, unknown> = {};
    const nodeContext: Record<string, unknown> = {};
    const result = await node.run(turnContext, nodeContext);

    assert.equal(result.status, "continue");
    assert.equal(result.actionsExecuted, 2);
    assert.equal(result.turnContext.visitCount, 2);
    assert.deepEqual(result.nodeContext.visits, ["visit", "visit"]);
    assert.equal(node.getActions().length, 2);
    assert.equal(node.name, "Planner");
  });

  it("stops later Actions when Exec returns halt", async () => {
    const skip = new NodeActionShouldNotRun();
    const node = new Node({ id: "executor" });
    node
      .addAction(new NodeActionRecordVisit())
      .addAction(new NodeActionHaltWithError())
      .addAction(skip);

    const result = await node.run({});

    assert.equal(result.status, "halt");
    assert.equal(result.errorMessage, "stopped");
    assert.equal(result.actionsExecuted, 2);
    assert.equal(result.turnContext.visitCount, 1);
    assert.equal(result.turnContext.halted, true);
    assert.equal(skip.ran, false);
  });

  it("does not attach Node onto the Action instance", () => {
    const action = new NodeActionRecordVisit();
    assert.equal(
      Object.prototype.hasOwnProperty.call(action, "node"),
      false,
    );
    assert.equal(action.type, "NodeActionRecordVisit");
  });

  it("selfLoop defaults to false and passes through when set", () => {
    assert.equal(new Node({ id: "a" }).selfLoop, false);
    assert.equal(new Node({ id: "a", selfLoop: true }).selfLoop, true);
    assert.equal(new Node({ id: "a", selfLoop: false }).selfLoop, false);
  });
});
