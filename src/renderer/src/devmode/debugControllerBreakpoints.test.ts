import assert from "node:assert/strict";
import Module from "node:module";
import { afterEach, before, beforeEach, describe, it } from "node:test";
import type { StoredBreakpoint } from "./breakpointStore.js";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] =
  () => {};

type DebugControllerT =
  (typeof import("./DebugController.js"))["DebugController"];
type BreakpointStoreT = typeof import("./breakpointStore.js");

let DebugController: DebugControllerT;
let store: BreakpointStoreT;

before(async () => {
  store = await import("./breakpointStore.js");
  ({ DebugController } = await import("./DebugController.js"));
});

const WS = "/ws";

class MemoryStorage {
  private readonly data = new Map<string, string>();
  get length(): number {
    return this.data.size;
  }
  clear(): void {
    this.data.clear();
  }
  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.data.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.data.delete(key);
  }
  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }
}

function fakeView() {
  const element = () => ({ addEventListener: () => {} });
  const paints: StoredBreakpoint[][] = [];
  const view = {
    continueButton: element(),
    pauseButton: element(),
    stepOverButton: element(),
    stepInButton: element(),
    stepOutButton: element(),
    stopButton: element(),
    setBreakpoints: (rows: StoredBreakpoint[]) => {
      paints.push(rows);
    },
  };
  return { view, paints };
}

function fakeDeps() {
  const editorPaints: Array<Map<string, Map<number, unknown>>> = [];
  const revealed: string[] = [];
  const deps = {
    getWorkspacePath: () => WS,
    setEditorBreakpoints: (map: Map<string, Map<number, unknown>>) => {
      editorPaints.push(map);
    },
    setEditorExecutionLocation: () => {},
    setEditorFrameLocation: () => {},
    revealPanel: () => {
      revealed.push("debug");
    },
    revealFileLine: async () => {},
  };
  return { deps, editorPaints, revealed };
}

function makeController() {
  const { view, paints } = fakeView();
  const { deps, editorPaints, revealed } = fakeDeps();
  const controller = new DebugController(view as never, deps as never);
  return { controller, paints, editorPaints, revealed };
}

function normalised(path: string): string {
  return path.replace(/\\/g, "/");
}

describe("DebugController breakpoint API", () => {
  let previous: PropertyDescriptor | undefined;

  beforeEach(() => {
    previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    if (previous) Object.defineProperty(globalThis, "localStorage", previous);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });

  it("plants a breakpoint, repaints the gutter/panel and persists it", () => {
    const { controller, paints, editorPaints } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    assert.deepEqual(controller.listBreakpoints(), [
      { path: "/ws/src/a.cpp", line: 42, condition: "", enabled: true },
    ]);
    assert.equal(paints.length, 1);
    assert.equal(editorPaints.length, 1);
    assert.deepEqual([...store.loadBreakpoints(WS).keys()].map(normalised), [
      "/ws/src/a.cpp",
    ]);
  });

  it("is idempotent for an unchanged breakpoint", () => {
    const { controller, paints } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    assert.equal(paints.length, 1);
    assert.equal(controller.listBreakpoints().length, 1);
  });

  it("supports a conditional and a disabled breakpoint", () => {
    const { controller } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 7, {
      condition: " i > 2 ",
      enabled: false,
    });
    assert.deepEqual(controller.listBreakpoints(), [
      { path: "/ws/src/a.cpp", line: 7, condition: "i > 2", enabled: false },
    ]);
  });

  it("sets a condition, planting a breakpoint when the line has none", () => {
    const { controller } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    controller.setBreakpointCondition("/ws/src/a.cpp", 42, "x == 1");
    assert.equal(controller.listBreakpoints()[0]?.condition, "x == 1");
    controller.setBreakpointCondition("/ws/src/a.cpp", 50, "y");
    assert.deepEqual(
      controller.listBreakpoints().map((row) => [row.line, row.condition]),
      [
        [42, "x == 1"],
        [50, "y"],
      ],
    );
  });

  it("disables, removes and clears", () => {
    const { controller } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    controller.addBreakpoint("/ws/src/a.cpp", 50);
    controller.addBreakpoint("/ws/src/b.cpp", 10);

    controller.setBreakpointEnabled("/ws/src/a.cpp", 50, false);
    assert.equal(
      controller.listBreakpoints().find((row) => row.line === 50)?.enabled,
      false,
    );

    controller.removeBreakpoint("/ws/src/a.cpp", 42);
    assert.deepEqual(
      controller.listBreakpoints().map((row) => `${row.path}:${row.line}`),
      ["/ws/src/a.cpp:50", "/ws/src/b.cpp:10"],
    );

    controller.clearAllBreakpoints();
    assert.deepEqual(controller.listBreakpoints(), []);
    assert.equal(store.loadBreakpoints(WS).size, 0);
  });

  it("reads another workspace straight from its own store", () => {
    const { controller } = makeController();
    controller.addBreakpoint("/ws/src/a.cpp", 42);
    store.saveBreakpoints(
      "/other",
      new Map([["/other/x.cpp", new Map([[3, { condition: "", enabled: true }]])]]),
    );

    assert.deepEqual(controller.listBreakpoints("/other"), [
      { path: "/other/x.cpp", line: 3, condition: "", enabled: true },
    ]);
    assert.deepEqual(
      controller.listBreakpoints().map((row) => row.path),
      ["/ws/src/a.cpp"],
    );
    assert.equal(controller.listBreakpoints("\\ws").length, 1);
  });

  it("exposes the panel reveal used before starting a session", () => {
    const { controller, revealed } = makeController();
    controller.reveal();
    assert.deepEqual(revealed, ["debug"]);
  });
});
