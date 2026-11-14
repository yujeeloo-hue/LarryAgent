import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import {
  createReactGraphConfig,
  createSubagentGraphConfig,
} from "./configs/sampleGraphs.js";
import { FSMConfigError } from "./FSMConfigError.js";
import { FSMGraph } from "./FSMGraph.js";
import { createFSMGraphConfig } from "./types.js";

describe("fsm default action registry + sample graphs", () => {
  it("exposes paramsSchema catalog for the editor", () => {
    const registry = createDefaultActionRegistry();
    const catalog = registry.listActionCatalog();
    assert.ok(catalog.length >= 16);
    const prepare = catalog.find((c) => c.type === "NodeActionPrepareRole");
    assert.ok(prepare);
    assert.deepEqual(prepare?.paramsSchema.required, ["roleKind"]);
  });

  it("runs react sample graph to end", async () => {
    const result = await FSMGraph.run(
      createReactGraphConfig(),
      {},
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "agent",
      "skill_reflect_gate",
      "end",
    ]);
    // activeRole single ledger: scope.turnState (no turnContext mirror);
    // the agent visit above proves the role. Legacy routing keys are gone
    // (canaries live in retiredRoutingKeys.test.ts).
    assert.equal(result.turnContext.turnStarted, true);
    assert.equal((result.turnContext as Record<string, unknown>).activeRole, undefined);
    assert.equal(result.turnContext.finishedIdle, true);
  });

  it("loops agent once when stubForceToolCalls is set", async () => {
    const result = await FSMGraph.run(
      createReactGraphConfig(),
      { stubForceToolCalls: true },
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    assert.ok((result.nodesVisited.filter((id) => id === "agent").length) >= 2);
    assert.ok(result.nodesVisited.includes("skill_reflect_gate"));
    // Last round had no tools — toolsRan is round-scoped (nodeContext) now,
    // so nothing sticky can survive on turnContext.
    assert.equal((result.turnContext as Record<string, unknown>).toolsRan, undefined);
  });

  it("react config routes pre-end through skill reflect gate (V3)", () => {
    const config = createReactGraphConfig();
    const ids = new Set(config.nodes.map((n) => n.id));
    assert.ok(ids.has("skill_reflect_gate"));
    assert.ok(ids.has("skill_reflector"));
    const startTurn = config.nodes
      .find((n) => n.id === "start")
      ?.actions?.find((a) => a.type === "NodeActionStartTurn");
    assert.equal(
      (startTurn?.params as { phaseResume?: unknown }).phaseResume,
      undefined,
      "React StartTurn must not carry legacy phaseResume",
    );
    assert.ok(
      config.edges.some(
        (e) =>
          e.from === "agent" &&
          e.to === "skill_reflect_gate" &&
          (e.params as { turnKey?: string }).turnKey === "routeTarget" &&
          (e.params as { equals?: unknown }).equals === "skill_reflect_gate" &&
          (e.params as { source?: string }).source === "node",
      ),
    );
    assert.equal(
      config.nodes.find((n) => n.id === "skill_reflector")?.selfLoop,
      true,
      "skill_reflector must self-loop via the node selfLoop flag",
    );
    assert.ok(
      config.edges.some(
        (e) =>
          e.from === "skill_reflector" &&
          e.to === "end" &&
          (e.params as { equals?: unknown }).equals === "end",
      ),
    );
    assert.ok(
      !config.edges.some(
        (e) => e.from === "skill_reflector" && e.to === "agent",
      ),
    );
  });

  it("eligible stub turn visits gate then reflector then ends", async () => {
    const result = await FSMGraph.run(
      createReactGraphConfig(),
      {
        autoSkillSummarize: true,
        fullPermissionsEnabled: true,
        turnModelIterations: 20,
      },
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    assert.ok(result.nodesVisited.includes("skill_reflect_gate"));
    assert.ok(result.nodesVisited.includes("skill_reflector"));
    assert.ok(result.nodesVisited.includes("end"));
    // After the reflect round (no tools), go to end — never back to the
    // main agent loop mid-reflect.
    const reflectIdx = result.nodesVisited.indexOf("skill_reflector");
    const afterReflect = result.nodesVisited.slice(reflectIdx);
    assert.ok(!afterReflect.includes("agent"));
  });

  it("subagent graph has no skill reflector", () => {
    const config = createSubagentGraphConfig();
    const ids = new Set(config.nodes.map((n) => n.id));
    assert.ok(!ids.has("skill_reflector"));
  });

  it("runs subagent sample graph to end", async () => {
    const result = await FSMGraph.run(
      createSubagentGraphConfig({ subagentRole: "explore" }),
      {},
      { registries: createDefaultActionRegistry() },
    );
    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "subagent",
      "end",
    ]);
    assert.equal(result.turnContext.turnStarted, true);
    assert.equal((result.turnContext as Record<string, unknown>).activeRole, undefined);
    assert.equal(result.turnContext.finishedIdle, true);
  });

  it("subagent config disables nested-dispatch tools", () => {
    const config = createSubagentGraphConfig();
    const node = config.nodes.find((n) => n.id === "subagent");
    const disable = node?.actions?.find(
      (a) => a.type === "NodeActionDisableTools",
    );
    const toolNames = (disable?.params?.toolNames ?? []) as string[];
    assert.ok(toolNames.includes("dispatch_subagent"));
    assert.ok(toolNames.includes("ask_user"));
    assert.ok(toolNames.includes("create_plan"));
    const prepare = node?.actions?.find(
      (a) => a.type === "NodeActionPrepareRole",
    );
    assert.equal(prepare?.params?.roleKind, "subagent");
    const tools = node?.actions?.find((a) => a.type === "NodeActionPrepareTools");
    assert.equal(tools?.params?.toolPolicy, "subagent_general");
    assert.equal(tools?.params?.useOfferSet, false);
    const types = (node?.actions ?? []).map((a) => a.type);
    assert.equal(
      types.includes("NodeActionAwaitSubagents"),
      false,
      "subagent cannot nest dispatch — no AwaitSubagents",
    );
  });

  it("rejects invalid PrepareRole params via schema", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionPrepareRole",
              params: { roleKind: "" },
            },
          ],
        },
        { id: "end" },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });

    assert.throws(
      () => FSMGraph.fromConfig(config, createDefaultActionRegistry()),
      (err: unknown) =>
        err instanceof FSMConfigError && err.code === "INVALID_ACTION_PARAMS",
    );
  });

  it("accepts Custom PrepareRole template", () => {
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionPrepareRole",
              params: {
                roleKind: "custom",
                rolePromptInline: "rules",
              },
            },
          ],
        },
        { id: "end" },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    const graph = FSMGraph.fromConfig(config, createDefaultActionRegistry());
    assert.ok(graph);
  });

  it("DisableTools retains candidates for non-destructive request filtering", async () => {
    const { Node } = await import("./Node.js");
    const { NodeActionDisableTools } = await import(
      "./actions/NodeActionDisableTools.js"
    );
    const node = new Node({
      id: "agent",
      actions: [
        new NodeActionDisableTools({
          toolNames: ["run_shell", "write_file"],
          merge: true,
        }),
      ],
    });
    const tools = [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "run_shell" } },
      { type: "function", function: { name: "write_file" } },
    ];
    const result = await node.run({}, { tools });
    assert.equal(result.status, "continue");
    assert.deepEqual(result.nodeContext.disabledTools, [
      "run_shell",
      "write_file",
    ]);
    // Deny list is node-scoped only — no turnContext mirror in V3.
    assert.equal(result.turnContext.disabledTools, undefined);
    // Candidates remain available for merge:false. BuildModelWindow and
    // CallModel filter a copy before using them in a model request.
    assert.deepEqual(result.nodeContext.tools, tools);
  });

  it("DisableTools hardFilter also removes denied tools from tools[]", async () => {
    const { Node } = await import("./Node.js");
    const { NodeActionDisableTools } = await import(
      "./actions/NodeActionDisableTools.js"
    );
    const node = new Node({
      id: "agent",
      actions: [
        new NodeActionDisableTools({
          toolNames: ["run_shell", "write_file"],
          merge: true,
          hardFilter: true,
        }),
      ],
    });
    const tools = [
      { type: "function", function: { name: "read_file" } },
      { type: "function", function: { name: "run_shell" } },
      { type: "function", function: { name: "write_file" } },
    ];
    const result = await node.run({}, { tools });
    assert.equal(result.status, "continue");
    // deny list still recorded (run-time deny stays as a safety net) …
    assert.deepEqual(result.nodeContext.disabledTools, [
      "run_shell",
      "write_file",
    ]);
    // … and denied tools are stripped from tools[] (node-scoped; no
    // turnContext mirror in V3).
    const expected = [{ type: "function", function: { name: "read_file" } }];
    assert.deepEqual(result.nodeContext.tools, expected);
    assert.equal(result.turnContext.tools, undefined);
  });

  it("hydrates DisableTools from config with toolNames params", () => {
    const registry = createDefaultActionRegistry();
    const catalog = registry.listActionCatalog();
    assert.ok(catalog.some((c) => c.type === "NodeActionDisableTools"));
    const config = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [
        {
          id: "start",
          actions: [
            {
              type: "NodeActionDisableTools",
              params: { toolNames: ["run_shell"] },
            },
          ],
        },
        { id: "end" },
      ],
      edges: [{ from: "start", to: "end", type: "EdgeAlways" }],
    });
    const graph = FSMGraph.fromConfig(config, registry);
    assert.equal(graph.getNode("start")?.getActions()[0]?.type, "NodeActionDisableTools");
  });
});
