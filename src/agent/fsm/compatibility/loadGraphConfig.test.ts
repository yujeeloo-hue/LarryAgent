import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { FSMConfigError } from "../FSMConfigError.js";
import { FSMGraph } from "../FSMGraph.js";
import { FSMRegistry } from "../FSMRegistry.js";
import { createDefaultActionRegistry } from "../actions/createDefaultActionRegistry.js";
import { createFSMGraphConfig, type NodeActionConfig } from "../types.js";
import { loadGraphConfig } from "./loadGraphConfig.js";
import { migrateActionParams } from "./legacyActionParams.js";

function graph(actions: NodeActionConfig[] = [], id = "review") {
  return createFSMGraphConfig({
    entryNodeId: id,
    nodes: [{ id, selfLoop: true, pins: [{ name: id }, { name: "end" }], actions }, { id: "end" }],
    edges: [{ from: id, to: "end", type: "EdgeAlways" }],
  });
}

describe("versioned graph input boundary", () => {
  it("upgrades v1 once without changing the input, and returns v2 unchanged", () => {
    const legacy = { ...graph([{ type: "NodeActionBumpReplanCount" }]), version: 1 };
    const before = structuredClone(legacy);
    const loaded = loadGraphConfig(legacy);
    assert.equal(loaded.config.version, 2);
    assert.equal(loaded.migrated, true);
    assert.deepEqual(loaded.migrations, [{ from: 1, to: 2 }]);
    assert.deepEqual(loaded.config.nodes[0]!.actions, [{
      type: "NodeActionWriteBlackboard", params: { key: "replanCount", mode: "increment" },
    }]);
    assert.deepEqual(legacy, before);
    const again = loadGraphConfig(loaded.config);
    assert.equal(again.config, loaded.config);
    assert.equal(again.migrated, false);
    assert.deepEqual(again.migrations, []);
  });

  it("never rewrites v2 role labels, legacy-looking strings or business node names", () => {
    const config = graph([
      { type: "NodeActionPrepareRole", params: { roleKind: "planner", rolePromptInline: "reflect_done" } },
      { type: "NodeActionWriteBlackboard", params: { key: "text", value: "reflect" } },
    ], "skill_reflect_gate");
    const before = structuredClone(config);
    assert.equal(loadGraphConfig(config).config, config);
    assert.deepEqual(config, before);
  });

  for (const version of [undefined, null, 0, 3, "1", "2"]) {
    it(`rejects unsupported version ${String(version)}`, () => {
      assert.throws(() => loadGraphConfig({ ...graph(), version }),
        (error: unknown) => error instanceof FSMConfigError && error.code === "INVALID_VERSION");
    });
  }

  for (const raw of [null, [], {}, { version: 1, nodes: [null], edges: [] },
    { version: 1, nodes: [{ id: "review", actions: [null] }], edges: [] },
    { version: 1, nodes: [{ id: "review", pins: [null] }], edges: [] },
    { version: 1, nodes: [{ id: "review" }], edges: [null] }]) {
    it(`rejects malformed graph input ${JSON.stringify(raw)}`, () => {
      assert.throws(() => loadGraphConfig(raw), FSMConfigError);
    });
  }

  it("leaves v2 aliases for strict registry validation instead of silently repairing them", () => {
    const config = graph([{ type: "NodeActionBumpReplanCount" }]);
    assert.throws(() => FSMGraph.fromConfig(loadGraphConfig(config).config, createDefaultActionRegistry()),
      (error: unknown) => error instanceof FSMConfigError && error.code === "UNKNOWN_ACTION");
  });

  it("rejects malformed params before migration can replace or drop them", () => {
    for (const params of [null, [], "invalid"]) {
      assert.throws(() => loadGraphConfig({ ...graph(), version: 1, nodes: [
        { id: "review", actions: [{ type: "NodeActionSetPhase", params }] }, { id: "end" },
      ] }), (error: unknown) => error instanceof FSMConfigError && error.code === "INVALID_ACTION_PARAMS");
      assert.throws(() => loadGraphConfig({ ...graph(), version: 1, edges: [
        { from: "review", to: "end", type: "EdgeWhen", params },
      ] }), (error: unknown) => error instanceof FSMConfigError && error.code === "INVALID_EDGE_PARAMS");
    }
  });
});

