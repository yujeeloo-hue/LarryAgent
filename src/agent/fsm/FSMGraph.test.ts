import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FSM_GRAPH_CONFIG_VERSION } from "./constants.js";
import { FSMConfigError } from "./FSMConfigError.js";
import { FSMGraph } from "./FSMGraph.js";
import { FSMRegistry } from "./FSMRegistry.js";
import { NodeActionBase } from "./NodeActionBase.js";
import {
  createFSMGraphConfig,
  type FSMGraphConfig,
  type NodeActionExecArgs,
  type NodeActionExecResult,
} from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";

/** Topology-blind test Action: label comes from params, never from nodeId. */
class NodeActionAppendPath extends NodeActionBase {
  readonly type = "NodeActionAppendPath";

  constructor(private readonly label: string) {
    super();
  }

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const path = Array.isArray(args.turnContext.path)
      ? [...(args.turnContext.path as string[])]
      : [];
    path.push(this.label);
    return {
      status: "continue",
      turnContextPatch: { path },
    };
  }
}

class NodeActionHalt extends NodeActionBase {
  readonly type = "NodeActionHalt";

  Exec(_args: NodeActionExecArgs): NodeActionExecResult {
    return { status: "halt", errorMessage: "cancelled" };
  }
}

class NodeActionSetRoutePlan extends NodeActionBase {
  readonly type = "NodeActionSetRoutePlan";

  Exec(_args: NodeActionExecArgs): NodeActionExecResult {
    return { status: "continue", turnContextPatch: { route: "plan" } };
  }
}

/** Writes `route` onto nodeContext only (round-scoped signal). */
class NodeActionSetRouteNode extends NodeActionBase {
  readonly type = "NodeActionSetRouteNode";

  Exec(_args: NodeActionExecArgs): NodeActionExecResult {
    return { status: "continue", nodeContextPatch: { route: "plan" } };
  }
}

/**
 * Test-only loop driver: increments turnContext.count each visit and writes
 * route "loop" until count reaches exitAt, then route "exit".
 */
class NodeActionLoopCounter extends NodeActionBase {
  readonly type = "NodeActionLoopCounter";

  constructor(private readonly exitAt: number) {
    super();
  }

  Exec(args: NodeActionExecArgs): NodeActionExecResult {
    const count =
      typeof args.turnContext.count === "number"
        ? (args.turnContext.count as number)
        : 0;
    const next = count + 1;
    return {
      status: "continue",
      turnContextPatch: { count: next, route: next >= this.exitAt ? "exit" : "loop" },
    };
  }
}

function testRegistry(): FSMRegistry {
  return FSMRegistry.createDefault().registerActions({
    NodeActionAppendPath: (params) =>
      new NodeActionAppendPath(String(params?.label ?? "?")),
    NodeActionHalt: () => new NodeActionHalt(),
    NodeActionSetRoutePlan: () => new NodeActionSetRoutePlan(),
    NodeActionSetRouteNode: () => new NodeActionSetRouteNode(),
    NodeActionLoopCounter: (params) =>
      new NodeActionLoopCounter(Number(params?.exitAt ?? 1)),
  });
}

