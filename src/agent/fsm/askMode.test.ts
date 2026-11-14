import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ASK_MODE_BUILTIN_ALLOWLIST,
  ASK_MODE_DENYLIST,
  ASK_MODE_DENYLIST_SET,
  isAskModeMcpToolAllowed,
  isAskModeToolAllowed,
} from "../policy/askMode.js";
import { createAskGraphConfig } from "./configs/sampleGraphs.js";
import { resolveWorkflowMode } from "../workflow/resolveWorkflowMode.js";
import type { RunAgentTurnInput } from "../types.js";

function bareInput(runMode?: RunAgentTurnInput["runMode"]): RunAgentTurnInput {
  return {
    session: {} as RunAgentTurnInput["session"],
    userText: "x",
    client: { baseUrl: "http://127.0.0.1:9", apiKey: "k", model: "m" },
    gate: { fullPermissionsEnabled: true } as RunAgentTurnInput["gate"],
    createId: () => "id",
    ...(runMode ? { runMode } : {}),
  };
}

describe("createAskGraphConfig", () => {
  const config = createAskGraphConfig();
  const nodeIds = config.nodes.map((n) => n.id);
  const agentNode = config.nodes.find((n) => n.id === "agent");

  it("has no skill_reflect nodes (Ask never writes skills)", () => {
    assert.ok(!nodeIds.some((id) => id.startsWith("skill_reflect")));
  });

  it("StartTurn does not resume by phase", () => {
    const start = config.nodes.find((n) => n.id === "start");
    const startTurn = start?.actions?.find(
      (a) => a.type === "NodeActionStartTurn",
    );
    assert.ok(startTurn);
    assert.equal(
      (startTurn!.params as { phaseResume?: unknown }).phaseResume,
      undefined,
    );
  });

  it("tools path emits route events but does not mount plan entry Actions", () => {
    const types = (agentNode!.actions ?? []).map((a) => a.type);
    assert.ok(types.includes("NodeActionEmitRouteEvent"));
    assert.equal(types.includes("NodeActionCompleteActivePlan"), false);
    assert.equal(types.includes("NodeActionClearPlanDraft"), false);
  });

  it("V3 skeleton: start →(EdgeAlways) agent self-round → reflect|end", () => {
    assert.deepEqual(nodeIds, ["start", "agent", "end"]);
    const entry = config.edges.find(
      (e) => e.from === "start" && e.type === "EdgeAlways",
    );
    assert.ok(entry, "start must EdgeAlways-connect to the agent node");
    assert.equal(entry?.to, "agent");
    const agentConfig = config.nodes.find((n) => n.id === "agent");
    assert.equal(
      agentConfig?.selfLoop,
      true,
      "agent must self-loop via the node selfLoop flag",
    );
    assert.ok(
      !config.edges.some((e) => e.from === e.to),
      "selfLoop flag replaces explicit from===to edges",
    );
  });

  it("agent node disables the full ASK_MODE_DENYLIST", () => {
    const disable = agentNode!.actions!.find(
      (a) => a.type === "NodeActionDisableTools",
    );
    assert.ok(disable, "agent node must carry NodeActionDisableTools");
    const names = (
      disable.params as { toolNames?: string[]; merge?: boolean }
    ).toolNames;
    assert.ok(names, "disableToolNames must be set");
    for (const denied of ASK_MODE_DENYLIST) {
      assert.ok(names.includes(denied), `denylist missing ${denied}`);
    }
  });

  it("hard-filters the denylist from tools[] (hidden from the model)", () => {
    const disable = agentNode!.actions!.find(
      (a) => a.type === "NodeActionDisableTools",
    );
    const hardFilter = (
      disable!.params as { hardFilter?: boolean }
    ).hardFilter;
    assert.equal(
      hardFilter,
      true,
      "Ask mode must remove denied tools from tools[], not only run-time deny",
    );
  });

  it("PrepareTools carries allowTools whitelist; RunTools does not expose it", () => {
    const prepare = agentNode!.actions!.find(
      (a) => a.type === "NodeActionPrepareTools",
    );
    assert.ok(prepare, "agent node must carry NodeActionPrepareTools");
    const prepareAllow = (prepare.params as { allowTools?: string[] }).allowTools;
    assert.ok(prepareAllow && prepareAllow.length > 0, "allowTools must be set");
    assert.ok(prepareAllow.includes("read_file"));
    assert.equal(
      (prepare.params as { askMode?: boolean }).askMode,
      undefined,
    );

    const run = agentNode!.actions!.find((a) => a.type === "NodeActionRunTools");
    assert.ok(run, "agent node must carry NodeActionRunTools");
    assert.equal(
      (run.params as { allowTools?: unknown }).allowTools,
      undefined,
    );
    assert.equal((run.params as { askMode?: boolean }).askMode, undefined);
  });

  it("PrepareRole does not set askMode", () => {
    const prepareRole = agentNode!.actions!.find(
      (a) => a.type === "NodeActionPrepareRole",
    );
    assert.equal(
      (prepareRole!.params as { askMode?: boolean }).askMode,
      undefined,
    );
  });

  it("Call model disables reasoning for Ask", () => {
    const stream = agentNode!.actions!.find(
      (a) => a.type === "NodeActionCallModel",
    );
    assert.ok(stream, "agent node must carry NodeActionCallModel");
    assert.equal(
      (stream.params as { disableReasoning?: boolean }).disableReasoning,
      true,
    );
  });

  it("explicitly removes forced metas request_full_permissions / write_plan_doc", () => {
    const disable = agentNode!.actions!.find(
      (a) => a.type === "NodeActionDisableTools",
    );
    const names = (
      disable!.params as { toolNames?: string[]; merge?: boolean }
    ).toolNames!;
    assert.ok(names.includes("request_full_permissions"));
    assert.ok(names.includes("write_plan_doc"));
  });

  it("read-only Q&A contract is the Custom role body, not a per-round overlay", () => {
    const prepareRole = agentNode!.actions!.find(
      (a) => a.type === "NodeActionPrepareRole",
    );
    const prepareParams = prepareRole!.params as {
      roleKind?: string;
      rolePromptInline?: string;
    };
    assert.equal(prepareParams.roleKind, "agent");
    assert.equal(prepareRole!.params!.promptPlacement, "persona");
    assert.ok(
      prepareParams.rolePromptInline,
      "rolePromptInline must carry the Ask role body",
    );
    assert.match(prepareParams.rolePromptInline!, /read-only/i);
    assert.match(prepareParams.rolePromptInline!, /NEVER write, edit, delete/);

    // Role descriptions must not ride the trailing overlay (self-loop
    // repetition): PromptInject — if present at all — carries no note text.
    const promptInject = agentNode!.actions!.find(
      (a) => a.type === "NodeActionPromptInject",
    );
    assert.equal(
      promptInject,
      undefined,
      "Ask agent needs no PromptInject (no route guide / live fields)",
    );
  });

  it("does not mount SetPhase / plan entry Actions / AwaitSubagents", () => {
    const types = agentNode!.actions!.map((a) => a.type);
    assert.equal(types.includes("NodeActionSetPhase"), false);
    assert.equal(types.includes("NodeActionCompleteActivePlan"), false);
    assert.equal(types.includes("NodeActionAwaitSubagents"), false);
  });
});

