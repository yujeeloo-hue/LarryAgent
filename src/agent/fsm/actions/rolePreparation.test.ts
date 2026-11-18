import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { join } from "node:path";
import { configurePromptDefaults } from "../../../settings/promptDefaults.js";
import type { RoleIterationSpec } from "../../roles/types.js";
import type { PrepareModelWindowInput, PrepareToolsInput, TurnStreamLlm } from "../../turnHost/types.js";
import { buildSystemPrefix } from "../../turnHost/buildSystemPrefix.js";
import { Node } from "../Node.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";
import { migrateFSMGraphConfig } from "../actionTypeMigration.js";
import { createFSMGraphConfig } from "../types.js";
import { rolePresetParams } from "../configs/rolePresets.js";
import { makeFakeHost, makeScope, makeSession } from "../graphScenariosFixtures.js";
import { NodeActionPrepareRole } from "./NodeActionPrepareRole.js";
import { NodeActionPrepareTools } from "./NodeActionPrepareTools.js";
import { NodeActionBuildModelWindow } from "./NodeActionBuildModelWindow.js";
import { NodeActionSyncPlanStep } from "./NodeActionSyncPlanStep.js";
import { NodeActionCallModel } from "./NodeActionCallModel.js";

before(() => configurePromptDefaults(join(process.cwd(), "resources", "prompts")));

function fixture() {
  const session = makeSession();
  const scope = makeScope(session, "agent");
  scope.llmBundle.planner = { ...scope.llmBundle.agent, providerId: "planner-model" };
  const { host } = makeFakeHost({ session, rounds: [] });
  return { session, scope, host, turnContext: { turnScope: scope } };
}

describe("explicit role preparation", () => {
  it("changing only the role identity preserves prompt, model, tools and status", async () => {
    const { scope, host, turnContext } = fixture();
    const outputs = [];
    for (const roleKind of ["agent", "planner", "executor", "subagent", "my_reviewer"]) {
      const result = await new NodeActionPrepareRole({
        roleKind, rolePromptInline: "Review the change.", personaLabel: "REVIEW",
        promptPlacement: "system", modelBinding: "planner", waitingMessage: "Reviewing…",
      }).Exec({ turnContext, nodeContext: {}, host });
      assert.equal(result.status, "continue");
      const patch = result.nodeContextPatch!;
      const { roleKind: identity, ...spec } = patch.iterationSpec as RoleIterationSpec;
      assert.equal(identity, roleKind);
      assert.equal(scope.turnState.activeRole, roleKind);
      assert.equal(patch.activeLlm, scope.llmBundle.planner);
      assert.equal("currentStepId" in patch, false);
      assert.equal("stepPhase" in patch, false);
      assert.equal("toolPredicate" in spec, false);
      outputs.push({ spec, progressLabel: patch.progressLabel, template: patch.rolePromptTemplate });
    }
    for (const output of outputs) assert.deepEqual(output, outputs[0]);
  });

  it("role names alone select neutral defaults, including custom", async () => {
    const { scope, host, turnContext } = fixture();
    const registry = createDefaultActionRegistry();
    for (const roleKind of ["planner", "custom", "any_identity"]) {
      const result = await registry.createAction("NodeActionPrepareRole", { roleKind }, "test")
        .Exec({ host, turnContext, nodeContext: {} });
      const spec = result.nodeContextPatch!.iterationSpec as RoleIterationSpec;
      assert.equal(spec.roleKind, roleKind);
      assert.equal(spec.personaLabel, "ROLE");
      assert.equal(spec.roleSystemPrompt, "");
      assert.equal(spec.promptPlacement, "system");
      assert.equal(result.nodeContextPatch!.activeLlm, scope.llmBundle.sessionDefault);
    }
  });

  it("provider overrides are explicit and missing providers halt before changing identity", async () => {
    const { scope, host, turnContext } = fixture();
    scope.llmBundle.byProviderId.review = scope.llmBundle.planner;
    const result = await new NodeActionPrepareRole({ roleKind: "custom", modelProviderId: "review" })
      .Exec({ host, turnContext, nodeContext: {} });
    assert.equal(result.nodeContextPatch!.activeLlm, scope.llmBundle.planner);
    assert.equal(scope.turnState.activeRole, "custom");
    const missing = await new NodeActionPrepareRole({ roleKind: "other", modelProviderId: "missing" })
      .Exec({ host, turnContext, nodeContext: {} });
    assert.equal(missing.status, "halt");
    assert.equal(scope.turnState.activeRole, "custom");
  });

  it("prompt placement and the persona label work independently of role identity", async () => {
    const { session, host, turnContext } = fixture();
    const captured: PrepareModelWindowInput[] = [];
    host.prepareModelWindow = async (input) => {
      captured.push(input);
      return { ok: true, messages: [], estimatedTokens: 0, compacted: false };
    };
    for (const promptPlacement of ["persona", "system", "overlay"] as const) {
      const node = new Node({ id: "review_node", actions: [
        new NodeActionPrepareRole({ roleKind: "executor", personaLabel: "REVIEW", rolePromptInline: "Review body", promptPlacement }),
        new NodeActionBuildModelWindow({}),
      ] });
      await node.run(turnContext, { tools: [] }, { host });
      const input = captured.at(-1)!;
      if (promptPlacement === "persona") {
        assert.equal(input.agentTemplateOverride, "Review body");
        assert.equal(input.personaLabel, "REVIEW");
        assert.equal(input.roleSystemPrompt, undefined);
        const prefix = buildSystemPrefix({ session, roleTemplate: input.agentTemplateOverride, personaLabel: input.personaLabel });
        assert.ok(prefix.some((message) => typeof message.content === "string" && message.content.startsWith("[REVIEW]\nReview body")));
      } else if (promptPlacement === "system") {
        assert.equal(input.agentTemplateOverride, undefined);
        assert.match(input.roleSystemPrompt!, /^\[REVIEW\]\nReview body/);
        assert.equal(input.trailingOverlay, "");
      } else {
        assert.equal(input.agentTemplateOverride, undefined);
        assert.equal(input.roleSystemPrompt, undefined);
        assert.match(input.trailingOverlay!, /^\[REVIEW\]\nReview body/);
      }
    }
  });

  it("CallModel falls back to the session binding rather than the role name", async () => {
    const { scope, host, turnContext } = fixture();
    const original = host.streamModelRound;
    const bindings: TurnStreamLlm[] = [];
    host.streamModelRound = async (input) => { bindings.push(input.llm); return original(input); };
    await new NodeActionCallModel({}).Exec({ host, turnContext, nodeContext: { roleKind: "planner", messages: [], tools: [] } });
    assert.equal(bindings[0], scope.llmBundle.sessionDefault);
  });
});