describe("fsm FSMGraph.run(config)", () => {
  it("hydrates config and reaches explicit end node", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [{ type: "NodeActionAppendPath", params: { label: "start" } }],
        },
        {
          id: "worker",
          actions: [{ type: "NodeActionAppendPath", params: { label: "worker" } }],
        },
        { id: "end", actions: [{ type: "NodeActionAppendPath", params: { label: "end" } }] },
      ],
      edges: [
        { from: "start", to: "worker", type: "EdgeAlways" },
        { from: "worker", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "end_node");
    assert.equal(result.currentNodeId, "end");
    assert.deepEqual(result.turnContext.path, ["start", "worker", "end"]);
    assert.deepEqual(result.nodesVisited, ["start", "worker", "end"]);
  });

  it("emits fsm_node enter telemetry with routed transition", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        { id: "start", actions: [] },
        { id: "worker", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [
        { from: "start", to: "worker", type: "EdgeAlways" },
        { from: "worker", to: "end", type: "EdgeAlways" },
      ],
    });

    const events: Array<{ type: string } & Record<string, unknown>> = [];
    const host = {
      isSubagentTurn: false,
      onEvent: (event: { type: string } & Record<string, unknown>) => {
        events.push(event);
      },
    } as unknown as import("./FsmHostCapabilities.js").FsmHostCapabilities;

    await FSMGraph.run(config, {}, { registries: testRegistry(), host });

    assert.deepEqual(
      events.map((event) => event.type),
      ["fsm_node", "fsm_node", "fsm_node"],
    );
    // Entry visit carries no transition; later visits name the routed edge.
    assert.equal(events[0]?.transition, undefined);
    assert.deepEqual(events[1]?.transition, { from: "start", to: "worker" });
    assert.deepEqual(events[2]?.transition, { from: "worker", to: "end" });
  });

  it("skips fsm_node telemetry on subagent turns", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        { id: "start", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });

    const events: unknown[] = [];
    const host = {
      isSubagentTurn: true,
      onEvent: (event: unknown) => {
        events.push(event);
      },
    } as unknown as import("./FsmHostCapabilities.js").FsmHostCapabilities;

    await FSMGraph.run(config, {}, { registries: testRegistry(), host });

    assert.deepEqual(events, []);
  });

  it("selfLoop fallback revisit carries from===to transition", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        {
          id: "loop",
          selfLoop: true,
          actions: [{ type: "NodeActionLoopCounter", params: { exitAt: 2 } }],
        },
        { id: "end", actions: [] },
      ],
      edges: [
        { from: "loop", to: "end", type: "EdgeWhen", params: { turnKey: "route", equals: "exit" } },
      ],
    });

    const events: Array<Record<string, unknown>> = [];
    const host = {
      isSubagentTurn: false,
      onEvent: (event: Record<string, unknown>) => {
        events.push(event);
      },
    } as unknown as import("./FsmHostCapabilities.js").FsmHostCapabilities;

    await FSMGraph.run(config, {}, { registries: testRegistry(), host });

    assert.equal(events.length, 3); // loop, loop(fallback), end
    assert.deepEqual(events[1]?.transition, { from: "loop", to: "loop" });
    assert.deepEqual(events[2]?.transition, { from: "loop", to: "end" });
  });

  it("uses EdgeWhen on turnContext", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "router",
      nodes: [
        {
          id: "router",
          actions: [
            { type: "NodeActionSetRoutePlan" },
            { type: "NodeActionAppendPath", params: { label: "router" } },
          ],
        },
        { id: "plan", actions: [{ type: "NodeActionAppendPath", params: { label: "plan" } }] },
        { id: "direct", actions: [{ type: "NodeActionAppendPath", params: { label: "direct" } }] },
        { id: "end" },
      ],
      edges: [
        {
          from: "router",
          to: "plan",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "plan" },
        },
        {
          from: "router",
          to: "direct",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "direct" },
        },
        { from: "plan", to: "end", type: "EdgeAlways" },
        { from: "direct", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.turnContext.path, ["router", "plan"]);
    assert.deepEqual(result.nodesVisited, ["router", "plan", "end"]);
  });

  it("uses EdgeWhen with source node to read nodeContext", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "router",
      nodes: [
        {
          id: "router",
          actions: [
            { type: "NodeActionSetRouteNode" },
            { type: "NodeActionAppendPath", params: { label: "router" } },
          ],
        },
        { id: "plan", actions: [{ type: "NodeActionAppendPath", params: { label: "plan" } }] },
        { id: "direct", actions: [{ type: "NodeActionAppendPath", params: { label: "direct" } }] },
        { id: "end" },
      ],
      edges: [
        {
          from: "router",
          to: "plan",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "plan", source: "node" },
        },
        {
          from: "router",
          to: "direct",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "direct", source: "node" },
        },
        { from: "plan", to: "end", type: "EdgeAlways" },
        { from: "direct", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.turnContext.path, ["router", "plan"]);
    // node-scoped signal must not leak onto turnContext.
    assert.equal((result.turnContext as Record<string, unknown>).route, undefined);
  });

  it("source node does not see turnContext keys (default turn does not see nodeContext)", async () => {
    // `route` lives on turnContext only; a node-sourced edge must miss it and
    // the run errors with exactly-one-match violation — proof the sources
    // are disjoint read domains.
    const config = createFSMGraphConfig({
      entryNodeId: "router",
      nodes: [
        {
          id: "router",
          actions: [{ type: "NodeActionSetRoutePlan" }],
        },
        { id: "a" },
        { id: "end" },
      ],
      edges: [
        {
          from: "router",
          to: "a",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "plan", source: "node" },
        },
        { from: "a", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /exactly 1 matching/);
  });

  it("halts without reaching end when an Action returns halt", async () => {    const config = createFSMGraphConfig({
      entryNodeId: "a",
      nodes: [
        {
          id: "a",
          actions: [
            { type: "NodeActionAppendPath", params: { label: "a" } },
            { type: "NodeActionHalt" },
          ],
        },
        { id: "end", actions: [{ type: "NodeActionAppendPath", params: { label: "end" } }] },
      ],
      edges: [{ from: "a", to: "end", type: "EdgeAlways" }],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "halt");
    assert.equal(result.errorMessage, "cancelled");
    assert.equal(result.currentNodeId, "a");
    assert.deepEqual(result.turnContext.path, ["a"]);
  });

  it("rejects non-terminal node with no outgoing edges at validate time", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "stuck",
      nodes: [
        { id: "stuck", actions: [{ type: "NodeActionAppendPath", params: { label: "stuck" } }] },
        { id: "end" },
      ],
      edges: [],
    });

    assert.throws(
      () => FSMGraph.fromConfig(config, testRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError &&
        err.code === "NON_TERMINAL_NO_OUTGOING",
    );
  });

  it("errors at runtime when zero edges match", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "router",
      nodes: [
        { id: "router", actions: [{ type: "NodeActionAppendPath", params: { label: "router" } }] },
        { id: "a" },
        { id: "b" },
        { id: "end" },
      ],
      edges: [
        {
          from: "router",
          to: "a",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "x" },
        },
        {
          from: "router",
          to: "b",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "y" },
        },
        { from: "a", to: "end", type: "EdgeAlways" },
        { from: "b", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /exactly 1 matching/);
  });

  it("selfLoop fallback: zero matching edges revisits the same node", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        {
          id: "loop",
          selfLoop: true,
          actions: [
            { type: "NodeActionAppendPath", params: { label: "loop" } },
            { type: "NodeActionLoopCounter", params: { exitAt: 3 } },
          ],
        },
        { id: "end" },
      ],
      edges: [
        {
          from: "loop",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "exit" },
        },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "end_node");
    // Two fallback re-visits while route stays "loop", then the exit edge.
    assert.deepEqual(result.nodesVisited, ["loop", "loop", "loop", "end"]);
    assert.deepEqual(result.turnContext.path, ["loop", "loop", "loop"]);
    assert.equal(result.turnContext.count, 3);
  });

  it("selfLoop node still takes a matching explicit edge over the fallback", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        {
          id: "loop",
          selfLoop: true,
          actions: [
            { type: "NodeActionAppendPath", params: { label: "loop" } },
            { type: "NodeActionLoopCounter", params: { exitAt: 2 } },
          ],
        },
        { id: "alt", actions: [{ type: "NodeActionAppendPath", params: { label: "alt" } }] },
        { id: "end" },
      ],
      edges: [
        {
          from: "loop",
          to: "alt",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "loop" },
        },
        { from: "alt", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "end_node");
    // route="loop" matches the explicit edge → alt, not the self fallback.
    assert.deepEqual(result.nodesVisited, ["loop", "alt", "end"]);
  });

  it("selfLoop node with >1 matching edges still errors (exactly-one)", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        { id: "loop", selfLoop: true, actions: [{ type: "NodeActionLoopCounter", params: { exitAt: 2 } }] },
        { id: "a" },
        { id: "b" },
        { id: "end" },
      ],
      edges: [
        { from: "loop", to: "a", type: "EdgeWhen", params: { turnKey: "route", equals: "loop" } },
        { from: "loop", to: "b", type: "EdgeWhen", params: { turnKey: "route", equals: "loop" } },
        { from: "a", to: "end", type: "EdgeAlways" },
        { from: "b", to: "end", type: "EdgeAlways" },
      ],
    });

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });

    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /got 2/);
  });

  it("runaway selfLoop fallback is bounded by maxTransitions", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        { id: "loop", selfLoop: true, actions: [{ type: "NodeActionLoopCounter", params: { exitAt: Infinity } }] },
        { id: "end" },
      ],
      edges: [
        {
          from: "loop",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "route", equals: "exit" },
        },
      ],
    });

    const result = await FSMGraph.run(config, {}, {
      registries: testRegistry(),
      maxTransitions: 5,
    });

    assert.equal(result.reason, "error");
    assert.match(result.errorMessage ?? "", /Exceeded maxTransitions \(5\)/);
    // Fallback revisits count as transitions: cap 5 → 6 visits (entry + 5).
    assert.equal(result.nodesVisited.length, 6);
  });

  it("selfLoop node with zero outgoing edges validates and exits via halt", async () => {
    const config = createFSMGraphConfig({
      entryNodeId: "loop",
      nodes: [
        {
          id: "loop",
          selfLoop: true,
          actions: [
            { type: "NodeActionAppendPath", params: { label: "loop" } },
            { type: "NodeActionHalt" },
          ],
        },
        { id: "end" },
      ],
      edges: [],
    });

    // Validation: selfLoop exempts NON_TERMINAL_NO_OUTGOING.
    const graph = FSMGraph.fromConfig(config, testRegistry());
    assert.equal(graph.getNode("loop")?.selfLoop, true);

    const result = await FSMGraph.run(config, {}, { registries: testRegistry() });
    assert.equal(result.reason, "halt");
    assert.equal(result.errorMessage, "cancelled");
    assert.equal(result.currentNodeId, "loop");
  });

  it("requires terminal end node in config", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "a",
      nodes: [{ id: "a" }],
      edges: [{ from: "a", to: "a", type: "EdgeAlways" }],
    });
    assert.throws(
      () => FSMGraph.fromConfig(config, testRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "MISSING_TERMINAL",
    );
  });
});