describe("v1 migration scope", () => {
  it("only rewrites declared Pin fields and routeTarget edge values", () => {
    const actions: NodeActionConfig[] = [
      { type: "NodeActionPrepareRole", params: {
        roleKind: "custom", personaLabel: "reflect", promptPlacement: "system",
        rolePromptInline: "reflect_done", modelBinding: "provider", modelProviderId: "step_claim",
        waitingMessage: "reflect_done",
      } },
      { type: "NodeActionWriteBlackboard", params: {
        key: "text", value: { reflect: "reflect_done", to: "step_claim" },
      } },
      { type: "NodeActionPromptInject", params: { source: "note", note: "reflect_done" } },
      { type: "NodeActionCompare", params: { key: "text", type: "string", value: "reflect_done", asKey: "flag" } },
      { type: "NodeActionEmitRouteEventWhen", params: { key: "text", type: "string", value: "reflect", event: "reflect_done" } },
      { type: "NodeActionDetectStepClaim", params: { onStepClaim: "step_claim" } },
      { type: "NodeActionRouteTo", params: { when: [{ expr: "reflect_done", to: "reflect_done" }], defaultPin: "reflect" } },
      { type: "Extension", params: { value: "reflect_done", routes: { reflect: "step_claim" }, when: [{ to: "reflect" }] } },
    ];
    const config = { ...graph(actions), version: 1, edges: [
      { from: "review", to: "end", type: "EdgeWhen", params: { turnKey: "routeTarget", equals: "reflect_done" } },
      { from: "review", to: "end", type: "EdgeWhen", params: { turnKey: "text", equals: "reflect_done" } },
    ] };
    const loaded = loadGraphConfig(config).config;
    assert.deepEqual(loaded.nodes[0]!.actions!.slice(0, 5), actions.slice(0, 5));
    assert.deepEqual(loaded.nodes[0]!.actions![5]!.params, { onStepClaim: "execution_validator" });
    assert.deepEqual(loaded.nodes[0]!.actions![6]!.params, {
      when: [{ expr: "reflect_done", to: "end" }], defaultPin: "skill_reflect_gate",
    });
    assert.deepEqual(loaded.nodes[0]!.actions![7], actions[7]);
    assert.equal(loaded.edges[0]!.params!.equals, "end");
    assert.equal(loaded.edges[1]!.params!.equals, "reflect_done");
  });

  it("preserves extension type names that match JavaScript object properties", () => {
    for (const type of ["constructor", "toString", "__proto__"]) {
      const config = { ...graph([{ type, params: { text: "reflect_done" } }], type), version: 1 };
      const loaded = loadGraphConfig(config).config;
      assert.deepEqual(loaded.nodes[0], config.nodes[0]);
    }
  });

  it("does not infer a reflection stack or planner state from node names", () => {
    for (const id of ["skill_reflect_gate", "skill_reflector", "planner", "replanner"]) {
      const actions: NodeActionConfig[] = [{ type: "Extension", params: { value: "reflect" } }];
      const config = { ...graph(actions, id), version: 1 };
      const loaded = loadGraphConfig(config).config;
      assert.deepEqual(loaded.nodes, config.nodes);
      assert.deepEqual(loaded.edges, config.edges);
    }
  });

  it("only adds planning state for the historical planner role shape", () => {
    const tail = [
      { type: "NodeActionApplyToolEffects", params: {} },
      { type: "NodeActionEmitRouteEvent", params: {} },
    ];
    for (const role of [
      { roleKind: "custom" },
      { roleKind: "planner", personaLabel: "REVIEW", modelBinding: "sessionDefault", promptPlacement: "system" },
    ]) {
      const config = { ...graph([{ type: "NodeActionPrepareRole", params: role }, ...tail], "planner"), version: 1 };
      const actions = loadGraphConfig(config).config.nodes[0]!.actions!;
      assert.equal(actions.some((action) => action.type === "NodeActionCheckPlan"), false);
      assert.equal(actions.some((action) => action.type === "NodeActionWriteBlackboard"), false);
      assert.equal(actions.some((action) => action.type === "NodeActionPromptInject"), false);
    }
    const legacy = { ...graph([{ type: "NodeActionPrepareRole", params: { roleKind: "planner" } }, ...tail], "planner"), version: 1 };
    const actions = loadGraphConfig(legacy).config.nodes[0]!.actions!;
    assert.deepEqual(actions.find((action) => action.type === "NodeActionWriteBlackboard")!.params,
      { key: "phase", scope: "session", value: "planning" });
    assert.equal(actions.at(-1)!.type, "NodeActionCheckPlan");
  });

  it("preserves mixed flag/event routes and explicit custom phase-resume defaults", () => {
    const route = { type: "NodeActionRouteTo", params: {
      when: [{ expr: "flag", to: "end" }], routes: [{ event: "leave", to: "end" }],
      onlyIfRouteTargetUnset: true,
    } };
    const mixed = loadGraphConfig({ ...graph([route]), version: 1 });
    assert.deepEqual(mixed.config.nodes[0]!.actions![0], route);
    const resumed = loadGraphConfig({ ...graph([{ type: "NodeActionStartTurn", params: {
      initialActiveRole: "review", phaseResume: { custom: "end" },
    } }]), version: 1 });
    const params = resumed.config.nodes[0]!.actions!.find((action) => action.type === "NodeActionRouteTo")!.params!;
    assert.equal(params.defaultPin, "review");
    assert.deepEqual(params.when, [{ expr: "resume.phase.custom", to: "end" }]);
  });

  it("uses the containing node for retired router defaults, including nested rounds", () => {
    const config = { ...graph([
      { type: "NodeActionRouteAfterRound", params: { onLeave: "reflect_done" } },
      { type: "NodeActionRoleRoundBuilder", params: { steps: [
        { type: "NodeActionRouteAfterRound", params: {} }, { type: "NodeActionBumpReplanCount" },
      ] } },
    ]), version: 1 };
    const actions = loadGraphConfig(config).config.nodes[0]!.actions!;
    assert.deepEqual(actions[0]!.params!.routes, [
      { event: "leave", to: "end" }, { event: "stay", to: "review" },
    ]);
    assert.deepEqual(actions[1]!.params!.steps, [
      { type: "NodeActionRouteTo", params: { routes: [{ event: "stay", to: "review" }] } },
      { type: "NodeActionWriteBlackboard", params: { key: "replanCount", mode: "increment" } },
    ]);
    assert.throws(() => migrateActionParams("NodeActionRouteTo", {}, undefined, "NodeActionRouteAfterRound"),
      /containing node id/);
  });

  it("keeps missing modern route bindings empty instead of inventing agent routes", async () => {
    const loaded = loadGraphConfig({ ...graph([{ type: "NodeActionRouteTo", params: {} }]), version: 1 });
    assert.deepEqual(loaded.config.nodes[0]!.actions![0]!.params, {});
    const result = await FSMGraph.run(loaded.config, {}, { registries: createDefaultActionRegistry() });
    assert.equal(result.reason, "halt");
    assert.match(result.errorMessage!, /no route mappings/);
  });

  it("converts legacy child expansions and embedded composite parameters", () => {
    const config = { ...graph([
      { type: "NodeActionRoleRoundBuilder", params: { steps: [
        { type: "NodeActionBuildNodeOverlay", params: { phaseOverlay: "reflect_done", includePlan: true } },
        { type: "NodeActionSetPhase", params: { phase: "reflect_done" } },
        { type: "NodeActionApplyPlanEffects", params: { bumpReplanCount: true } },
      ] } },
      { type: "NodeActionRoleRoundBuilder", params: {
        prepareRole: { roleKind: "executor", progressLabel: "reflect_done" },
        prepareTools: { askMode: true },
        routeTo: { onStay: "review", onReflect: "reflect_done" },
      } },
    ]), version: 1 };
    const actions = loadGraphConfig(config).config.nodes[0]!.actions!;
    assert.deepEqual(actions[0]!.params!.steps, [
      { type: "NodeActionPromptInject", params: { source: "note", note: "reflect_done" } },
      { type: "NodeActionPromptInject", params: { source: "plan" } },
      { type: "NodeActionWriteBlackboard", params: { key: "phase", scope: "session", value: "reflect_done" } },
      { type: "NodeActionWriteBlackboard", params: { key: "replanCount", mode: "increment" } },
    ]);
    const composite = actions[1]!.params!;
    const role = composite.prepareRole as Record<string, unknown>;
    assert.equal(role.modelBinding, "executor");
    assert.equal(role.waitingMessage, "reflect_done");
    assert.deepEqual(composite.syncPlanStep, { mode: "current" });
    assert.ok(Array.isArray((composite.prepareTools as Record<string, unknown>).allowTools));
    assert.deepEqual(composite.routeTo, { routes: [
      { event: "stay", to: "review" }, { event: "leave", to: "end" },
    ] });
  });

  it("expands actual legacy reflector structure and does not share mutable preset data", () => {
    const legacy = { ...graph([{ type: "NodeActionSkillReflectRound" }], "skill_reflector"), version: 1 };
    const first = loadGraphConfig(legacy).config;
    assert.ok(first.nodes.some((node) => node.id === "skill_reflect_gate"));
    assert.ok(first.nodes[0]!.actions!.some((action) => action.type === "NodeActionPrepareRole"));
    FSMGraph.fromConfig(first, createDefaultActionRegistry());
    first.nodes.find((node) => node.id === "skill_reflect_gate")!.actions![0]!.params!.asKey = "changed";
    const second = loadGraphConfig(legacy).config;
    assert.equal(second.nodes.find((node) => node.id === "skill_reflect_gate")!.actions![0]!.params!.asKey, "reflect.auto");
  });

  it("the registry accepts only registered names and current parameter schemas", () => {
    const registry = createDefaultActionRegistry();
    assert.equal(registry.hasAction("NodeActionStreamModelRound"), false);
    assert.throws(() => registry.getActionParamsSchema("NodeActionStreamModelRound"), FSMConfigError);
    assert.throws(() => registry.getActionFactory("NodeActionStreamModelRound"), FSMConfigError);
    const prepared = registry.prepareAction("NodeActionCallModel", { progressLabel: "old" }, "test");
    assert.equal(prepared.params.progressLabel, "old");
    assert.equal(Object.hasOwn(prepared.params, "waitingMessage"), false);
    const extension = FSMRegistry.createDefault().registerAction("NodeActionBumpReplanCount", () => {
      throw new Error("only inspecting registration");
    });
    assert.equal(extension.prepareAction("NodeActionBumpReplanCount", { value: "reflect_done" }, "test").params.value, "reflect_done");
  });
});

