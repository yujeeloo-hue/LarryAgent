import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createAskGraphConfig,
  createPlanExecuteV3GraphConfig,
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { FSMConfigError } from "./FSMConfigError.js";
import { FSMGraph } from "./FSMGraph.js";
import {
  pinSlotKeysFromSchema,
  renameNodePin,
  ROUTE_TARGET_KEY,
} from "./pinRouting.js";
import { createFSMGraphConfig } from "./types.js";
import { validateFSMGraphConfig } from "./validateFSMGraphConfig.js";

describe("fsm pin model", () => {
  const registry = createDefaultActionRegistry();

  it("built-in graphs validate with pins + slot params (round-trip JSON)", () => {
    for (const factory of [
      createReactGraphConfig,
      createAskGraphConfig,
      createSubagentGraphConfig,
      createPlanExecuteV3GraphConfig,
    ]) {
      const config = factory();
      const json = JSON.stringify(config);
      const parsed = JSON.parse(json);
      validateFSMGraphConfig(parsed, registry);
      assert.equal(parsed.version, config.version);
      assert.ok(parsed.nodes.some((n: { pins?: unknown[] }) => (n.pins?.length ?? 0) > 0));
    }
  });

  it("rejects controlResult / activeRole edge keys", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        { id: "start", actions: [] },
        { id: "end", actions: [] },
      ],
      edges: [
        {
          from: "start",
          to: "end",
          type: "EdgeWhen",
          params: { turnKey: "controlResult", equals: "discarded" },
        },
      ],
    });
    assert.throws(
      () => validateFSMGraphConfig(config, registry),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "RETIRED_EDGE_KEY",
    );
  });

  it("rejects routeTarget edge whose equals is not a pin", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "a",
          pins: [{ name: "ok" }],
          selfLoop: true,
          actions: [],
        },
        { id: "end", actions: [] },
        { id: "start", actions: [] },
      ],
      edges: [
        { from: "start", to: "a", type: "EdgeAlways" },
        {
          from: "a",
          to: "end",
          type: "EdgeWhen",
          params: {
            turnKey: ROUTE_TARGET_KEY,
            equals: "missing",
            source: "node",
          },
        },
      ],
    });
    assert.throws(
      () => validateFSMGraphConfig(config, registry),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "PIN_EDGE_MISMATCH",
    );
  });

  it("rejects duplicate pin edges", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "a",
          pins: [{ name: "out" }],
          actions: [],
        },
        { id: "b", actions: [] },
        { id: "c", actions: [] },
        { id: "end", actions: [] },
        { id: "start", actions: [] },
      ],
      edges: [
        { from: "start", to: "a", type: "EdgeAlways" },
        {
          from: "a",
          to: "b",
          type: "EdgeWhen",
          params: { turnKey: ROUTE_TARGET_KEY, equals: "out", source: "node" },
        },
        {
          from: "a",
          to: "c",
          type: "EdgeWhen",
          params: { turnKey: ROUTE_TARGET_KEY, equals: "out", source: "node" },
        },
        { from: "b", to: "end", type: "EdgeAlways" },
        { from: "c", to: "end", type: "EdgeAlways" },
      ],
    });
    assert.throws(
      () => validateFSMGraphConfig(config, registry),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "DUPLICATE_PIN_EDGE",
    );
  });

  it("renameNodePin cascades slots and edges", () => {
    const config = createPlanExecuteV3GraphConfig();
    const schemaLookup = (type: string) =>
      registry.hasAction(type)
        ? registry.getActionParamsSchema(type)
        : undefined;
    const renamed = renameNodePin(
      config,
      "analyser",
      "plan_writer",
      "to_writer",
      schemaLookup,
    );
    const analyser = renamed.nodes.find((n) => n.id === "analyser");
    assert.ok(analyser?.pins?.some((p) => p.name === "to_writer"));
    assert.ok(!analyser?.pins?.some((p) => p.name === "plan_writer"));
    const advance = (analyser?.actions ?? []).find(
      (a) => a.type === "NodeActionRouteTo",
    );
    const routes = advance?.params?.routes as
      | Array<{ event: string; to: string }>
      | undefined;
    assert.ok(Array.isArray(routes));
    assert.equal(
      routes.find((r) => r.event === "stay")?.to,
      "analyser",
    );
    assert.equal(
      routes.find((r) => r.event === "leave")?.to,
      "skill_reflect_gate",
    );
    assert.equal(
      routes.find((r) => r.event === "plan")?.to,
      "to_writer",
    );
    const edge = renamed.edges.find(
      (e) =>
        e.from === "analyser" &&
        e.to === "plan_writer" &&
        (e.params as { equals?: string })?.equals === "to_writer",
    );
    assert.ok(edge);
  });

  it("Route to schema uses unified route-to editor with hidden when/routes", () => {
    const schema = registry.getActionParamsSchema("NodeActionRouteTo");
    const { selectKeys, mapKeys, bindingKeys } = pinSlotKeysFromSchema(schema);
    assert.equal(selectKeys.includes("onStay"), false);
    assert.equal(mapKeys.includes("routes"), false);
    assert.ok(bindingKeys.includes("routes"));
    assert.ok(bindingKeys.includes("when"));
    assert.equal(schema["x-ui"], "route-to");
    assert.equal(schema.properties?.routes?.["x-ui"], "hidden");
    assert.equal(schema.properties?.when?.["x-ui"], "hidden");
    assert.equal(schema.title, "Route to");
    assert.ok(schema["x-emitsRouteEvents"]?.includes("stay"));
  });

  it("EmitRouteEvent declares emitted route events", () => {
    const schema = registry.getActionParamsSchema("NodeActionEmitRouteEvent");
    assert.ok(schema["x-emitsRouteEvents"]?.includes("doc_written"));
    assert.ok(schema["x-emitsRouteEvents"]?.includes("direct"));
  });

  it("ApplyToolEffects does not declare route events", () => {
    const schema = registry.getActionParamsSchema(
      "NodeActionApplyToolEffects",
    );
    assert.equal(schema["x-emitsRouteEvents"], undefined);
  });

  it("PrepareRole exposes identity and execution settings separately", () => {
    const schema = registry.getActionParamsSchema("NodeActionPrepareRole");
    const roleKind = schema.properties?.roleKind;
    assert.equal(roleKind?.["x-ui"], "text");
    assert.equal(roleKind?.enum, undefined);
    assert.equal(roleKind?.title, "Role identity");
    assert.equal(schema.properties?.phaseOverlay, undefined);
    assert.equal(schema.properties?.rolePromptInline?.["x-showWhen"], undefined);
    assert.ok(schema.properties?.promptPreset?.enum?.includes("planner"));
    assert.deepEqual(schema.properties?.promptPlacement?.enum, ["persona", "system", "overlay"]);
    assert.equal(schema.properties?.subagentRole, undefined);
    const action = registry.createAction(
      "NodeActionPrepareRole",
      { roleKind: "planner" },
      "test",
    );
    assert.equal(action.type, "NodeActionPrepareRole");
  });

  it("PromptInject schema exposes source enum + conditional note / routeGuide", () => {
    const schema = registry.getActionParamsSchema("NodeActionPromptInject");
    assert.equal(schema.title, "Prompt inject");
    assert.deepEqual(schema.properties?.source?.enum, [
      "note",
      "routeGuide",
      "plan",
      "planDoc",
      "pendingPlanDraft",
      "phase",
      "blackboard",
    ]);
    assert.deepEqual(schema.properties?.placement?.enum, ["overlay", "system"]);
    assert.equal(schema.properties?.placement?.default, "overlay");
    assert.deepEqual(schema.properties?.frequency?.enum, [
      "everyRound",
      "oncePerNode",
    ]);
    assert.equal(schema.properties?.frequency?.default, "everyRound");
    assert.deepEqual(schema.properties?.frequency?.["x-showWhen"], {
      placement: "overlay",
    });
    assert.equal(schema.properties?.source?.["x-ui"], "select");
    assert.equal(schema.properties?.note?.["x-ui"], "collapsible-textarea");
    assert.deepEqual(schema.properties?.note?.["x-showWhen"], {
      source: "note",
    });
    assert.equal(schema.properties?.routeGuide?.["x-ui"], "route-guide");
    assert.deepEqual(schema.properties?.routeGuide?.["x-showWhen"], {
      source: "routeGuide",
    });
    // BuildNodeOverlay is gone from the registry (migrations expand it).
    assert.equal(registry.hasAction("NodeActionBuildNodeOverlay"), false);
  });
  it("PrepareRole accepts arbitrary role identities", () => {
    assert.equal(registry.createAction(
          "NodeActionPrepareRole",
          { roleKind: "my_custom_role" },
          "test",
        ).type, "NodeActionPrepareRole");
  });

  it("hydrate + run react graph after JSON round-trip", async () => {
    const raw = JSON.parse(JSON.stringify(createReactGraphConfig()));
    validateFSMGraphConfig(raw, registry);
    const result = await FSMGraph.run(raw, {}, { registries: registry });
    assert.equal(result.reason, "end_node");
  });
});