describe("fsm config contract", () => {
  it("createFSMGraphConfig sets the current version", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "a",
      nodes: [
        { id: "a" },
        { id: "end" },
      ],
      edges: [{ from: "a", to: "end", type: "EdgeAlways" }],
    });
    assert.equal(config.version, FSM_GRAPH_CONFIG_VERSION);
  });

  it("rejects wrong version and EdgeAlways mixed with siblings", () => {
    const badVersion = {
      version: 99,
      entryNodeId: "a",
      nodes: [
        { id: "a" },
        { id: "end" },
      ],
      edges: [{ from: "a", to: "end", type: "EdgeAlways" }],
    } as unknown as FSMGraphConfig;

    assert.throws(
      () => validateFSMGraphConfig(badVersion, testRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "INVALID_VERSION",
    );

    const mixed = createFSMGraphConfig({
      entryNodeId: "a",
      nodes: [
        { id: "a" },
        { id: "b" },
        { id: "end" },
      ],
      edges: [
        { from: "a", to: "end", type: "EdgeAlways" },
        {
          from: "a",
          to: "b",
          type: "EdgeWhen",
          params: { turnKey: "x", equals: 1 },
        },
        { from: "b", to: "end", type: "EdgeAlways" },
      ],
    });

    assert.throws(
      () => validateFSMGraphConfig(mixed, testRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "EDGE_ALWAYS_NOT_ALONE",
    );
  });

  it("rejects EdgeWhen without turnKey", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "a",
      nodes: [
        { id: "a" },
        { id: "end" },
      ],
      edges: [
        {
          from: "a",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "" },
        },
      ],
    });

    assert.throws(
      () => validateFSMGraphConfig(config, testRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "INVALID_EDGE_PARAMS",
    );
  });
});
