import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { debugRunDefinition, debugRunHandler } from "./debugRun.js";
import {
  debugBreakpointsDefinition,
  debugBreakpointsHandler,
} from "./debugBreakpoints.js";
import { debugStepDefinition, debugStepHandler } from "./debugStep.js";
import { debugInspectDefinition, debugInspectHandler } from "./debugInspect.js";
import type {
  DebugControlPort,
  DebugToolBreakpoint,
  DebugToolSnapshot,
} from "../debugControlPort.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type {
  JsonObject,
  ToolExecuteContext,
  ToolExecuteResult,
} from "../types.js";

const WS = "/ws";

function snap(over: Partial<DebugToolSnapshot> = {}): DebugToolSnapshot {
  return {
    workspacePath: WS,
    status: "stopped",
    threads: [{ id: 1, name: "main" }],
    selectedThreadId: 1,
    selectedFrameId: 10,
    stack: [
      { id: 10, name: "Foo::Bar", line: 42, column: 3, file: "/ws/src/a.cpp" },
    ],
    locals: [{ name: "i", value: "3", type: "int", variablesReference: 0 }],
    targets: [],
    console: [{ timestamp: 1, direction: "receive", text: "debugger attached" }],
    stopped: { reason: "breakpoint", description: "breakpoint 1.1" },
    ...over,
  };
}

const SAVED: DebugToolBreakpoint[] = [
  { path: "/ws/src/a.cpp", line: 42, condition: "", enabled: true },
];

function fakePort(over: Partial<DebugControlPort> = {}) {
  const calls = {
    ensure: 0,
    start: [] as Parameters<DebugControlPort["start"]>[0][],
    commands: [] as string[],
    stop: 0,
    breakpoints: [] as Parameters<DebugControlPort["breakpoints"]>[0][],
    evaluate: [] as Array<[string, number]>,
    selectFrame: [] as number[],
    waits: [] as Array<{ statuses: string[]; timeoutMs: number }>,
    bindCallback: [] as Array<Parameters<DebugControlPort["bindBreakpointCallback"]>[0]>,
    unbindCallback: [] as Array<Parameters<DebugControlPort["unbindBreakpointCallback"]>[0]>,
  };
  const bound: Array<{ path: string; line: number }> = [];
  let startCallbackArmed = false;
  let state = snap();
  const base: DebugControlPort = {
    ensureDevMode: async () => {
      calls.ensure += 1;
      return { ok: true };
    },
    start: async (input) => {
      calls.start.push(input);
      startCallbackArmed = input.callback === true;
      return {
        ok: true, snapshot: state, pending: false,
        ...(input.callback !== undefined ? { startCallbackArmed } : {}),
      };
    },
    stop: async () => {
      calls.stop += 1;
      startCallbackArmed = false;
      return { ok: true };
    },
    command: async (command) => {
      calls.commands.push(command);
      return { ok: true };
    },
    state: () => state,
    waitForStatus: async (input) => {
      calls.waits.push({ statuses: [...input.statuses], timeoutMs: input.timeoutMs });
      return state;
    },
    selectFrame: async (frameId) => {
      calls.selectFrame.push(frameId);
      return { ok: true };
    },
    selectThread: async () => ({ ok: true }),
    selectTarget: async () => ({ ok: true }),
    evaluate: async (expression, frameId) => {
      calls.evaluate.push([expression, frameId]);
      return { ok: true, result: "7", variablesReference: 0 };
    },
    variables: async () => ({ ok: true, variables: [] }),
    breakpoints: async (input) => {
      calls.breakpoints.push(input);
      return { ok: true, breakpoints: SAVED };
    },
    bindBreakpointCallback: async (input) => {
      calls.bindCallback.push(input);
      bound.push({ path: input.path, line: input.line });
      return { ok: true, bindings: [...bound] };
    },
    unbindBreakpointCallback: async (input) => {
      calls.unbindCallback.push(input);
      const pathKey = (value: string) => value.replace(/\\/g, "/").toLowerCase();
      for (let index = bound.length - 1; index >= 0; index -= 1) {
        const item = bound[index]!;
        if (input.path && pathKey(item.path) !== pathKey(input.path)) continue;
        if (typeof input.line === "number" && item.line !== input.line) continue;
        bound.splice(index, 1);
      }
      return { ok: true, bindings: [...bound] };
    },
    listBreakpointCallbacks: async () => ({ ok: true, bindings: [...bound] }),
    startCallbackState: async () => ({ ok: true, enabled: startCallbackArmed }),
  };
  const port: DebugControlPort = { ...base, ...over };
  return { port, calls, setState: (next: DebugToolSnapshot) => { state = next; } };
}

