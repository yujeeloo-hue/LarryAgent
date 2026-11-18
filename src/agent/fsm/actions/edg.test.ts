import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SHELL_TOOL_NAME } from "../../../tools/shellToolName.js";
import { checkEdgGuard, EDG_REUSE_EVENT, parseEdgThen } from "./edgBank.js";
import { NodeActionEdgAdmit } from "./NodeActionEdgAdmit.js";
import { NodeActionEdgDispatch } from "./NodeActionEdgDispatch.js";

const ok = (id: string, exitCode = 0) => ({
  toolCallId: id,
  name: SHELL_TOOL_NAME,
  returnCode: exitCode === 0 ? 0 : 1,
  receipt: { exitCode, timedOut: false },
});

const shellCall = (id: string, args: Record<string, unknown>) => ({
  type: "tool_call" as const,
  id,
  name: SHELL_TOOL_NAME,
  status: "done" as const,
  arguments: args,
  argumentsRaw: JSON.stringify(args),
});

const offered = { toolName: SHELL_TOOL_NAME, maxSteps: 6 };

describe("edgBank helpers", () => {
  it("parseEdgThen trims, drops non-strings / blanks and caps at maxSteps", () => {
    assert.deepEqual(parseEdgThen([" a ", "", 3, "b", "c"], 2), ["a", "b"]);
    assert.deepEqual(parseEdgThen("a", 6), []);
  });

  it("checkEdgGuard needs a structured receipt with the expected exit code", () => {
    assert.deepEqual(checkEdgGuard(undefined, 0), { pass: false, reason: "receipt_missing" });
    assert.deepEqual(
      checkEdgGuard({ toolCallId: "x", name: "s", returnCode: 0 }, 0),
      { pass: false, reason: "receipt_missing" },
    );
    assert.deepEqual(checkEdgGuard(ok("x", 1), 0), { pass: false, reason: "exit_code" });
    assert.deepEqual(
      checkEdgGuard({ ...ok("x"), receipt: { exitCode: null, timedOut: true } }, 0),
      { pass: false, reason: "timed_out" },
    );
    assert.deepEqual(checkEdgGuard(ok("x"), 0), { pass: true });
  });
});

describe("NodeActionEdgAdmit", () => {
  const admit = new NodeActionEdgAdmit({});

  it("banks a single shell call's `then` and emits edg_reuse", () => {
    const out = admit.Exec({
      nodeId: "agent",
      turnContext: {},
      nodeContext: {
        edgPlanOffered: offered,
        toolCalls: [shellCall("r", { command: "build", then: ["test"] })],
        toolReceipts: [ok("r")],
      },
    });
    assert.equal(out.nodeContextPatch?.routeEvent, EDG_REUSE_EVENT);
    assert.deepEqual(out.turnContextPatch?.edgBank, {
      rootCallId: "r",
      toolName: SHELL_TOOL_NAME,
      commands: ["test"],
      next: 0,
    });
  });

  it("ignores `then` when the round had parallel tool calls", () => {
    const out = admit.Exec({
      nodeId: "agent",
      turnContext: {},
      nodeContext: {
        edgPlanOffered: offered,
        toolCalls: [
          shellCall("r", { command: "build", then: ["test"] }),
          shellCall("r2", { command: "ls" }),
        ],
        toolReceipts: [ok("r"), ok("r2")],
      },
    });
    assert.equal(out.nodeContextPatch?.routeEvent, undefined);
  });

  it("a new model round drops a stale bank", () => {
    const out = admit.Exec({
      nodeId: "agent",
      turnContext: {
        edgBank: { rootCallId: "old", toolName: SHELL_TOOL_NAME, commands: ["x"], next: 0 },
      },
      nodeContext: { edgPlanOffered: offered, toolCalls: [] },
    });
    assert.equal(out.turnContextPatch?.edgBank, null);
  });

  it("does not override a route event a tool already emitted", () => {
    const out = admit.Exec({
      nodeId: "agent",
      turnContext: {},
      nodeContext: {
        edgPlanOffered: offered,
        routeEvent: "plan_resume",
        toolCalls: [shellCall("r", { command: "build", then: ["test"] })],
        toolReceipts: [ok("r")],
      },
    });
    assert.equal(out.nodeContextPatch?.routeEvent, undefined);
    assert.equal(out.turnContextPatch?.edgBank, null);
  });
});

describe("NodeActionEdgDispatch", () => {
  it("emits the next banked command and advances the bank (stub host)", () => {
    const dispatch = new NodeActionEdgDispatch({});
    const out = dispatch.Exec({
      nodeId: "agent_reuse",
      turnContext: {
        edgBank: { rootCallId: "r", toolName: SHELL_TOOL_NAME, commands: ["a", "b"], next: 1 },
      },
      nodeContext: {},
    });
    const calls = out.nodeContextPatch?.toolCalls as Array<{ arguments: { command: string } }>;
    assert.equal(calls[0]!.arguments.command, "b");
    assert.equal(out.nodeContextPatch?.hasPendingToolCalls, true);
    assert.equal(
      (out.turnContextPatch?.edgBank as { next: number }).next,
      2,
    );
  });

  it("clears an exhausted bank without dispatching", () => {
    const out = new NodeActionEdgDispatch({}).Exec({
      nodeId: "agent_reuse",
      turnContext: {
        edgBank: { rootCallId: "r", toolName: SHELL_TOOL_NAME, commands: ["a"], next: 1 },
      },
      nodeContext: {},
    });
    assert.equal(out.nodeContextPatch, undefined);
    assert.equal(out.turnContextPatch?.edgBank, null);
  });
});
