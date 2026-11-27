import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import {
  MAX_CALLBACK_HITS_PER_BINDING,
  bindBreakpointCallback,
  callbackPathKey,
  evaluateBreakpointCallbacks,
  formatBreakpointHit,
  listBreakpointCallbacks,
  resetBreakpointCallbacks,
  unbindBreakpointCallback,
} from "./debugBreakpointCallback.js";
import type { BreakpointCallbackDeps } from "./debugBreakpointCallback.js";
import type { DebugSnapshot } from "../debug/debugSessionManager.js";

const WS = "E:\\ws";
const FILE = "E:\\ws\\src\\a.cpp";
const OWNER = 7;

function snap(over: Partial<DebugSnapshot> = {}): DebugSnapshot {
  return {
    workspacePath: WS,
    status: "stopped",
    stopped: { reason: "breakpoint", threadId: 1, description: "breakpoint 1.1" },
    threads: [{ id: 1, name: "main" }],
    selectedThreadId: 1,
    selectedFrameId: 10,
    stack: [
      { id: 10, name: "Foo::Bar", line: 42, column: 3, source: { path: FILE } },
    ],
    locals: [],
    targets: [],
    console: [],
    ...over,
  } as DebugSnapshot;
}

function running(): DebugSnapshot {
  const { stopped: _stopped, ...rest } = snap();
  return { ...rest, status: "running", stack: [], locals: [] } as DebugSnapshot;
}

type Call = { sessionId: string; line: number; disarmed: boolean };

function collector(): { calls: Call[]; deps: BreakpointCallbackDeps } {
  const calls: Call[] = [];
  return {
    calls,
    deps: {
      notify: ({ sessionId, hit, disarmed }) => {
        calls.push({ sessionId, line: hit.line, disarmed });
      },
    },
  };
}

beforeEach(() => resetBreakpointCallbacks());

describe("breakpoint callback bindings", () => {
  it("keys paths case- and separator-insensitively", () => {
    assert.equal(callbackPathKey("E:\\ws\\src\\a.cpp"), "e:/ws/src/a.cpp");
    assert.equal(callbackPathKey("  e:/WS/src/a.cpp  "), "e:/ws/src/a.cpp");
  });

  it("keeps one binding per owner, line and session", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s2", path: FILE, line: 42 });
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER }).length, 2);
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER, sessionId: "s2" }).length, 1);
    assert.equal(listBreakpointCallbacks({ ownerId: 99 }).length, 0);
  });

  it("releases one line or a whole session", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 50 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s2", path: FILE, line: 50 });
    assert.equal(unbindBreakpointCallback({ ownerId: OWNER, sessionId: "s1", path: FILE, line: 42 }), 1);
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER, sessionId: "s1" }).length, 1);
    assert.equal(unbindBreakpointCallback({ ownerId: OWNER, sessionId: "s1" }), 1);
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER, sessionId: "s1" }).length, 0);
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER, sessionId: "s2" }).length, 1);
  });
});

describe("breakpoint callback dispatch", () => {
  it("notifies every session bound to the stopped line, once per stop", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s2", path: FILE, line: 42 });
    const { calls, deps } = collector();

    evaluateBreakpointCallbacks(OWNER, running(), deps);
    evaluateBreakpointCallbacks(OWNER, snap(), deps);
    assert.deepEqual(calls.map((call) => call.sessionId).sort(), ["s1", "s2"]);

    // The manager re-emits the same stop for locals and for frame selections.
    evaluateBreakpointCallbacks(OWNER, { ...snap(), locals: [{ name: "i", value: "3", variablesReference: 0 }] } as DebugSnapshot, deps);
    evaluateBreakpointCallbacks(
      OWNER,
      { ...snap(), selectedFrameId: 11, stack: [{ id: 11, name: "Foo::Tick", line: 42, column: 1, source: { path: FILE } }] } as DebugSnapshot,
      deps,
    );
    assert.equal(calls.length, 2);
  });

  it("ignores other lines, other owners and unbound sessions", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    const { calls, deps } = collector();
    evaluateBreakpointCallbacks(
      OWNER,
      { ...snap(), stack: [{ id: 10, name: "Foo::Bar", line: 43, column: 3, source: { path: FILE } }] } as DebugSnapshot,
      deps,
    );
    evaluateBreakpointCallbacks(99, snap(), deps);
    assert.equal(calls.length, 0);
  });

  it("stays quiet while a live debug tool call is already waiting for that stop", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s2", path: FILE, line: 42 });
    const { calls, deps } = collector();
    evaluateBreakpointCallbacks(OWNER, snap(), {
      ...deps,
      isSessionAwaitingDebugTool: (sessionId) => sessionId === "s1",
    });
    assert.deepEqual(calls.map((call) => call.sessionId), ["s2"]);
  });

  it("disarms a runaway loop after the hit cap", () => {
    bindBreakpointCallback({ ownerId: OWNER, workspacePath: WS, sessionId: "s1", path: FILE, line: 42 });
    const { calls, deps } = collector();
    for (let index = 0; index < MAX_CALLBACK_HITS_PER_BINDING; index += 1) {
      evaluateBreakpointCallbacks(OWNER, running(), deps);
      evaluateBreakpointCallbacks(OWNER, snap(), deps);
    }
    assert.equal(calls.length, MAX_CALLBACK_HITS_PER_BINDING);
    assert.equal(calls.at(-1)?.disarmed, true);
    assert.equal(listBreakpointCallbacks({ ownerId: OWNER }).length, 0);
  });
});

describe("breakpoint callback text", () => {
  it("names the stopped line relative to the workspace", () => {
    const text = formatBreakpointHit({
      workspacePath: WS,
      path: FILE,
      line: 42,
      functionName: "Foo::Bar",
      reason: "breakpoint",
      threadId: 1,
    });
    assert.match(text, /Breakpoint hit — src\/a\.cpp:42 in Foo::Bar \(reason: breakpoint, thread 1\)\./);
    assert.match(text, /debug_inspect/);
  });

  it("warns when the cap disarmed the callback", () => {
    const text = formatBreakpointHit(
      { workspacePath: WS, path: FILE, line: 42 },
      { disarmed: true },
    );
    assert.match(text, /Callback disarmed after 50 hits/);
  });
});
