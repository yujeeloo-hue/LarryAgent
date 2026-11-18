import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FSMConfigError } from "./FSMConfigError.js";
import { FSMGraph } from "./FSMGraph.js";
import { FSMRegistry } from "./FSMRegistry.js";
import { NodeActionBase } from "./NodeActionBase.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createFSMGraphConfig,
  type NodeActionConfig,
  type NodeActionExecResult,
} from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";
import { loadGraphConfig } from "./compatibility/loadGraphConfig.js";

class TestAction extends NodeActionBase {
  readonly type = "TestAction";

  constructor(private readonly params: Record<string, unknown>) {
    super();
  }

  Exec(): NodeActionExecResult {
    return { status: "continue", turnContextPatch: { value: this.params.value } };
  }
}

function graphWithActions(actions: NodeActionConfig[], pins = ["exit"]) {
  return createFSMGraphConfig({
    entryNodeId: "start",
    nodes: [
      { id: "start", pins: pins.map((name) => ({ name })), actions },
      { id: "end" },
    ],
    edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
  });
}

function isConfigError(code: FSMConfigError["code"], pattern?: RegExp) {
  return (error: unknown) =>
    error instanceof FSMConfigError &&
    error.code === code &&
    (!pattern || pattern.test(error.message));
}

describe("Action preparation and graph construction", () => {
  it("validation never invokes a factory; hydration validates and constructs once", async () => {
    let creations = 0;
    const validated: Readonly<Record<string, unknown>>[] = [];
    const created: Record<string, unknown>[] = [];
    const registry = FSMRegistry.createDefault().registerAction({
      type: "TestAction",
      paramsSchema: {
        type: "object",
        properties: { value: { type: "integer", default: "2" } },
      },
      validate: (params) => {
        validated.push(params);
        assert.equal(params.value, 2);
      },
      create: (params) => {
        creations += 1;
        created.push(params);
        return new TestAction(params);
      },
    });
    const config = graphWithActions([{ type: "TestAction" }]);
    validateFSMGraphConfig(config, registry);
    assert.equal(creations, 0);
    assert.equal(validated.length, 1);

    const graph = FSMGraph.fromConfig(config, registry);
    assert.equal(creations, 1);
    assert.equal(validated.length, 2);
    assert.equal(created[0], validated[1], "factory uses the params that passed validation");
    const result = await graph.execute({});
    assert.equal(result.reason, "end_node");
    assert.equal(result.turnContext.value, 2);
    assert.equal(config.nodes[0]?.actions?.[0]?.params, undefined);
  });

  it("no Actions are constructed when a later Action fails semantic validation", () => {
    let creations = 0;
    const registry = FSMRegistry.createDefault().registerAction({
      type: "TestAction",
      paramsSchema: { type: "object", properties: { value: { type: "integer" } } },
      validate: (params, label) => {
        if (params.value === -1) throw new FSMConfigError("INVALID_ACTION_PARAMS", label);
      },
      create: (params) => {
        creations += 1;
        return new TestAction(params);
      },
    });
    assert.throws(
      () => FSMGraph.fromConfig(graphWithActions([
        { type: "TestAction", params: { value: 1 } },
        { type: "TestAction", params: { value: -1 } },
      ]), registry),
      isConfigError("INVALID_ACTION_PARAMS", /action #1/),
    );
    assert.equal(creations, 0);
  });

  it("no Actions are constructed when graph topology is invalid", () => {
    let creations = 0;
    const registry = FSMRegistry.createDefault().registerAction("TestAction", (params) => {
      creations += 1;
      return new TestAction(params ?? {});
    });
    const config = graphWithActions([{ type: "TestAction" }]);
    config.edges[0]!.to = "missing";
    assert.throws(() => FSMGraph.fromConfig(config, registry), isConfigError("DANGLING_EDGE"));
    assert.equal(creations, 0);
  });

  it("a registration override owns validation even when using a builtin Action name", () => {
    const registry = createDefaultActionRegistry().registerAction({
      type: "NodeActionWriteBlackboard",
      paramsSchema: {
        type: "object",
        additionalProperties: false,
        properties: { value: { type: "integer", default: 7 } },
      },
      create: (params) => new TestAction(params),
    });
    assert.doesNotThrow(() => FSMGraph.fromConfig(
      graphWithActions([{ type: "NodeActionWriteBlackboard" }]), registry,
    ));
  });

  it("cloning a registry retains its custom semantic validator", () => {
    const registry = FSMRegistry.createDefault().registerAction({
      type: "TestAction",
      paramsSchema: { type: "object" },
      validate: (_params, label) => {
        throw new FSMConfigError("INVALID_ACTION_PARAMS", `${label}: custom check`);
      },
      create: (params) => new TestAction(params),
    });
    assert.throws(
      () => validateFSMGraphConfig(graphWithActions([{ type: "TestAction" }]), registry.clone()),
      isConfigError("INVALID_ACTION_PARAMS", /custom check/),
    );
  });
});

describe("Normalized Action validation", () => {
  for (const type of ["NodeActionRouteTo", "NodeActionAdvanceRole", " NodeActionRouteTo "]) {
    it(`rejects an invalid route expression for ${JSON.stringify(type)}`, () => {
      const config = graphWithActions([{
        type,
        params: { when: [{ expr: "flag &&", to: "exit" }] },
      }]);
      assert.throws(
        () => FSMGraph.fromConfig(type === "NodeActionAdvanceRole"
          ? loadGraphConfig({ ...config, version: 1 }).config : config, createDefaultActionRegistry()),
        isConfigError("INVALID_ACTION_PARAMS"),
      );
    });
  }

  const malformedGates: Record<string, unknown>[] = [
    { when: [{ to: "exit" }] },
    { when: [{ expr: "flag" }] },
    { when: [null] },
    { when: [{ expr: "flag", to: "exit" }, { to: "exit" }] },
    { pin: "exit" },
  ];
  for (const [index, params] of malformedGates.entries()) {
    it(`migration preserves invalid route gates for semantic validation (case ${index})`, () => {
      assert.throws(
        () => FSMGraph.fromConfig(
          loadGraphConfig({ ...graphWithActions([{ type: "NodeActionRouteTo", params }]), version: 1 }).config,
          createDefaultActionRegistry(),
        ),
        isConfigError("INVALID_ACTION_PARAMS"),
      );
    });
  }

  it("validates Pin references supplied by schema defaults", () => {
    let creations = 0;
    const registry = FSMRegistry.createDefault().registerAction({
      type: "TestAction",
      paramsSchema: {
        type: "object",
        properties: { onDone: { type: "string", default: "missing", "x-ui": "pin-select" } },
      },
      create: (params) => {
        creations += 1;
        return new TestAction(params);
      },
    });
    assert.throws(
      () => FSMGraph.fromConfig(graphWithActions([{ type: "TestAction" }]), registry),
      isConfigError("INVALID_PIN", /missing/),
    );
    assert.equal(creations, 0);
    assert.doesNotThrow(() => FSMGraph.fromConfig(
      graphWithActions([{ type: "TestAction", params: { onDone: "exit" } }]), registry,
    ));
    assert.equal(creations, 1);
  });

  it("validates Pin references introduced by legacy parameter migration", () => {
    assert.throws(
      () => FSMGraph.fromConfig(loadGraphConfig({ ...graphWithActions([{
        type: "NodeActionAdvanceRole",
        params: { onStay: "exit", onLeave: "missing" },
      }]), version: 1 }).config, createDefaultActionRegistry()),
      isConfigError("INVALID_PIN", /missing/),
    );
  });

  it("accepts Pin names after migration without changing the original config", () => {
    const config = graphWithActions([{
      type: "NodeActionRouteTo",
      params: { routes: [{ event: "leave", to: "reflect_done" }] },
    }], ["end"]);
    const before = structuredClone(config);
    const graph = FSMGraph.fromConfig(loadGraphConfig({ ...config, version: 1 }).config, createDefaultActionRegistry());
    assert.deepEqual(graph.getNode("start")?.getActions()[0]?.declaredRouteEvents?.(), ["leave"]);
    assert.deepEqual(config, before);
  });

  it("preserves the original alias when preparing legacy parameterless counter Actions", async () => {
    const registry = createDefaultActionRegistry();
    const migrated = loadGraphConfig({
      ...graphWithActions([{ type: "NodeActionBumpReplanCount" }]), version: 1,
    }).config.nodes[0]!.actions![0]!;
    const action = registry.getActionFactory(migrated.type)(migrated.params);
    const result = await action.Exec({ turnContext: { replanCount: 2 }, nodeContext: {} });
    assert.equal(result.status, "continue");
    assert.equal(result.turnContextPatch?.replanCount, 3);
  });
});

describe("Registered semantics also apply outside graph validation", () => {
  const invalidActions: NodeActionConfig[] = [
    { type: "NodeActionWriteBlackboard", params: { key: "routeTarget", value: 1 } },
    { type: "NodeActionReadBlackboard", params: { key: "count", asKey: "toolCalls" } },
    { type: "NodeActionCompare", params: { key: "count", type: "int", value: "bad", asKey: "flag" } },
    { type: "NodeActionRouteTo", params: { when: [{ expr: "flag &&", to: "exit" }] } },
    { type: "NodeActionEmitRouteEventWhen", params: { key: "routeEvent", type: "int", operator: "==", value: 1, event: "ready" } },
    { type: "NodeActionRunShell", params: {} },
    { type: "NodeActionRunShell", params: { command: "check", scriptPath: "check.sh" } },
  ];
  for (const [index, action] of invalidActions.entries()) {
    it(`rejects invalid standalone ${action.type} params (case ${index})`, () => {
      const registry = createDefaultActionRegistry();
      assert.throws(
        () => registry.prepareAction(action.type, action.params, "standalone check"),
        isConfigError("INVALID_ACTION_PARAMS"),
      );
      assert.throws(
        () => registry.createAction(action.type, action.params, "standalone check"),
        isConfigError("INVALID_ACTION_PARAMS"),
      );
    });
  }
});
