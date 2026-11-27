import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  MAX_LIFECYCLE_NOTICES_PER_BINDING,
  armStartCallback,
  disarmStartCallback,
  evaluateStartCallbacks,
  formatLifecycleNotice,
  isStartCallbackArmed,
  listStartCallbacks,
  resetStartCallbacks,
  unbindStartCallbacksForOwner,
} from "./debugLifecycleCallback.js";
import type { DebugLifecycleDeps, DebugLifecycleEvent } from "./debugLifecycleCallback.js";
import type { DebugSnapshot } from "../debug/debugSessionManager.js";

const WS = "E:\\ws";
const OWNER = 7;
const PROGRAM = "E:\\Engines\\UE\\UnrealEditor-Win64-DebugGame.exe";

function snap(
  status: DebugSnapshot["status"],
  over: Partial<DebugSnapshot> = {},
): DebugSnapshot {
  return {
    workspacePath: WS,
    status,
    recipe: "unreal",
    program: PROGRAM,
    progressText: "UnrealEditor · DebugGame · Win64 · see the Build tab",
    stack: [],
    locals: [],
    targets: [],
    console: [],
    ...over,
  } as DebugSnapshot;
}

type Call = { sessionId: string; event: DebugLifecycleEvent; disarmed: boolean };

function collector(): { calls: Call[]; deps: DebugLifecycleDeps } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      notify: ({ sessionId, notice, disarmed }) => {
        calls.push({ sessionId, event: notice.event, disarmed });
      },
    },
  };
}

function arm(sessionId = "s1"): void {
  armStartCallback({ ownerId: OWNER, sessionId, workspacePath: WS });
}

beforeEach(() => resetStartCallbacks());

describe("start callback bindings", () => {
  it("keeps one binding per owner and session", () => {
    arm("s1");
    arm("s1");
    arm("s2");
    assert.equal(listStartCallbacks(OWNER).length, 2);
    assert.equal(isStartCallbackArmed({ ownerId: OWNER, sessionId: "s1" }), true);
    assert.equal(disarmStartCallback({ ownerId: OWNER, sessionId: "s1" }), true);
    assert.equal(isStartCallbackArmed({ ownerId: OWNER, sessionId: "s1" }), false);
    assert.equal(listStartCallbacks(OWNER).length, 1);
  });

  it("drops every binding of a closed window", () => {
    arm("s1");
    arm("s2");
    unbindStartCallbacksForOwner(OWNER);
    assert.equal(listStartCallbacks(OWNER).length, 0);
  });
});

describe("start callback milestones", () => {
  it("notifies the build and then the launch, once each", () => {
    arm();
    const { calls, deps } = collector();

    evaluateStartCallbacks(OWNER, snap("building"), deps);
    evaluateStartCallbacks(OWNER, snap("starting", { progressText: "Checking lldb-dap…" }), deps);
    assert.deepEqual(calls.map((call) => call.event), ["build-finished"]);

    // Attach keeps re-emitting running with new progress only once per phase here.
    evaluateStartCallbacks(OWNER, snap("running", { progressText: "Editor ready · attaching debugger…" }), deps);
    evaluateStartCallbacks(OWNER, snap("running", { progressText: "Debugger attached · applying breakpoints…" }), deps);
    assert.deepEqual(calls.map((call) => call.event), ["build-finished", "launched"]);
    assert.equal(calls.every((call) => call.sessionId === "s1"), true);
  });

  it("skips the build milestone when the build gate was already closed", () => {
    arm();
    const { calls, deps } = collector();
    evaluateStartCallbacks(OWNER, snap("starting", { progressText: "Launching Electron…" }), deps);
    evaluateStartCallbacks(OWNER, snap("running"), deps);
    assert.deepEqual(calls.map((call) => call.event), ["launched"]);
  });

  it("reports a failed start instead of staying silent", () => {
    arm();
    const { calls, deps } = collector();
    evaluateStartCallbacks(OWNER, snap("building"), deps);
    evaluateStartCallbacks(OWNER, snap("error", { error: "Build ended as \"failed\"" }), deps);
    assert.deepEqual(calls.map((call) => call.event), ["failed"]);
  });

  it("stays silent for later status churn and for unarmed owners", () => {
    arm();
    const { calls, deps } = collector();
    evaluateStartCallbacks(OWNER, snap("starting"), deps);
    evaluateStartCallbacks(OWNER, snap("running"), deps);
    const afterLaunch = calls.length;
    evaluateStartCallbacks(OWNER, snap("stopped"), deps);
    evaluateStartCallbacks(OWNER, snap("running"), deps);
    evaluateStartCallbacks(OWNER, snap("idle"), deps);
    assert.equal(calls.length, afterLaunch);
    evaluateStartCallbacks(99, snap("building"), deps);
    evaluateStartCallbacks(99, snap("starting"), deps);
    assert.equal(calls.length, afterLaunch);
  });

  it("notifies every bound session and skips one that is awaiting a tool result", () => {
    arm("s1");
    arm("s2");
    const { calls, deps } = collector();
    evaluateStartCallbacks(OWNER, snap("building"), {
      ...deps,
      isSessionAwaitingDebugTool: (sessionId) => sessionId === "s1",
    });
    evaluateStartCallbacks(OWNER, snap("starting"), {
      ...deps,
      isSessionAwaitingDebugTool: (sessionId) => sessionId === "s1",
    });
    evaluateStartCallbacks(OWNER, snap("running"), {
      ...deps,
      isSessionAwaitingDebugTool: (sessionId) => sessionId === "s1",
    });
    assert.deepEqual(calls.map((call) => call.sessionId), ["s2", "s2"]);
  });

  it("disarms a flapping start after the notice cap", () => {
    arm();
    const { calls, deps } = collector();
    for (let attempt = 0; attempt < 15; attempt += 1) {
      evaluateStartCallbacks(OWNER, snap("building"), deps);
      evaluateStartCallbacks(OWNER, snap("starting"), deps);
      evaluateStartCallbacks(OWNER, snap("running"), deps);
      evaluateStartCallbacks(OWNER, snap("idle"), deps);
    }
    assert.equal(calls.length, MAX_LIFECYCLE_NOTICES_PER_BINDING);
    assert.equal(calls.at(-1)?.disarmed, true);
    assert.equal(listStartCallbacks(OWNER).length, 0);
  });
});

describe("start callback text", () => {
  it("names the milestone, the recipe and the program", () => {
    const built = formatLifecycleNotice({
      event: "build-finished",
      workspacePath: WS,
      recipe: "unreal",
      program: PROGRAM,
      progressText: "UnrealEditor · DebugGame · Win64",
    });
    assert.match(built, /^Build finished — UnrealEditor · DebugGame · Win64 \(unreal · UnrealEditor-Win64-DebugGame\.exe\)\./);
    assert.match(built, /resumed again once it is up/);

    const launched = formatLifecycleNotice({
      event: "launched",
      workspacePath: WS,
      recipe: "unreal",
      program: PROGRAM,
    });
    assert.match(launched, /^Debugger attached — the app is up \(unreal · UnrealEditor-Win64-DebugGame\.exe\)\./);
    assert.match(launched, /debug_run action=status/);
  });

  it("carries the failure text and the disarm note", () => {
    const failed = formatLifecycleNotice(
      { event: "failed", workspacePath: WS, error: "Build ended as \"failed\"" },
      { disarmed: true },
    );
    assert.match(failed, /^Debug start failed — Build ended as "failed"\./);
    assert.match(failed, /Callback disarmed after 20 notices/);
  });
});
