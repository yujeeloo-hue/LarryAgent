import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CompositeNodeActionBase } from "./CompositeNodeActionBase.js";
import { FSMConfigError } from "./FSMConfigError.js";
import { FSMGraph } from "./FSMGraph.js";
import { FSMRegistry } from "./FSMRegistry.js";
import { Node } from "./Node.js";
import { NodeActionBase } from "./NodeActionBase.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { collectEmittedRouteEvents } from "./actions/routeEvents.js";
import { EMPTY_PARAMS_SCHEMA, LOOSE_PARAMS_SCHEMA } from "./paramsSchema.js";
import { createFSMGraphConfig, type NodeActionConfig, type NodeActionExecArgs, type NodeActionExecResult } from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";

class Sequence extends CompositeNodeActionBase {
  readonly type = "Sequence";
}

class Probe extends NodeActionBase {
  readonly type = "Probe";
  runs = 0;
  constructor(private readonly exec: (args: NodeActionExecArgs, run: number) => NodeActionExecResult) { super(); }
  Exec(args: NodeActionExecArgs): NodeActionExecResult { return this.exec(args, ++this.runs); }
}

function graph(action: NodeActionConfig, pins = ["end"]) {
  return createFSMGraphConfig({
    entryNodeId: "start", nodes: [
      { id: "start", pins: pins.map((name) => ({ name })), actions: [action] }, { id: "end" },
    ], edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
  });
}

function round(steps: unknown[]): NodeActionConfig {
  return { type: "NodeActionRoleRoundBuilder", params: { steps } };
}

function configError(code: FSMConfigError["code"], pattern: RegExp) {
  return (error: unknown) => error instanceof FSMConfigError && error.code === code && pattern.test(error.message);
}