function ctx(port: DebugControlPort | null, over: Partial<ToolExecuteContext> = {}): ToolExecuteContext {
  return {
    workspacePath: WS,
    fullPermissionsEnabled: false,
    ...(port ? { debugControl: port } : {}),
    ...over,
  } as ToolExecuteContext;
}

type Handler = (
  args: JsonObject,
  context: ToolExecuteContext,
) => Promise<ToolExecuteResult>;

function text(res: ToolExecuteResult): string {
  const first = res.content[0];
  return first && first.type === "text" ? first.text : "";
}

function normalised(path: string): string {
  return path.replace(/\\/g, "/");
}

describe("debug tool definitions", () => {
  it("are level-1 builtins grouped under development", () => {
    for (const definition of [
      debugRunDefinition,
      debugBreakpointsDefinition,
      debugStepDefinition,
      debugInspectDefinition,
    ]) {
      assert.equal(definition.defaultPermissionLevel, 1);
      assert.ok(definition.parameters.properties, `${definition.name} has no schema`);
    }
    const runProps = debugRunDefinition.parameters.properties as Record<string, unknown>;
    assert.deepEqual((runProps.action as { enum?: string[] }).enum, [
      "start",
      "stop",
      "status",
    ]);
    const stepProps = debugStepDefinition.parameters.properties as Record<string, unknown>;
    assert.deepEqual((stepProps.action as { enum?: string[] }).enum, [
      "continue",
      "pause",
      "next",
      "step_in",
      "step_out",
    ]);
    const bpProps = debugBreakpointsDefinition.parameters.properties as Record<string, unknown>;
    assert.deepEqual((bpProps.action as { enum?: string[] }).enum, [
      "list",
      "add",
      "remove",
      "enable",
      "disable",
      "set_condition",
      "clear",
    ]);
    assert.match(debugRunDefinition.description, /Dev Mode/i);
  });

  it("is wired into the seven registration points and the main/preload bridge", () => {
    const read = (rel: string) =>
      readFileSync(new URL(rel, import.meta.url), "utf8");
    const types = read("../types.ts");
    for (const name of ["debug_run", "debug_breakpoints", "debug_step", "debug_inspect"]) {
      assert.match(types, new RegExp(`\\| "${name}"`));
      assert.match(read("../catalog.ts"), new RegExp(`${name}: "development"`));
      assert.match(read("../displayMeta.ts"), new RegExp(`${name}: \\{`));
      assert.match(read("../executionSummaries.ts"), new RegExp(`${name}: \\(`));
      assert.match(read("../uiDescriptions.ts"), new RegExp(`${name}:`));
      assert.match(
        read("../../shared/icons/toolIconCatalog.ts"),
        new RegExp(`"${name}": \\{`),
      );
    }
    assert.match(read("../index.ts"), /registerBuiltin\(debugRunDefinition, debugRunHandler\)/);
    assert.match(read("../index.ts"), /registerBuiltin\(debugInspectDefinition, debugInspectHandler\)/);
    assert.match(
      read("../../main/index.ts"),
      /configureDebugControl\(createDebugToolPort\(\)\)/,
    );
    assert.match(read("../../main/index.ts"), /registerDevModeReplyChannel\(/);
    assert.match(read("../../preload/index.ts"), /onDevModeRequest:/);
    assert.match(read("../../preload/index.ts"), /replyDevModeRequest:/);
  });
});

describe("debug tools without a port", () => {
  it("report unavailability instead of silently succeeding", async () => {
    const cases: Array<[Handler, JsonObject]> = [
      [debugRunHandler as Handler, { action: "status" }],
      [debugBreakpointsHandler as Handler, { action: "list" }],
      [debugStepHandler as Handler, { action: "next" }],
      [debugInspectHandler as Handler, { action: "stack" }],
    ];
    for (const [handler, args] of cases) {
      const result = await handler(args, ctx(null));
      assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
      assert.match(text(result), /Debug control is unavailable/);
    }
  });
});

describe("debug_run", () => {
  it("enters Dev Mode and starts with the workspace defaults", async () => {
    const { port, calls } = fakePort();
    const result = await (debugRunHandler as Handler)({}, ctx(port));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(calls.ensure, 1);
    assert.equal(calls.start.length, 1);
    assert.match(normalised(calls.start[0]?.workspacePath ?? ""), /\/ws$/);
    assert.equal(calls.start[0]?.waitMs, 120_000);
    assert.match(text(result), /status: stopped/);
    assert.match(text(result), /location: #0 Foo::Bar/);
  });

  it("passes build_id / auto_build / wait_ms through", async () => {
    const { port, calls } = fakePort();
    await (debugRunHandler as Handler)(
      { build_id: "UE5-Editor", auto_build: false, wait_ms: 5_000 },
      ctx(port),
    );
    const first = calls.start[0]!;
    assert.match(normalised(first.workspacePath), /\/ws$/);
    assert.equal(first.buildId, "UE5-Editor");
    assert.equal(first.autoBuild, false);
    assert.equal(first.waitMs, 5_000);
  });

  it("clamps wait_ms and defaults it when junk is passed", async () => {
    const { port, calls } = fakePort();
    await (debugRunHandler as Handler)({ wait_ms: 9_999_999 }, ctx(port));
    await (debugRunHandler as Handler)({ wait_ms: -1 }, ctx(port));
    assert.equal(calls.start[0]?.waitMs, 600_000);
    assert.equal(calls.start[1]?.waitMs, 120_000);
  });

  it("reports a still-preparing start without failing", async () => {
    const { port } = fakePort({
      start: async () => ({
        ok: true,
        pending: true,
        snapshot: snap({ status: "building", progressText: "Compiling DebugGame" }),
      }),
    });
    const result = await (debugRunHandler as Handler)({}, ctx(port));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.match(text(result), /still preparing/);
    assert.match(text(result), /progress: Compiling DebugGame/);
  });

  it("fails with the start message (cancel vs failure)", async () => {
    const cancelled = fakePort({
      start: async () => ({ ok: false, message: "Debug cancelled", cancelled: true }),
    });
    const cancelledResult = await (debugRunHandler as Handler)({}, ctx(cancelled.port));
    assert.equal(cancelledResult.returnCode, ToolReturnCode.Cancelled);

    const failed = fakePort({
      start: async () => ({ ok: false, message: "No Unreal project found" }),
    });
    const failedResult = await (debugRunHandler as Handler)({}, ctx(failed.port));
    assert.equal(failedResult.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(failedResult), /No Unreal project found/);
  });

  it("refuses to start when Dev Mode cannot be entered", async () => {
    const { port, calls } = fakePort({
      ensureDevMode: async () => ({ ok: false, message: "Dev Mode is not available" }),
    });
    const result = await (debugRunHandler as Handler)({}, ctx(port));
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(result), /Dev Mode could not be entered/);
    assert.equal(calls.start.length, 0);
  });

  it("routes status and stop without starting a session", async () => {
    const { port, calls } = fakePort({ state: () => snap({ status: "running" }) });
    const status = await (debugRunHandler as Handler)({ action: "status" }, ctx(port));
    assert.equal(status.returnCode, ToolReturnCode.Success);
    assert.match(text(status), /status: running/);
    const stopped = await (debugRunHandler as Handler)({ action: "stop" }, ctx(port));
    assert.equal(stopped.returnCode, ToolReturnCode.Success);
    assert.equal(calls.stop, 1);
    assert.equal(calls.start.length, 0);
  });

  it("requests a callback for the new start and clears it on stop", async () => {
    const { port, calls } = fakePort();
    const runCtx = ctx(port, { sessionId: "session-a" });
    const result = await (debugRunHandler as Handler)({ action: "start", callback: true }, runCtx);
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(calls.start.length, 1);
    assert.equal(calls.start[0]?.sessionId, "session-a");
    assert.equal(calls.start[0]?.callback, true);
    assert.match(normalised(calls.start[0]?.workspacePath ?? ""), /ws$/);
    assert.match(text(result), /callback: armed/);
    const armed = await (debugRunHandler as Handler)({ action: "status" }, runCtx);
    assert.match(text(armed), /callback: armed/);
    await (debugRunHandler as Handler)({ action: "stop" }, runCtx);
    const stopped = await (debugRunHandler as Handler)({ action: "status" }, runCtx);
    assert.doesNotMatch(text(stopped), /callback:/);
  });

  it("releases the start callback with callback=false", async () => {
    const { port, calls } = fakePort();
    const runCtx = ctx(port, { sessionId: "session-a" });
    const released = await (debugRunHandler as Handler)(
      { action: "start", callback: false },
      runCtx,
    );
    assert.equal(released.returnCode, ToolReturnCode.Success);
    assert.equal(calls.start.at(-1)?.callback, false);
    assert.match(text(released), /callback: released/);
    const state = await (debugRunHandler as Handler)({ action: "status" }, runCtx);
    assert.doesNotMatch(text(state), /callback:/);
  });

  it("needs a session id and action=start for callback", async () => {
    const { port, calls } = fakePort();
    const noSession = await (debugRunHandler as Handler)(
      { action: "start", callback: true },
      ctx(port),
    );
    assert.equal(noSession.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(calls.start.length, 0);
    const wrongAction = await (debugRunHandler as Handler)(
      { action: "status", callback: true },
      ctx(port, { sessionId: "session-a" }),
    );
    assert.equal(wrongAction.returnCode, ToolReturnCode.InvalidArguments);
  });

  it("rejects unknown actions and conflicting workspace arguments", async () => {
    const { port } = fakePort();
    const bad = await (debugRunHandler as Handler)({ action: "restart" }, ctx(port));
    assert.equal(bad.returnCode, ToolReturnCode.InvalidArguments);
    const both = await (debugRunHandler as Handler)(
      { workspace_id: "x", workspace_path: "/other" },
      ctx(port),
    );
    assert.equal(both.returnCode, ToolReturnCode.InvalidArguments);
    const cocoOnly = await (debugRunHandler as Handler)(
      { workspace_id: "x" },
      ctx(port),
    );
    assert.equal(cocoOnly.returnCode, ToolReturnCode.InvalidArguments);
  });
});

describe("debug_breakpoints", () => {
  it("adds a breakpoint with a workspace-relative path and a condition", async () => {
    const { port, calls } = fakePort();
    const result = await (debugBreakpointsHandler as Handler)(
      { action: "add", path: "src/a.cpp", line: 42, condition: "i > 2", enabled: true },
      ctx(port),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    const op = calls.breakpoints[0]?.op;
    assert.equal(op?.action, "add");
    assert.equal(op && "condition" in op ? op.condition : "", "i > 2");
    const path = op && "path" in op ? op.path : "";
    assert.match(normalised(path), /ws\/src\/a\.cpp$/);
    assert.match(text(result), /breakpoints: 1/);
  });

  it("lists, clears and reports the resulting set", async () => {
    const { port, calls } = fakePort();
    const listed = await (debugBreakpointsHandler as Handler)({}, ctx(port));
    assert.equal(listed.returnCode, ToolReturnCode.Success);
    assert.equal(calls.breakpoints[0]?.op.action, "list");
    assert.match(text(listed), /\/ws\/src\/a\.cpp:42 · enabled/);
    const cleared = await (debugBreakpointsHandler as Handler)(
      { action: "clear" },
      ctx(port),
    );
    assert.equal(calls.breakpoints[1]?.op.action, "clear");
    assert.match(text(cleared), /Breakpoint clear applied/);
  });

  it("requires path and a positive line for line-scoped actions", async () => {
    const { port } = fakePort();
    const noPath = await (debugBreakpointsHandler as Handler)(
      { action: "add", line: 12 },
      ctx(port),
    );
    assert.equal(noPath.returnCode, ToolReturnCode.InvalidArguments);
    const noLine = await (debugBreakpointsHandler as Handler)(
      { action: "remove", path: "src/a.cpp" },
      ctx(port),
    );
    assert.equal(noLine.returnCode, ToolReturnCode.InvalidArguments);
    const zeroLine = await (debugBreakpointsHandler as Handler)(
      { action: "enable", path: "src/a.cpp", line: 0 },
      ctx(port),
    );
    assert.equal(zeroLine.returnCode, ToolReturnCode.InvalidArguments);
  });

  it("surfaces the renderer's refusal", async () => {
    const { port } = fakePort({
      breakpoints: async () => ({ ok: false, message: "No breakpoint at /ws/a.cpp:3" }),
    });
    const result = await (debugBreakpointsHandler as Handler)(
      { action: "disable", path: "a.cpp", line: 3 },
      ctx(port),
    );
    assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
    assert.match(text(result), /No breakpoint at/);
  });

  it("binds the calling session to the added line when callback is true", async () => {
    const { port, calls } = fakePort();
    const result = await (debugBreakpointsHandler as Handler)(
      { action: "add", path: "src/a.cpp", line: 42, callback: true },
      ctx(port, { sessionId: "session-a" }),
    );
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.equal(calls.bindCallback.length, 1);
    assert.equal(calls.bindCallback[0]?.sessionId, "session-a");
    assert.equal(calls.bindCallback[0]?.line, 42);
    assert.match(normalised(calls.bindCallback[0]?.path ?? ""), /ws\/src\/a\.cpp$/);
    assert.match(text(result), /callback: bound/);
  });

  it("needs a session id and action=add for callback", async () => {
    const { port, calls } = fakePort();
    const noSession = await (debugBreakpointsHandler as Handler)(
      { action: "add", path: "src/a.cpp", line: 42, callback: true },
      ctx(port),
    );
    assert.equal(noSession.returnCode, ToolReturnCode.InvalidArguments);
    assert.equal(calls.bindCallback.length, 0);
    const wrongAction = await (debugBreakpointsHandler as Handler)(
      { action: "list", callback: true },
      ctx(port, { sessionId: "session-a" }),
    );
    assert.equal(wrongAction.returnCode, ToolReturnCode.InvalidArguments);
  });

  it("releases a binding on callback=false, remove and clear", async () => {
    const { port, calls } = fakePort();
    const bindCtx = ctx(port, { sessionId: "session-a" });
    const add = { action: "add", path: "src/a.cpp", line: 42, callback: true } as const;

    await (debugBreakpointsHandler as Handler)(add, bindCtx);
    const released = await (debugBreakpointsHandler as Handler)(
      { action: "add", path: "src/a.cpp", line: 42, callback: false },
      bindCtx,
    );
    assert.match(text(released), /callback: released/);
    assert.equal(calls.unbindCallback.at(-1)?.line, 42);

    await (debugBreakpointsHandler as Handler)(add, bindCtx);
    await (debugBreakpointsHandler as Handler)(
      { action: "remove", path: "src/a.cpp", line: 42 },
      bindCtx,
    );
    assert.equal(calls.unbindCallback.at(-1)?.line, 42);
    const drained = await (debugBreakpointsHandler as Handler)({ action: "list" }, bindCtx);
    assert.equal(drained.returnCode, ToolReturnCode.Success);
    assert.doesNotMatch(text(drained), /callback:/);

    await (debugBreakpointsHandler as Handler)(add, bindCtx);
    await (debugBreakpointsHandler as Handler)({ action: "clear" }, bindCtx);
    assert.equal(calls.unbindCallback.at(-1)?.line, undefined);
  });

  it("reports the lines this session is resumed at", async () => {
    const { port } = fakePort();
    const bindCtx = ctx(port, { sessionId: "session-a" });
    await (debugBreakpointsHandler as Handler)(
      { action: "add", path: "src/a.cpp", line: 42, callback: true },
      bindCtx,
    );
    const listed = await (debugBreakpointsHandler as Handler)({ action: "list" }, bindCtx);
    assert.match(text(listed), /callback: this session is resumed at .*:42/);
  });
});

describe("debug_step", () => {
  it("steps a paused session and reports the new location", async () => {
    const { port, calls } = fakePort();
    const result = await (debugStepHandler as Handler)({ action: "next" }, ctx(port));
    assert.equal(result.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls.commands, ["next"]);
    assert.equal(calls.waits[0]?.timeoutMs, 20_000);
    assert.match(text(result), /next → stopped/);
    assert.match(text(result), /location: #0 Foo::Bar/);
    assert.match(text(result), /i \(int\) = 3/);
  });

  it("maps every action to its DebugCommand", async () => {
    const { port, calls } = fakePort();
    for (const action of ["next", "step_in", "step_out", "continue"]) {
      await (debugStepHandler as Handler)({ action }, ctx(port));
    }
    assert.deepEqual(calls.commands, ["next", "stepIn", "stepOut", "continue"]);
  });

  it("requires a paused process for stepping and a running one for pause", async () => {
    const running = fakePort({ state: () => snap({ status: "running" }) });
    const stepWhileRunning = await (debugStepHandler as Handler)(
      { action: "next" },
      ctx(running.port),
    );
    assert.equal(stepWhileRunning.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(text(stepWhileRunning), /needs a paused process/);

    const stopped = fakePort();
    const pauseWhileStopped = await (debugStepHandler as Handler)(
      { action: "pause" },
      ctx(stopped.port),
    );
    assert.equal(pauseWhileStopped.returnCode, ToolReturnCode.InvalidArguments);
    assert.match(text(pauseWhileStopped), /needs a running target/);
  });

  it("reports an idle session and a timeout honestly", async () => {
    const idle = fakePort({ state: () => snap({ status: "idle", stack: [], locals: [] }) });
    const noSession = await (debugStepHandler as Handler)({ action: "next" }, ctx(idle.port));
    assert.equal(noSession.returnCode, ToolReturnCode.NotFound);

    const stillRunning = fakePort({
      state: () => snap({ status: "running", stack: [], locals: [] }),
      command: async () => ({ ok: true }),
      waitForStatus: async () => snap({ status: "running", stack: [], locals: [] }),
    });
    const timeout = await (debugStepHandler as Handler)(
      { action: "pause", wait_ms: 1 },
      ctx(stillRunning.port),
    );
    assert.equal(timeout.returnCode, ToolReturnCode.Success);
    assert.match(text(timeout), /still running after 1ms/);
  });
});

describe("debug_inspect", () => {
  it("reads the stack and locals of a paused session", async () => {
    const { port } = fakePort();
    const stack = await (debugInspectHandler as Handler)({ action: "stack" }, ctx(port));
    assert.equal(stack.returnCode, ToolReturnCode.Success);
    assert.match(text(stack), /\* #0 Foo::Bar/);
    assert.match(text(stack), /locals: 1/);
  });

  it("refuses stack/locals/evaluate while the process runs", async () => {
    const { port } = fakePort({ state: () => snap({ status: "running" }) });
    for (const action of ["stack", "locals"]) {
      const result = await (debugInspectHandler as Handler)({ action }, ctx(port));
      assert.equal(result.returnCode, ToolReturnCode.GenericFailure);
      assert.match(text(result), /not paused/);
    }
    const evaluated = await (debugInspectHandler as Handler)(
      { action: "evaluate", expression: "i" },
      ctx(port),
    );
    assert.equal(evaluated.returnCode, ToolReturnCode.GenericFailure);
  });

  it("evaluates in the selected frame and expands a variables reference", async () => {
    const { port, calls } = fakePort();
    const evaluated = await (debugInspectHandler as Handler)(
      { action: "evaluate", expression: "i + 4" },
      ctx(port),
    );
    assert.equal(evaluated.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls.evaluate[0], ["i + 4", 10]);
    assert.match(text(evaluated), /i \+ 4 = 7/);

    const expanded = await (debugInspectHandler as Handler)(
      { action: "variables" },
      ctx(port),
    );
    assert.equal(expanded.returnCode, ToolReturnCode.InvalidArguments);
  });

  it("selects frames/threads and lists targets while running", async () => {
    const { port, calls } = fakePort();
    const selected = await (debugInspectHandler as Handler)(
      { action: "select_frame", frame_id: 10 },
      ctx(port),
    );
    assert.equal(selected.returnCode, ToolReturnCode.Success);
    assert.deepEqual(calls.selectFrame, [10]);

    const missing = await (debugInspectHandler as Handler)(
      { action: "select_frame" },
      ctx(port),
    );
    assert.equal(missing.returnCode, ToolReturnCode.InvalidArguments);

    const running = fakePort({
      state: () =>
        snap({
          status: "running",
          targets: [
            { id: "main", kind: "node", label: "Main", status: "running" },
          ],
          selectedTargetId: "main",
        }),
    });
    const targets = await (debugInspectHandler as Handler)(
      { action: "targets" },
      ctx(running.port),
    );
    assert.equal(targets.returnCode, ToolReturnCode.Success);
    assert.match(text(targets), /main\*\(Main · running\)/);
  });
});