describe("explicit tool and step actions", () => {
  it("tool policy composes with the allowlist and ignores role identity and turn type", () => {
    const { host, turnContext } = fixture();
    const captured: PrepareToolsInput[] = [];
    host.prepareTools = (input = {}) => { captured.push(input); return { tools: [] }; };
    for (const roleKind of ["agent", "custom"]) {
      new NodeActionPrepareTools({ toolPolicy: "subagent_explore", useOfferSet: false, allowTools: ["read_file", "write_file"] })
        .Exec({ host, turnContext, nodeContext: { roleKind } });
      const input = captured.at(-1)!;
      assert.equal(input.useOfferSet, false);
      assert.equal(input.toolPredicate!("read_file"), true);
      assert.equal(input.toolPredicate!("write_file"), false);
      assert.equal(input.toolPredicate!("list_files"), false);
    }
    const child = { ...host, isSubagentTurn: true };
    new NodeActionPrepareTools({ useOfferSet: true }).Exec({ host: child, turnContext, nodeContext: { roleKind: "subagent" } });
    assert.equal(captured.at(-1)!.useOfferSet, true);
    assert.equal(captured.at(-1)!.toolPredicate, undefined);
  });

  it("plan state changes only when SyncPlanStep is mounted, for any identity", async () => {
    const { session, host, turnContext } = fixture();
    session.plan = { id: "p", title: "Plan", status: "active", createdAt: 1, updatedAt: 1, createToolCallId: "tc", steps: [
      { id: "s", title: "Review", status: "in_progress" },
    ] };
    const originalPlan = structuredClone(session.plan);
    const prepared = await new NodeActionPrepareRole(rolePresetParams("executor", { roleKind: "reviewer" }))
      .Exec({ host, turnContext, nodeContext: {} });
    assert.equal(prepared.turnContextPatch, undefined);
    assert.equal(prepared.nodeContextPatch!.currentStepId, undefined);
    const synced = new NodeActionSyncPlanStep({ waitingMessage: "Checking: {step}" })
      .Exec({ host, turnContext, nodeContext: { roleKind: "reviewer" } });
    assert.equal(synced.nodeContextPatch!.currentStepId, "s");
    assert.equal(synced.nodeContextPatch!.stepPhase, "working");
    assert.equal(synced.nodeContextPatch!.progressLabel, "Checking: Review");
    const reset = new NodeActionSyncPlanStep({ mode: "reset" }).Exec({ host, turnContext, nodeContext: {} });
    assert.equal(reset.nodeContextPatch!.currentStepId, null);
    assert.equal(reset.nodeContextPatch!.stepPhase, "idle");
    assert.deepEqual(session.plan, originalPlan);
    assert.equal("stepClaimTx" in synced.turnContextPatch!, false);
  });
});

