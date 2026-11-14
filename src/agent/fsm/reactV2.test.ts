/**
 * Auto V2 (react_v2) behavior runs — demo-first workflow routing.
 *
 * Locked decisions (docs/plans/20261027-auto-v2-demo-first-graph.md):
 * - Start deterministic routing: D7 demo-confirm marker → agent (execution),
 *   session phase "demo_review" → demo_builder, default → triage.
 * - Triage round routes ui → demo_builder, direct (or no route) → agent.
 * - Builder self-loop writes the demo review phase; confirmed/direct → agent,
 *   which clears the phase (handoff complete).
 * - Auto V1 topology is untouched (no triage/demo_builder nodes).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createReactGraphConfig,
  createReactV2GraphConfig,
} from "./configs/sampleGraphs.js";
import { createDefaultActionRegistry } from "./actions/createDefaultActionRegistry.js";
import { FSMGraph } from "./FSMGraph.js";
import {
  makeFakeHost,
  makeScope,
  makeSession,
  makeToolCall,
  makeTurnInput,
  type ScriptedRound,
} from "./graphScenariosFixtures.js";
import { buildDemoConfirmMessage } from "../../session/demoConfirm.js";
import type { OpenAiToolDefinition } from "../../llm/types.js";
import type { AssistantMessage } from "../../session/types.js";
import { SHELL_TOOL_NAME } from "../../tools/shellToolName.js";

const registries = createDefaultActionRegistry();

async function runV2(options: {
  session: ReturnType<typeof makeSession>;
  rounds: ScriptedRound[];
  userText?: string;
}) {
  const { host, events } = makeFakeHost({
    session: options.session,
    rounds: options.rounds,
  });
  const turnInput = makeTurnInput(
    options.session,
    options.userText === undefined ? {} : { userText: options.userText },
  );
  const result = await FSMGraph.run(
    createReactV2GraphConfig(),
    { turnScope: makeScope(options.session, "agent") },
    { registries, host, turnInput },
  );
  return { result, events };
}

describe("react_v2 demo-first routing", () => {
  it("default entry → triage; ui route → demo_builder writes demo_review phase", async () => {
    const session = makeSession({ id: "v2-ui" });
    const { result } = await runV2({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", { route: "ui", reason: "UI change" }),
          ],
        },
        { text: "Demo presented. Waiting for feedback." },
      ],
    });

    assert.equal(result.reason, "end_node");
    assert.deepEqual(result.nodesVisited, [
      "start",
      "triage",
      "demo_builder",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "end",
    ]);
    // Demo in flight: phase persists for the next turn's resume routing.
    assert.equal(session.fsmBlackboard?.["phase"], "demo_review");
    assert.equal(session.phase, "demo_review");
  });

  it("triage direct route → agent, phase stays clear", async () => {
    const session = makeSession({ id: "v2-direct" });
    const { result } = await runV2({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", { route: "direct", reason: "backend" }),
          ],
        },
        { text: "Done." },
      ],
    });

    assert.deepEqual(result.nodesVisited, [
      "start",
      "triage",
      "agent",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "end",
    ]);
    assert.equal(session.phase, null);
  });

  it("triage plain answer (no fsm_route) degrades to agent — V1 behavior", async () => {
    const session = makeSession({ id: "v2-notool" });
    const { result } = await runV2({
      session,
      rounds: [{ text: "Docs question." }, { text: "Answered." }],
    });

    assert.deepEqual(result.nodesVisited, [
      "start",
      "triage",
      "agent",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "end",
    ]);
  });

  it("phase=demo_review resumes straight into demo_builder (no triage round)", async () => {
    const session = makeSession({ id: "v2-resume", phase: "demo_review" });
    const { result } = await runV2({
      session,
      rounds: [{ text: "Revised demo presented." }],
    });

    assert.deepEqual(result.nodesVisited, [
      "start",
      "demo_builder",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "end",
    ]);
    assert.equal(session.phase, "demo_review");
  });

  it("D7 demo-confirm marker routes straight to agent and clears the phase", async () => {
    const session = makeSession({ id: "v2-confirm", phase: "demo_review" });
    const userText = buildDemoConfirmMessage({
      toolCallId: "demo-1",
      paramsJson: '{"accent":"#f1f2f4","density":"compact"}',
    });
    const { result } = await runV2({
      session,
      rounds: [
        { text: "Implementing the confirmed demo now." },
        { text: "Cleaned up the demo directory." },
      ],
      userText,
    });

    // No triage / builder model round spent on the confirm turn; the turn
    // ends through the cleanup node (turn-level demoConfirm flag on).
    assert.deepEqual(result.nodesVisited, [
      "start",
      "agent",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "demo_cleanup",
      "end",
    ]);
    assert.equal(session.phase, null);
    assert.equal(session.fsmBlackboard?.["phase"], undefined);
  });

  it("builder confirmed route → agent clears the phase (soft channel)", async () => {
    const session = makeSession({ id: "v2-soft", phase: "demo_review" });
    const { result } = await runV2({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", {
              route: "confirmed",
              reason: "user approved in text",
            }),
          ],
        },
        { text: "Handed off to execution." },
      ],
    });

    assert.deepEqual(result.nodesVisited, [
      "start",
      "demo_builder",
      "agent",
      "skill_reflect_gate",
      // Soft confirm: no D7 marker → turn-level flag off → no cleanup round.
      "demo_cleanup_gate",
      "end",
    ]);
    assert.equal(session.phase, null);
  });

  it("builder direct route (escape hatch) → agent clears the phase", async () => {
    const session = makeSession({ id: "v2-escape", phase: "demo_review" });
    const { result } = await runV2({
      session,
      rounds: [
        {
          toolCalls: [
            makeToolCall("t1", "fsm_route", {
              route: "direct",
              reason: "user asked to skip the demo",
            }),
          ],
        },
        { text: "Skipping demo, implementing." },
      ],
    });

    assert.deepEqual(result.nodesVisited, [
      "start",
      "demo_builder",
      "agent",
      "skill_reflect_gate",
      "demo_cleanup_gate",
      "end",
    ]);
    assert.equal(session.phase, null);
  });

  it("plan-mode phases never trigger V2 resume routing", async () => {
    const session = makeSession({ id: "v2-planphase", phase: "executing" });
    const { result } = await runV2({
      session,
      rounds: [
        { text: "Looks like continuation work." },
        { text: "Done." },
      ],
    });

    // executing ≠ demo_review → default triage lane, not demo_builder.
    assert.deepEqual(result.nodesVisited[0], "start");
    assert.ok(result.nodesVisited.includes("triage"));
    assert.ok(!result.nodesVisited.includes("demo_builder"));
  });

  it("Auto V1 topology is untouched — no triage / demo_builder nodes", () => {
    const v1 = createReactGraphConfig();
    assert.deepEqual(
      v1.nodes.map((n) => n.id),
      ["start", "agent", "skill_reflect_gate", "skill_reflector", "end"],
    );
    const v2 = createReactV2GraphConfig();
    assert.ok(v2.nodes.some((n) => n.id === "triage"));
    assert.ok(v2.nodes.some((n) => n.id === "demo_builder"));
  });

  it("demo builder tools are unrestricted; cleanup is a dedicated end node", () => {
    const v2 = createReactV2GraphConfig();
    const builder = v2.nodes.find((n) => n.id === "demo_builder")!;
    const builderTools = (builder.actions ?? []).find(
      (a) => a.type === "NodeActionPrepareTools",
    );
    // No allowTools gate — the demo-first contract is prompt-side.
    assert.equal(
      (builderTools?.params as Record<string, unknown> | undefined)?.allowTools,
      undefined,
    );

    // Cleanup gate branches on the Start-written turn-level confirm flag;
    // the cleanup node carries the removal prompt (agent stays stock).
    const gate = v2.nodes.find((n) => n.id === "demo_cleanup_gate")!;
    const gateCompare = (gate.actions ?? []).find(
      (a) => a.type === "NodeActionCompare",
    );
    assert.equal(
      (gateCompare?.params as Record<string, unknown> | undefined)?.key,
      "turn.demoConfirm",
    );
    const cleanup = v2.nodes.find((n) => n.id === "demo_cleanup")!;
    const prepareRole = (cleanup.actions ?? []).find(
      (a) => a.type === "NodeActionPrepareRole",
    );
    assert.match(
      String(
        (prepareRole?.params as Record<string, unknown> | undefined)
          ?.rolePromptInline ?? "",
      ),
      /delete that directory with run_shell/i,
    );
    // The agent's only note is the EDG shell-chain hint — no demo cleanup text.
    const agent = v2.nodes.find((n) => n.id === "agent")!;
    const agentNotes = (agent.actions ?? [])
      .filter(
        (a) =>
          a.type === "NodeActionPromptInject" &&
          (a.params as Record<string, unknown>).source === "note",
      )
      .map((a) => String((a.params as Record<string, unknown>).note ?? ""));
    assert.equal(agentNotes.length, 1);
    assert.match(agentNotes[0]!, /`then` argument/);
    assert.doesNotMatch(agentNotes[0]!, /demo/i);
  });
});

describe("react_v2 EDG shell-chain reuse", () => {
  const shellTool: OpenAiToolDefinition = {
    type: "function",
    function: {
      name: SHELL_TOOL_NAME,
      description: "shell",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
    },
  };

  /** V2 run through triage(direct) → agent with a shell-aware fake host. */
  async function runEdg(options: {
    rounds: ScriptedRound[];
    exitCodes?: Record<string, number>;
    steerAfterCommand?: string;
    graphConfig?: ReturnType<typeof createReactV2GraphConfig>;
  }) {
    const session = makeSession({ id: "v2-edg" });
    const { host, events } = makeFakeHost({
      session,
      rounds: [
        { toolCalls: [makeToolCall("t1", "fsm_route", { route: "direct", reason: "x" })] },
        ...options.rounds,
      ],
    });
    const executed: string[] = [];
    const offeredTools: OpenAiToolDefinition[][] = [];
    let steerPending = false;
    const baseRunTools = host.runToolsPhase.bind(host);
    host.prepareTools = () => ({ tools: [shellTool] });
    host.hasPendingSteer = () => steerPending;
    host.drainPendingSteer = async () => {
      const had = steerPending;
      steerPending = false;
      if (had) events.push("steer:drained");
      return had;
    };
    const baseStream = host.streamModelRound.bind(host);
    host.streamModelRound = async (input) => {
      offeredTools.push(input.tools);
      return baseStream(input);
    };
    host.appendSyntheticToolRound = ({ toolCalls }) => {
      const assistant: AssistantMessage = {
        id: host.createId(),
        role: "assistant",
        createdAt: Date.now(),
        parts: [{ type: "reasoning", text: "" }, ...toolCalls],
      };
      session.messages.push(assistant);
      events.push(`synthetic:${toolCalls.map((c) => c.arguments.command).join(",")}`);
      return assistant;
    };
    host.runToolsPhase = async (assistant, toolCalls, opts) => {
      if (!toolCalls.every((c) => c.name === SHELL_TOOL_NAME)) {
        return baseRunTools(assistant, toolCalls, opts);
      }
      assert.equal(opts?.extra?.shellStructuredReceipt, true);
      const receipts = toolCalls.map((call) => {
        const command = String(call.arguments.command);
        executed.push(command);
        if (command === options.steerAfterCommand) steerPending = true;
        const exitCode = options.exitCodes?.[command] ?? 0;
        return {
          toolCallId: call.id,
          name: call.name,
          returnCode: exitCode === 0 ? 0 : 1,
          receipt: { exitCode, timedOut: false, signal: null, stdout: "", stderr: "" },
        };
      });
      return { kind: "ok", cancelled: false, toolFailureCount: 0, routeEvents: [], receipts };
    };
    const result = await FSMGraph.run(
      options.graphConfig ?? createReactV2GraphConfig(),
      { turnScope: makeScope(session, "agent") },
      { registries, host, turnInput: makeTurnInput(session) },
    );
    return { result, events, executed, offeredTools, host };
  }

  const rootWithThen = (then: string[]) =>
    makeToolCall("root", SHELL_TOOL_NAME, { command: "npm run build", then });

  it("replays the whole `then` chain without model rounds, then hands back", async () => {
    const { result, executed, events, host } = await runEdg({
      rounds: [
        { toolCalls: [rootWithThen(["npm test", "git diff --stat"])] },
        { text: "All green." },
      ],
    });

    assert.deepEqual(executed, ["npm run build", "npm test", "git diff --stat"]);
    assert.ok(events.includes("synthetic:npm test"));
    assert.ok(events.includes("synthetic:git diff --stat"));
    // triage + agent(root) + agent(final) — the two reused commands cost no model round.
    assert.equal(host.getCounters().modelIterations, 3);
    assert.deepEqual(result.nodesVisited.filter((n) => n === "agent_reuse").length, 2);
    assert.equal(result.reason, "end_node");
  });

  it("offers `then` on the shell tool every agent round (stable schema)", async () => {
    const { offeredTools } = await runEdg({
      rounds: [{ toolCalls: [rootWithThen(["npm test"])] }, { text: "ok" }],
    });
    // offeredTools[0] is triage (fsm_route only after the allow filter).
    const agentRounds = offeredTools.slice(1);
    assert.equal(agentRounds.length, 2);
    for (const tools of agentRounds) {
      const props = tools[0]!.function.parameters!.properties as Record<string, unknown>;
      assert.ok(props.then, "then param offered");
      assert.deepEqual(tools, agentRounds[0]);
    }
    // The host tool definition itself is untouched.
    assert.equal(
      (shellTool.function.parameters!.properties as Record<string, unknown>).then,
      undefined,
    );
  });

  it("a non-zero exit stops the chain and returns to the model", async () => {
    const { executed, host } = await runEdg({
      exitCodes: { "npm test": 1 },
      rounds: [
        { toolCalls: [rootWithThen(["npm test", "git diff --stat"])] },
        { text: "Tests failed; investigating." },
      ],
    });
    assert.deepEqual(executed, ["npm run build", "npm test"]);
    assert.equal(host.getCounters().modelIterations, 3);
  });

  it("a failing root never starts the chain", async () => {
    const { executed, result } = await runEdg({
      exitCodes: { "npm run build": 2 },
      rounds: [{ toolCalls: [rootWithThen(["npm test"])] }, { text: "Build broke." }],
    });
    assert.deepEqual(executed, ["npm run build"]);
    assert.ok(!result.nodesVisited.includes("agent_reuse"));
  });

  it("a pending steer hands control back before the next command", async () => {
    const { executed, events } = await runEdg({
      steerAfterCommand: "npm test",
      rounds: [
        { toolCalls: [rootWithThen(["npm test", "git diff --stat"])] },
        { text: "Reading your note." },
      ],
    });
    assert.deepEqual(executed, ["npm run build", "npm test"]);
    // The agent node's Round gate (not agent_reuse) drains the steer.
    assert.ok(events.includes("steer:drained"));
  });

  it("enabled=false on Edg plan schema disables the whole path", async () => {
    const config = createReactV2GraphConfig();
    for (const action of config.nodes.find((n) => n.id === "agent")!.actions ?? []) {
      if (action.type === "NodeActionEdgPlanSchema") {
        (action.params as Record<string, unknown>).enabled = false;
      }
    }
    const { executed, offeredTools } = await runEdg({
      graphConfig: config,
      rounds: [{ toolCalls: [rootWithThen(["npm test"])] }, { text: "ok" }],
    });
    assert.deepEqual(executed, ["npm run build"]);
    const props = offeredTools[1]![0]!.function.parameters!.properties as Record<string, unknown>;
    assert.equal(props.then, undefined);
  });
});