describe("unified composite Action descriptions", () => {
  it("prepares recursive children without constructing anything, then uses the same registry and normalized params", async () => {
    let descriptions = 0;
    let creations = 0;
    const registry = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: LOOSE_PARAMS_SCHEMA,
      describeChildren: (params) => { descriptions += 1; return params.steps as NodeActionConfig[]; },
      create: (_params, { children }) => { creations += 1; return new Sequence(children); },
    }).registerAction({
      type: "Probe", paramsSchema: { type: "object", properties: { value: { type: "integer", default: "3" } } },
      validate: (params) => assert.equal(params.value, 3),
      create: (params) => {
        creations += 1;
        return new Probe((args, run) => ({ status: "continue", turnContextPatch: {
          values: [...(args.turnContext.values as number[] ?? []), params.value], run,
        } }));
      },
    });
    const config = graph({ type: "Sequence", params: { steps: [
      { type: "Sequence", params: { steps: [{ type: "Probe" }] } },
    ] } });
    const before = structuredClone(config);
    const prepared = validateFSMGraphConfig(config, registry).preparedActionsByNode.get("start")![0]!;
    assert.equal(creations, 0);
    assert.equal(descriptions, 2);
    assert.equal(prepared.children[0]!.children[0]!.params.value, 3);
    const hydrated = FSMGraph.fromConfig(config, registry);
    assert.equal(creations, 3);
    const sequence = hydrated.getNode("start")!.getActions()[0]!;
    const leaf = sequence.getChildren()[0]!.getChildren()[0]!;
    for (const run of [1, 2]) {
      const result = await hydrated.execute({});
      assert.equal(result.turnContext.run, run);
      assert.deepEqual(result.turnContext.values, [3]);
      assert.equal(sequence.getChildren()[0]!.getChildren()[0], leaf);
    }
    assert.equal(creations, 3);
    assert.deepEqual(config, before);
  });

  it("constructs no parent or child when a later nested semantic check fails", () => {
    let creations = 0;
    const registry = createDefaultActionRegistry().registerAction({
      type: "Probe", paramsSchema: EMPTY_PARAMS_SCHEMA,
      create: () => { creations += 1; return new Probe(() => ({ status: "continue" })); },
    });
    assert.throws(() => FSMGraph.fromConfig(graph(round([
      { type: "Probe" }, round([{ type: "NodeActionCompare", params: {
        key: "count", asKey: "flag", type: "int", value: "bad",
      } }]),
    ])), registry), configError("INVALID_ACTION_PARAMS", /action #0.*child #1.*child #0/));
    assert.equal(creations, 0);
  });

  it("describes custom children from parent schema defaults without requiring a steps field", async () => {
    const registry = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: { type: "object", properties: { amount: { type: "integer", default: "7" } } },
      describeChildren: (params) => {
        assert.equal(params.amount, 7);
        return [{ type: "Probe", params: { value: params.amount } }];
      },
      create: (_params, { children }) => new Sequence(children),
    }).registerAction({
      type: "Probe", paramsSchema: { type: "object", properties: { value: { type: "integer" } } },
      create: (params) => new Probe(() => ({ status: "continue", turnContextPatch: { value: params.value } })),
    });
    const result = await FSMGraph.run(graph({ type: "Sequence" }), {}, { registries: registry });
    assert.equal(result.turnContext.value, 7);
  });

  it("validates nested schemas and unknown types with the complete child path", () => {
    const cases: Array<{ action: NodeActionConfig; code: FSMConfigError["code"] }> = [
      { action: { type: "NodeActionRunShell", params: {} }, code: "INVALID_ACTION_PARAMS" },
      { action: { type: "NodeActionPrepareTools", params: { toolPolicy: "invalid" } }, code: "INVALID_ACTION_PARAMS" },
      { action: { type: "UnknownChild" }, code: "UNKNOWN_ACTION" },
      { action: { type: "NodeActionRecallTurnMemory" }, code: "UNKNOWN_ACTION" },
    ];
    for (const { action, code } of cases) {
      assert.throws(() => FSMGraph.fromConfig(graph(round([round([action])])), createDefaultActionRegistry()),
        configError(code, /action #0.*child #0.*child #0/));
    }
  });

  it("does not erase malformed modern child entries or treat them as an empty sequence", () => {
    for (const step of [null, "ignored", {}, { type: "" }, { type: "NodeActionRoundGate", params: null },
      { type: "NodeActionRoundGate", params: [] }, { type: "NodeActionRoundGate", params: "bad" }]) {
      assert.throws(() => validateFSMGraphConfig(graph(round([step])), createDefaultActionRegistry()), FSMConfigError);
    }
    assert.doesNotThrow(() => validateFSMGraphConfig(graph(round([])), createDefaultActionRegistry()));
  });

  it("validates Pins in explicit children and generated default children", () => {
    const actions = [
      round([round([{ type: "NodeActionRouteTo", params: { routes: [{ event: "leave", to: "missing" }] } }])]),
      { type: "NodeActionRoleRoundBuilder", params: { routeTo: { when: [{ expr: "flag", to: "missing" }] } } },
      { type: "NodeActionRoleRoundBuilder", params: {
        detectStepClaim: true, onStepClaim: "missing", routeTo: { routes: [{ event: "leave", to: "end" }] },
      } },
    ];
    for (const action of actions) {
      assert.throws(() => validateFSMGraphConfig(graph(action), createDefaultActionRegistry()),
        configError("INVALID_PIN", /child #.*missing/));
    }
  });

  it("checks Pin references introduced by a custom child schema default", () => {
    const registry = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: EMPTY_PARAMS_SCHEMA,
      describeChildren: () => [{ type: "Probe" }], create: (_params, { children }) => new Sequence(children),
    }).registerAction({
      type: "Probe", paramsSchema: { type: "object", properties: {
        onDone: { type: "string", default: "missing", "x-ui": "pin-select" },
      } }, create: () => new Probe(() => ({ status: "continue" })),
    });
    assert.throws(() => validateFSMGraphConfig(graph({ type: "Sequence" }), registry),
      configError("INVALID_PIN", /child #0.*missing/));
  });

  it("validates nested default role/tool/step settings before the round starts", () => {
    for (const params of [
      {},
      { routeTo: {}, detectStepClaim: true },
      { routeTo: {}, prepareRole: { modelBinding: "bad" } },
      { routeTo: {}, prepareTools: { toolPolicy: "bad" } },
      { routeTo: {}, syncPlanStep: { mode: "bad" } },
    ]) {
      assert.throws(() => validateFSMGraphConfig(graph({ type: "NodeActionRoleRoundBuilder", params }), createDefaultActionRegistry()), FSMConfigError);
    }
  });

  it("cloning a registry preserves the child descriptor and child override", async () => {
    const registry = createDefaultActionRegistry().registerAction({
      type: "Probe", paramsSchema: EMPTY_PARAMS_SCHEMA,
      create: () => new Probe(() => ({ status: "continue", turnContextPatch: { custom: true } })),
    });
    const action = registry.clone().createAction(round([{ type: "Probe" }]).type, { steps: [{ type: "Probe" }] }, "clone");
    assert.equal(action.getChildren()[0]!.type, "Probe");
    assert.equal((await action.Exec({ turnContext: {}, nodeContext: {} })).turnContextPatch!.custom, true);
  });

  it("rejects malformed or recursive descriptor output with a configuration error", () => {
    const recursive = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: EMPTY_PARAMS_SCHEMA,
      describeChildren: () => [{ type: "Sequence" }], create: (_params, { children }) => new Sequence(children),
    });
    assert.throws(() => recursive.prepareAction("Sequence", {}, "recursive"),
      configError("INVALID_ACTION_PARAMS", /recursive child description/));
    const malformed = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: EMPTY_PARAMS_SCHEMA,
      describeChildren: () => undefined as unknown as NodeActionConfig[],
      create: (_params, { children }) => new Sequence(children),
    });
    assert.throws(() => malformed.prepareAction("Sequence", {}, "malformed"),
      configError("INVALID_ACTION_PARAMS", /describeChildren must return an array/));
  });

  it("rejects a composite factory that discards or replaces its prepared children", () => {
    const registry = FSMRegistry.createDefault().registerAction({
      type: "Sequence", paramsSchema: EMPTY_PARAMS_SCHEMA,
      describeChildren: () => [{ type: "Probe" }], create: () => new Sequence([]),
    }).registerAction("Probe", () => new Probe(() => ({ status: "continue" })));
    assert.throws(() => registry.createAction("Sequence", {}, "broken factory"),
      configError("INVALID_ACTION_PARAMS", /must expose the children supplied/));
  });
});