describe("legacy role graph migration", () => {
  it("preserves configured executor waiting text when separating step sync", async () => {
    const graph = createFSMGraphConfig({
      entryNodeId: "review",
      nodes: [{ id: "review", actions: [{
        type: "NodeActionPrepareRole",
        params: { roleKind: "executor", waitingMessage: "Checking changes…" },
      }] }],
      edges: [],
    });
    const actions = migrateFSMGraphConfig({ ...graph, version: 1 }).nodes[0]!.actions!;
    const stepSync = actions.find((action) => action.type === "NodeActionSyncPlanStep")!;
    assert.deepEqual(stepSync.params, { mode: "current" });
    const { host, turnContext } = fixture();
    const prepared = await new NodeActionPrepareRole(actions[0]!.params)
      .Exec({ host, turnContext, nodeContext: {} });
    assert.equal(prepared.nodeContextPatch!.progressLabel, "Checking changes…");
    const synced = new NodeActionSyncPlanStep(stepSync.params)
      .Exec({ host, turnContext, nodeContext: prepared.nodeContextPatch! });
    assert.equal(synced.nodeContextPatch!.progressLabel, undefined);
  });

  it("leaves explicit planner identities free of inferred phase, overlay and step actions", () => {
    for (const id of ["planner", "review"]) {
      const graph = createFSMGraphConfig({
        entryNodeId: id,
        nodes: [{ id, actions: [{
          type: "NodeActionPrepareRole",
          params: {
            roleKind: "planner", personaLabel: "REVIEW", promptPlacement: "system",
            modelBinding: "sessionDefault", rolePromptInline: "Review the change.",
          },
        }] }],
        edges: [],
      });
      assert.deepEqual(migrateFSMGraphConfig({ ...graph, version: 1 }).nodes[0]!.actions, graph.nodes[0]!.actions);
    }
  });

  it("expands nested legacy rounds, preserving explicit step wiring and tool settings", () => {
    const graph = createFSMGraphConfig({
      entryNodeId: "start",
      nodes: [{ id: "start", actions: [{
        type: "NodeActionRoleRoundBuilder",
        params: { steps: [
          null, "ignored", {},
          { type: "NodeActionPrepareRole", params: { roleKind: "subagent", subagentRole: "worker" } },
          { type: "NodeActionSyncPlanStep", params: { mode: "current" } },
          { type: "NodeActionPrepareTools", params: { allowTools: ["read_file"] } },
          { type: "NodeActionPrepareTools", params: {} },
        ] },
      }] }],
      edges: [],
    });
    const migrated = migrateFSMGraphConfig({ ...graph, version: 1 });
    const children = migrated.nodes[0]!.actions![0]!.params!.steps as Array<{
      type: string; params: Record<string, unknown>;
    }>;
    assert.deepEqual(children.map((child) => child.type), [
      "NodeActionPrepareRole", "NodeActionSyncPlanStep", "NodeActionPrepareTools", "NodeActionPrepareTools",
    ]);
    assert.equal(children[0]!.params.modelBinding, "subagent");
    assert.deepEqual(children[1]!.params, { mode: "current" });
    assert.equal(children[2]!.params.toolPolicy, "subagent_worker");
    assert.deepEqual(children[2]!.params.allowTools, ["read_file"]);
    assert.equal(children[3]!.params.toolPolicy, "subagent_worker");
    assert.deepEqual(migrateFSMGraphConfig(migrated), migrated);
  });

  it("expands role defaults and tool policy once, and preserves explicit settings", () => {
    const graph = createFSMGraphConfig({ entryNodeId: "start", nodes: [
      { id: "start", actions: [
        { type: "NodeActionPrepareRole", params: { roleKind: "subagent", subagentRole: "explore" } },
        { type: "NodeActionPrepareTools", params: { allowTools: ["read_file"] } },
        { type: "NodeActionPrepareRole", params: { roleKind: "executor" } },
        { type: "NodeActionPrepareRole", params: { roleKind: "planner", promptPlacement: "persona", modelBinding: "executor", personaLabel: "CUSTOM", rolePromptInline: "Body" } },
      ] }, { id: "end" },
    ], edges: [{ from: "start", to: "end", type: "EdgeAlways" }] });
    const migrated = migrateFSMGraphConfig({ ...graph, version: 1 });
    assert.deepEqual(migrateFSMGraphConfig(migrated), migrated);
    const actions = migrated.nodes[0]!.actions!;
    const tool = actions.find((action) => action.type === "NodeActionPrepareTools")!;
    assert.equal(tool.params!.toolPolicy, "subagent_explore");
    assert.equal(tool.params!.useOfferSet, false);
    assert.deepEqual(tool.params!.allowTools, ["read_file"]);
    assert.equal(actions.filter((action) => action.type === "NodeActionSyncPlanStep").length, 2);
    const executor = actions.find((action) => action.params?.roleKind === "executor")!;
    assert.equal(executor.params!.modelBinding, "executor");
    const explicit = actions.find((action) => action.params?.roleKind === "planner")!;
    assert.equal(explicit.params!.personaLabel, "CUSTOM");
    assert.equal(explicit.params!.promptPlacement, "persona");
    assert.equal(explicit.params!.modelBinding, "executor");
    assert.equal(explicit.params!.promptPreset, undefined);
    assert.deepEqual(graph.nodes[0]!.actions![0]!.params, { roleKind: "subagent", subagentRole: "explore" });
  });
});
