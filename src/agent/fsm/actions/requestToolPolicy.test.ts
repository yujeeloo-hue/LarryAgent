import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OpenAiToolDefinition } from "../../../llm/types.js";
import { ToolReturnCode } from "../../../session/returnCodes.js";
import type { ToolCallPart, ToolResultPart } from "../../../session/types.js";
import { upsertTool } from "../../../tools/registry.js";
import { runTools } from "../../runTools.js";
import type { FsmHostCapabilities } from "../FsmHostCapabilities.js";
import { Node } from "../Node.js";
import { makeFakeHost, makeScope, makeSession, type ScriptedRound } from "../graphScenariosFixtures.js";
import type { NodeActionConfig, NodeContext } from "../types.js";
import { createDefaultActionRegistry } from "./createDefaultActionRegistry.js";

function step(type: string, params: Record<string, unknown> = {}): NodeActionConfig {
  return { type, params };
}

const requestRound = () => [step("NodeActionBuildModelWindow"), step("NodeActionCallModel")];

function toolLabels(tools: OpenAiToolDefinition[]): string[] {
  return tools.map((tool) => {
    const candidate = tool as unknown as { type: string; name?: string; function?: { name: string } };
    return candidate.function?.name ?? candidate.name ?? candidate.type;
  });
}

function harness(rounds: ScriptedRound[] = []) {
  const candidates: OpenAiToolDefinition[] = ["read_file", "write_file", "run_shell"].map((name) => ({
    type: "function", function: { name, parameters: { type: "object" } },
  }));
  const originalCandidates = structuredClone(candidates);
  const session = makeSession();
  const scope = makeScope(session, "agent");
  const { host } = makeFakeHost({ session, rounds });
  const windowTools: string[][] = [];
  const modelTools: string[][] = [];
  const toolRuns: Parameters<FsmHostCapabilities["runToolsPhase"]>[] = [];
  let prepareCount = 0;

  // Deliberately ignore the predicate: request boundaries must enforce policy
  // even if a provider or a later Prepare tools refresh returns all candidates.
  host.prepareTools = () => { prepareCount += 1; return { tools: candidates }; };
  const prepareModelWindow = host.prepareModelWindow;
  host.prepareModelWindow = async (input) => {
    windowTools.push(toolLabels(input.tools));
    return prepareModelWindow(input);
  };
  const streamModelRound = host.streamModelRound;
  host.streamModelRound = async (input) => {
    modelTools.push(toolLabels(input.tools));
    return streamModelRound(input);
  };
  const runToolsPhase = host.runToolsPhase;
  host.runToolsPhase = async (...input) => { toolRuns.push(input); return runToolsPhase(...input); };

  return {
    host, session, windowTools, modelTools, toolRuns,
    get prepareCount() { return prepareCount; },
    async run(actions: NodeActionConfig[], initialContext: NodeContext = {}) {
      const registry = createDefaultActionRegistry();
      const node = new Node({
        id: "policy",
        actions: actions.map((action, index) => registry.createAction(
          action.type, action.params, `policy.actions[${index}]`,
        )),
      });
      const result = await node.run({ turnScope: scope }, {
        iterationSpec: {
          roleKind: "agent", personaLabel: "AGENT", promptPlacement: "system",
          roleSystemPrompt: "", includeSkills: false,
        },
        ...initialContext,
      }, { host });
      assert.equal(result.status, "continue", result.errorMessage ?? "policy node should continue");
      assert.deepEqual(candidates, originalCandidates, "request filtering must not mutate the source candidates");
      return result;
    },
    assertRequests(expected: string[][]) {
      assert.deepEqual(windowTools, expected, "Build model window must receive only permitted tools");
      assert.deepEqual(modelTools, expected, "Call model must receive only permitted tools");
    },
  };
}