describe("composite execution and route metadata", () => {
  it("exposes nested routing events before any child executes", async () => {
    const registry = createDefaultActionRegistry().registerAction("Probe", () => new Probe((args) => {
      assert.deepEqual(args.nodeContext.boundRouteEvents, ["review", "leave"]);
      return { status: "continue", nodeContextPatch: { routeEvent: "review" } };
    }));
    const action = registry.createAction("NodeActionRoleRoundBuilder", { steps: [
      { type: "Probe" }, round([{ type: "NodeActionRouteTo", params: { routes: [
        { event: "review", to: "end" }, { event: "leave", to: "end" },
      ] } }]),
    ] }, "round");
    const result = await new Node({ id: "start", actions: [action] }).run({});
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContext.routeTarget, "end");
  });

  it("default role-round routing events also reach Node before tools execute", async () => {
    const registry = createDefaultActionRegistry().registerAction({
      type: "NodeActionRunTools", paramsSchema: EMPTY_PARAMS_SCHEMA,
      create: () => new Probe((args) => {
        assert.deepEqual(args.nodeContext.boundRouteEvents, ["leave", "custom"]);
        return { status: "continue", nodeContextPatch: { routeEvent: "custom" } };
      }),
    });
    const action = registry.createAction("NodeActionRoleRoundBuilder", {
      awaitSubagents: false, routeTo: { routes: [{ event: "leave", to: "end" }, { event: "custom", to: "end" }] },
    }, "default round");
    const result = await new Node({ id: "start", actions: [action] }).run({});
    assert.equal(result.status, "continue");
    assert.equal(result.nodeContext.routeTarget, "end");
  });

  it("fixed verify/commit composites use overrides from the caller's registry", async () => {
    const order: string[] = [];
    const registry = createDefaultActionRegistry().registerAction({
      type: "NodeActionVerifyStep", paramsSchema: EMPTY_PARAMS_SCHEMA,
      create: () => new Probe(() => { order.push("verify"); return { status: "continue", turnContextPatch: { verified: true } }; }),
    }).registerAction({
      type: "NodeActionCommitStep", paramsSchema: LOOSE_PARAMS_SCHEMA,
      create: (params) => new Probe((args) => {
        order.push("commit"); assert.equal(args.turnContext.verified, true);
        assert.equal(params.onResume, "end");
        return { status: "continue", nodeContextPatch: { routeTarget: "end" } };
      }),
    });
    const hydrated = FSMGraph.fromConfig(graph({ type: "NodeActionValidateCommitStep", params: { onResume: "end", onReflect: "end" } }), registry);
    const result = await hydrated.execute({});
    assert.equal(result.reason, "end_node");
    assert.deepEqual(order, ["verify", "commit"]);
  });

  it("preserves earlier child patches and the halt child's patches, skipping later children", async () => {
    const skipped = new Probe(() => { assert.fail("must not execute after halt"); });
    const sequence = new Sequence([
      new Probe(() => ({ status: "continue", turnContextPatch: { before: 1 }, nodeContextPatch: { first: true } })),
      new Sequence([new Probe((args) => {
        assert.equal(args.turnContext.before, 1);
        return { status: "halt", errorMessage: "stopped", turnContextPatch: { halted: true }, nodeContextPatch: { last: true } };
      })]), skipped,
    ]);
    const result = await new Node({ id: "start", actions: [sequence] }).run({ seed: "kept" });
    assert.equal(result.status, "halt");
    assert.equal(result.errorMessage, "stopped");
    assert.deepEqual(result.turnContext, { seed: "kept", before: 1, halted: true });
    assert.deepEqual(result.nodeContext, { first: true, last: true });
    assert.equal(skipped.runs, 0);
  });

  it("collects emitted event hints recursively from the same prepared descriptions", () => {
    const registry = createDefaultActionRegistry();
    const prepared = registry.prepareAction("NodeActionRoleRoundBuilder", { steps: [round([
      { type: "NodeActionCheckPlan", params: { onIncomplete: "custom_resume" } },
      { type: "NodeActionPromptInject", params: { source: "routeGuide", routeGuide: [{ when: "x", routeTo: "custom_route" }] } },
    ])] }, "event hints");
    const events = collectEmittedRouteEvents([prepared], (type) => registry.getActionParamsSchema(type));
    assert.ok(events.includes("custom_resume"));
    assert.ok(events.includes("custom_route"));
  });
});