describe("compatibility dependency boundary", () => {
  it("registry and core runtime imports never reach compatibility or business action presets", () => {
    const visited = new Set<string>();
    function walk(path: string): void {
      if (visited.has(path)) return;
      visited.add(path);
      const source = readFileSync(path, "utf8");
      for (const match of source.matchAll(/import\s+(?!type\b)[\s\S]*?\sfrom\s+["']([^"']+)["'];/g)) {
        const specifier = match[1]!;
        if (!specifier.startsWith(".")) continue;
        assert.doesNotMatch(specifier, /compatibility|actionTypeMigration|configs\/|actions\//, path);
        walk(resolve(dirname(path), specifier.replace(/\.js$/, ".ts")));
      }
    }
    for (const entry of ["FSMRegistry", "FSMGraph", "validateFSMGraphConfig"]) {
      walk(fileURLToPath(new URL(`../${entry}.ts`, import.meta.url)));
    }
    const compatibilityRoot = dirname(fileURLToPath(import.meta.url));
    for (const file of ["legacyPresets.ts", "legacyRoles.ts", "legacyTopology.ts", "migrations/v1ToV2.ts"]) {
      assert.doesNotMatch(readFileSync(resolve(compatibilityRoot, file), "utf8"), /from ["'][^"']*(configs\/|actions\/|roles\/)/);
    }
  });
});