describe("FSM tool policy at model request boundaries", () => {
  for (const mode of ["default", "explicit false"] as const) {
    it(`filters Disable tools from both request boundaries with hardFilter ${mode}`, async () => {
      const fixture = harness();
      await fixture.run([
        step("NodeActionPrepareTools"),
        step("NodeActionDisableTools", {
          toolNames: ["write_file"], ...(mode === "explicit false" ? { hardFilter: false } : {}),
        }),
        ...requestRound(),
      ]);
      fixture.assertRequests([["read_file", "run_shell"]]);
    });
  }

  it("applies deny globs ahead of matching allow globs even when the host ignores its predicate", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools", { allowTools: ["read_*", "write_*"] }),
      step("NodeActionDisableTools", { toolNames: ["write_*"] }),
      ...requestRound(),
    ]);
    fixture.assertRequests([["read_file"]]);
  });

  it("uses the latest deny list when Disable tools runs after Build model window", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionBuildModelWindow"),
      step("NodeActionDisableTools", { toolNames: ["write_file"], hardFilter: false }),
      step("NodeActionCallModel"),
    ]);
    assert.deepEqual(fixture.windowTools, [["read_file", "write_file", "run_shell"]]);
    assert.deepEqual(fixture.modelTools, [["read_file", "run_shell"]]);
  });

  it("filters native tools by type at the real Build model window and Call model boundaries", async () => {
    const fixture = harness();
    // Cast only to model future native definitions before the shared LLM tool
    // union grows; these tools intentionally have neither function nor name.
    const nativeCandidates = [
      { type: "web_search" },
      { type: "file_search", vector_store_ids: ["vs-test"] },
      { type: "function", function: { name: "read_file", parameters: { type: "object" } } },
    ] as unknown as OpenAiToolDefinition[];
    const original = structuredClone(nativeCandidates);
    await fixture.run([
      step("NodeActionDisableTools", { toolNames: ["web_search"], hardFilter: false }),
      ...requestRound(),
    ], { tools: nativeCandidates, allowTools: ["*"] });
    fixture.assertRequests([["file_search", "read_file"]]);
    assert.deepEqual(nativeCandidates, original);
  });

  it("does not restore disabled tools when Prepare tools refreshes after Disable tools", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionDisableTools", { toolNames: ["write_file"] }),
      step("NodeActionPrepareTools"),
      ...requestRound(),
    ]);
    assert.equal(fixture.prepareCount, 2);
    fixture.assertRequests([["read_file", "run_shell"]]);
  });

  it("allows a model round with an empty tool list when every candidate is denied", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionDisableTools", { toolNames: ["*"] }),
      ...requestRound(),
    ]);
    fixture.assertRequests([[]]);
  });

  it("filters the default Role round builder's disableToolNames before both requests", async () => {
    const fixture = harness();
    await fixture.run([step("NodeActionRoleRoundBuilder", {
      prepareRole: { promptPreset: "none", rolePromptInline: "Review tool policy." },
      disableToolNames: ["write_file"],
      awaitSubagents: false,
      routeTo: { routes: [{ event: "leave", to: "done" }] },
    })]);
    fixture.assertRequests([["read_file", "run_shell"]]);
  });

  it("restores retained candidates on the next request when merge false clears the deny list", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionDisableTools", { toolNames: ["write_file"], hardFilter: false }),
      ...requestRound(),
      step("NodeActionDisableTools", { toolNames: [], merge: false }),
      ...requestRound(),
    ]);
    assert.equal(fixture.prepareCount, 1, "clearing a deny list must not require refreshing candidates");
    fixture.assertRequests([["read_file", "run_shell"], ["read_file", "write_file", "run_shell"]]);
  });

  it("restores A and denies only B when merge false replaces the deny list", async () => {
    const fixture = harness();
    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionDisableTools", { toolNames: ["write_file"], hardFilter: false }),
      ...requestRound(),
      step("NodeActionDisableTools", { toolNames: ["run_shell"], merge: false, hardFilter: false }),
      ...requestRound(),
    ]);
    assert.equal(fixture.prepareCount, 1);
    fixture.assertRequests([["read_file", "run_shell"], ["read_file", "write_file"]]);
  });

  it("keeps Run tools' execution-time deny when the model still returns a forbidden call", async () => {
    let executions = 0;
    upsertTool({ name: "write_file", description: "test write", parameters: { type: "object" }, defaultPermissionLevel: 0 }, async () => {
      executions += 1;
      return { returnCode: ToolReturnCode.Success, content: [] };
    });
    const call: ToolCallPart = {
      type: "tool_call", id: "denied-call", name: "write_file", status: "pending",
      arguments: {}, argumentsRaw: "{}",
    };
    const fixture = harness([{ toolCalls: [call] }]);
    let deniedNames: string[] | undefined;
    fixture.host.runToolsPhase = async (assistant, toolCalls, options) => {
      deniedNames = options?.disabledTools;
      fixture.session.messages.push(assistant);
      let resultId = 0;
      const result = await runTools({
        session: fixture.session, assistantMessageId: assistant.id, toolCalls,
        gate: fixture.host.gate, createId: () => `denied-result-${++resultId}`,
        ...(options?.disabledTools ? { phaseDisabledTools: options.disabledTools } : {}),
      });
      assert.equal(result.cancelled, false);
      return { ...result, kind: "ok", cancelled: false };
    };

    await fixture.run([
      step("NodeActionPrepareTools"),
      step("NodeActionDisableTools", { toolNames: ["write_file"] }),
      ...requestRound(),
      step("NodeActionRunTools"),
    ]);

    assert.deepEqual(deniedNames, ["write_file"]);
    assert.equal(executions, 0);
    assert.equal(call.status, "error");
    const result = fixture.session.messages.flatMap((message) => message.parts).find(
      (part): part is ToolResultPart => part.type === "tool_result" && part.toolCallId === call.id,
    );
    assert.equal(result?.returnCode, ToolReturnCode.PermissionDenied);
    fixture.assertRequests([["read_file", "run_shell"]]);
  });
});