describe("ASK_MODE_DENYLIST / ALLOWLIST coherence", () => {
  it("denylist and builtin allowlist are disjoint", () => {
    for (const name of ASK_MODE_BUILTIN_ALLOWLIST) {
      assert.ok(
        !ASK_MODE_DENYLIST_SET.has(name),
        `allowlist item ${name} leaked into denylist`,
      );
    }
  });

  it("denylist has no duplicates", () => {
    assert.equal(
      new Set(ASK_MODE_DENYLIST).size,
      ASK_MODE_DENYLIST.length,
    );
  });
});

describe("isAskModeToolAllowed (default-deny)", () => {
  it("allows builtin read-only tools", () => {
    for (const name of [
      "read_file",
      "list_dir",
      "grep",
      "batch_search",
      "read_skill",
      "search_skills",
      "read_user_memory",
      "read_project_memory",
      "read_image",
      "get_workspace_path",
      "get_current_time",
      "search_session_history",
      "search_tools",
      "ask_user",
    ]) {
      assert.equal(isAskModeToolAllowed(name), true, name);
    }
  });

  it("rejects every mutating / executing builtin tool", () => {
    for (const name of [
      "write_file",
      "edit_file",
      "append_file",
      "patch",
      "run_shell",
      "create_plan",
      "update_plan",
      "complete_plan",
      "write_plan_doc",
      "create_skill",
      "update_user_memory",
      "update_project_memory",
      "dispatch_subagent",
      "create_mcp_server",
      "request_full_permissions",
    ]) {
      assert.equal(isAskModeToolAllowed(name), false, name);
    }
  });

  it("allows JNote read-only tools by naming pattern", () => {
    assert.equal(isAskModeMcpToolAllowed("mcp__jnote__list_notes"), true);
    assert.equal(isAskModeMcpToolAllowed("mcp__jnote__search_notes"), true);
    assert.equal(isAskModeMcpToolAllowed("mcp__jnote__get_note"), true);
    assert.equal(isAskModeToolAllowed("mcp__jnote__list_notes"), true);
  });

  it("allows every Tavily MCP tool (read-only web lookup)", () => {
    assert.equal(isAskModeMcpToolAllowed("mcp__tavily__tavily_search"), true);
    assert.equal(isAskModeMcpToolAllowed("mcp__tavily__tavily_extract"), true);
    assert.equal(isAskModeMcpToolAllowed("mcp__tavily__tavily_research"), true);
    assert.equal(isAskModeToolAllowed("mcp__tavily__tavily_search"), true);
  });

  it("rejects JNote write tools and other MCP servers", () => {
    assert.equal(isAskModeMcpToolAllowed("mcp__jnote__create_note"), false);
    assert.equal(isAskModeMcpToolAllowed("mcp__jnote__update_note"), false);
    assert.equal(isAskModeMcpToolAllowed("mcp__futuapi__query_quote"), false);
    assert.equal(isAskModeToolAllowed("mcp__futuapi__query_quote"), false);
  });

  it("rejects non-MCP unknown names", () => {
    assert.equal(isAskModeToolAllowed("anything_else"), false);
  });
});

describe("resolveWorkflowMode ask mapping", () => {
  it("runMode ask resolves to ask", () => {
    assert.equal(resolveWorkflowMode(bareInput("ask")), "ask");
  });

  it("composer modes map once; subagent wins over ask", () => {
    assert.equal(resolveWorkflowMode(bareInput("agent")), "react");
    assert.equal(resolveWorkflowMode(bareInput(undefined)), "react");
    assert.equal(resolveWorkflowMode(bareInput("plan")), "plan_execute");
    assert.equal(
      resolveWorkflowMode({ ...bareInput("ask"), isSubagentTurn: true }),
      "subagent",
    );
  });
});
