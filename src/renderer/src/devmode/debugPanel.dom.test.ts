import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(
  Module as unknown as { _extensions: Record<string, () => void> }
)._extensions[".css"] = () => {};

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

type DebugPanelViewT =
  typeof import("./DebugPanelView.js")["DebugPanelView"];
type DebugControllerT =
  typeof import("./DebugController.js")["DebugController"];
let DebugPanelView: DebugPanelViewT;
let DebugController: DebugControllerT;

test.before(async () => {
  ({ DebugPanelView } = await import("./DebugPanelView.js"));
  ({ DebugController } = await import("./DebugController.js"));
});

test("Unreal Program breakpoints outside the game root reach the selected debug target", async () => {
  const requests: Array<{ buildId?: string; breakpoints: Array<{ path: string; line: number }> }> = [];
  Object.assign(window, { jellybot: { startDebug: async (request: typeof requests[number]) => {
    requests.push(request); return { ok: true, snapshot: { workspacePath: "E:/game", status: "running", stack: [], locals: [] } };
  } } });
  const view = new DebugPanelView();
  const controller = new DebugController(view, {
    getWorkspacePath: () => "E:/game", getDebugSourceRoots: () => ["E:/engine/Engine"],
    setEditorBreakpoints: () => {}, setEditorExecutionLocation: () => {}, setEditorFrameLocation: () => {}, revealPanel: () => {}, revealFileLine: async () => {},
  });
  await controller.setWorkspace("E:/game");
  controller.toggleBreakpoint("E:/engine/Engine/Source/Programs/Tool/Main.cpp", 15);
  controller.toggleBreakpoint("E:/unrelated/Other.cpp", 8);
  await controller.start("tool-development");
  assert.equal(requests[0]?.buildId, "tool-development");
  assert.deepEqual(requests[0]?.breakpoints, [{ path: "E:/engine/Engine/Source/Programs/Tool/Main.cpp", line: 15 }]);
  controller.destroy();
});

test("lays out four peer debug columns with title icons", () => {
  const view = new DebugPanelView();
  const body = view.root.querySelector(".devmode-debug-body");
  assert.ok(body);
  const sections = [...body.querySelectorAll(".devmode-debug-col")];
  assert.equal(sections.length, 4);
  assert.equal(body.querySelectorAll(".devmode-debug-col-resize").length, 3);
  assert.ok(sections[0]?.classList.contains("devmode-debug-thread-col"));
  assert.ok(sections[1]?.classList.contains("devmode-debug-stack-col"));
  assert.ok(sections[2]?.classList.contains("devmode-debug-variables-col"));
  assert.ok(sections[3]?.classList.contains("devmode-debug-breakpoints-col"));
  assert.deepEqual(
    sections.map((section) => section.querySelector("h3")?.textContent),
    ["Threads", "Call Stack", "Variables", "Breakpoints"],
  );
  assert.deepEqual(
    [...body.querySelectorAll(".devmode-debug-col-icon .devmode-debug-icon")]
      .map((icon) => (icon as HTMLElement).dataset.debugIcon),
    ["threads", "call-stack", "variables", "breakpoints"],
  );
});

test("shows Electron sessions instead of Unreal copy", () => {
  const view = new DebugPanelView();
  let selected = "";
  view.onTargetSelect = (target) => {
    selected = target.id;
  };
  view.setSnapshot({
    workspacePath: "E:/app",
    recipe: "electron",
    status: "stopped",
    progressText: "Launching Electron…",
    selectedTargetId: "renderer:1",
    targets: [
      { id: "main", kind: "node", label: "Main", status: "running" },
      { id: "renderer:1", kind: "chrome", label: "Renderer · index", status: "stopped" },
    ],
    stack: [
      {
        id: 10,
        name: "render",
        line: 42,
        column: 1,
        source: { path: "E:/app/src/renderer/src/main.ts", name: "main.ts" },
      },
    ],
    locals: [],
  });
  const heading = view.root.querySelector(".devmode-debug-thread-col h3");
  assert.equal(heading?.textContent, "Sessions");
  const detail = view.root.querySelector(".devmode-debug-status-detail");
  assert.match(detail?.textContent ?? "", /Renderer · index/);
  assert.doesNotMatch(detail?.textContent ?? "", /Unreal/);
  const rows = [...view.root.querySelectorAll(".devmode-debug-thread")];
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.classList.contains("is-selected"), true);
  (rows[0] as HTMLButtonElement).click();
  assert.equal(selected, "main");
});

test("shows web Server and Page sessions", () => {
  const view = new DebugPanelView();
  view.setSnapshot({
    workspacePath: "E:/app",
    recipe: "web",
    status: "stopped",
    selectedTargetId: "page:1",
    targets: [
      { id: "server", kind: "node", label: "Server", status: "running" },
      { id: "page:1", kind: "chrome", label: "Page · dashboard", status: "stopped" },
    ],
    stack: [
      {
        id: 10,
        name: "render",
        line: 12,
        column: 1,
        source: { path: "E:/app/apps/web/src/App.tsx", name: "App.tsx" },
      },
    ],
    locals: [],
  });
  const heading = view.root.querySelector(".devmode-debug-thread-col h3");
  assert.equal(heading?.textContent, "Sessions");
  const detail = view.root.querySelector(".devmode-debug-status-detail");
  assert.match(detail?.textContent ?? "", /Page · dashboard/);
  assert.doesNotMatch(detail?.textContent ?? "", /Unreal|Electron/);
  const rows = [...view.root.querySelectorAll(".devmode-debug-thread")];
  assert.equal(rows.length, 2);
  assert.equal(rows[0]?.textContent?.includes("Server"), true);
});

test("starting Electron uses progressText, not Unreal Editor copy", () => {
  const view = new DebugPanelView();
  view.setSnapshot({
    workspacePath: "E:/app",
    recipe: "electron",
    status: "starting",
    progressText: "Launching Electron…",
    stack: [],
    locals: [],
  });
  const detail = view.root.querySelector(".devmode-debug-status-detail");
  assert.equal(detail?.textContent, "Launching Electron…");
  assert.doesNotMatch(view.root.textContent ?? "", /Unreal Editor/);
});

test("starting without a recipe does not mention Unreal Editor", () => {
  const view = new DebugPanelView();
  view.setSnapshot({
    workspacePath: "E:/app",
    status: "starting",
    stack: [],
    locals: [],
  });
  const detail = view.root.querySelector(".devmode-debug-status-detail");
  assert.equal(detail?.textContent, "Starting");
  assert.doesNotMatch(view.root.textContent ?? "", /Unreal/);
});

test("Electron frames without source do not offer PDB load", () => {
  const view = new DebugPanelView();
  view.setSnapshot({
    workspacePath: "E:/app",
    recipe: "electron",
    status: "stopped",
    stack: [{ id: 1, name: "internal", line: 0, column: 0 }],
    locals: [],
  });
  const row = view.root.querySelector(".devmode-debug-frame") as HTMLElement;
  assert.match(row.title, /no source mapped/);
  assert.doesNotMatch(row.title, /load this module's symbols/);
});

test("places Pause and Stop beside Continue", () => {
  const view = new DebugPanelView();
  const toolbar = view.root.querySelector(".devmode-debug-toolbar");
  assert.ok(toolbar);
  assert.deepEqual(
    [...toolbar.children].map((child) => child.getAttribute("title")),
    [
      "Continue (F5)",
      "Pause",
      "Stop",
      null,
      "Step over (F10)",
      "Step in (F11)",
      "Step out (Shift+F11)",
      null,
    ],
  );
  assert.ok(view.continueButton.classList.contains("devmode-debug-continue"));
  assert.ok(view.stopButton.classList.contains("devmode-debug-stop"));
  assert.deepEqual(
    [...toolbar.querySelectorAll<HTMLElement>(".devmode-debug-icon")]
      .map((icon) => icon.dataset.debugIcon),
    ["continue", "pause", "stop", "step-over", "step-in", "step-out"],
  );
});

test("keeps Stop pressed until the debuggee is idle", () => {
  const view = new DebugPanelView();
  assert.equal(view.stopButton.disabled, true);
  view.setSnapshot({
    workspacePath: "E:/game",
    status: "running",
    stack: [],
    locals: [],
  });
  assert.equal(view.stopButton.disabled, false);
  assert.equal(view.stopButton.classList.contains("is-stopping"), false);
  view.setStopPending(true);
  assert.equal(view.stopButton.classList.contains("is-stopping"), true);
  assert.equal(view.stopButton.disabled, false);
  assert.equal(view.stopButton.getAttribute("aria-pressed"), "true");
  assert.equal(view.stopButton.title, "Stopping");
  assert.equal(
    view.root.querySelector(".devmode-debug-status")?.textContent,
    "Stopping",
  );
  view.setSnapshot({
    workspacePath: "E:/game",
    status: "running",
    stack: [],
    locals: [],
  });
  assert.equal(view.stopButton.classList.contains("is-stopping"), true);
  view.setSnapshot({
    workspacePath: "E:/game",
    status: "idle",
    stack: [],
    locals: [],
  });
  assert.equal(view.stopButton.disabled, true);
  assert.equal(view.stopButton.classList.contains("is-stopping"), false);
  assert.equal(view.stopButton.title, "Stop");
});

test("highlights the selected thread and current stack frame", () => {
  const view = new DebugPanelView();
  let selected = 0;
  view.onThreadSelect = (thread) => {
    selected = thread.id;
  };
  view.setSnapshot({
    workspacePath: "E:/game",
    status: "stopped",
    selectedThreadId: 2,
    threads: [
      { id: 1, name: "RenderThread" },
      { id: 2, name: "GameThread" },
    ],
    stack: [
      {
        id: 10,
        name: "AFoo::Tick",
        line: 42,
        column: 1,
        source: { path: "E:/game/Foo.cpp", name: "Foo.cpp" },
      },
    ],
    locals: [],
  });

  const threadRows = [...view.root.querySelectorAll(".devmode-debug-thread")];
  assert.equal(threadRows[1]?.classList.contains("is-selected"), true);
  assert.equal(
    threadRows[1]?.querySelector(".devmode-debug-thread-tag")?.textContent,
    "paused",
  );
  (threadRows[0] as HTMLButtonElement).click();
  assert.equal(selected, 1);
  const frame = view.root.querySelector(".devmode-debug-frame");
  assert.ok(frame?.classList.contains("is-current"));
  assert.ok(frame?.classList.contains("is-selected"));
  assert.equal(frame?.textContent?.includes("AFoo::Tick"), true);
  // Location is tooltip-only now — rows stay uncluttered.
  assert.equal(frame?.textContent?.includes("Foo.cpp"), false);
  assert.match(
    frame?.getAttribute("title") ?? "",
    /AFoo::Tick\nE:\/game\/Foo\.cpp:42/,
  );
});

test("expands Variables rows lazily with cycle guards", async () => {
  const view = new DebugPanelView();
  // The lazy append checks isConnected — the panel must be in the document.
  document.body.append(view.root);
  const expanded: number[] = [];
  view.onVariableExpand = async (node) => {
    expanded.push(node.variablesReference);
    // ref 1 → child with ref 2; ref 2 → child pointing back at ref 1.
    return node.variablesReference === 1
      ? [
          {
            name: "child",
            value: "{...}",
            type: "Child",
            variablesReference: 2,
            depth: 1,
            ancestors: new Set([1]),
            expandable: true,
          },
        ]
      : [
          {
            name: "parent",
            value: "{...}",
            type: "Root",
            variablesReference: 1,
            depth: 2,
            ancestors: new Set([1, 2]),
            expandable: false,
          },
        ];
  };
  view.setSnapshot({
    workspacePath: "E:/game",
    status: "stopped",
    stack: [],
    locals: [
      {
        name: "root",
        value: "{...}",
        type: "Root",
        variablesReference: 1,
      },
      {
        name: "plain",
        value: "42",
        variablesReference: 0,
      },
    ],
  });

  const rows = [...view.root.querySelectorAll(".devmode-debug-variable")];
  assert.equal(rows.length, 2);
  const rootRow = rows[0] as HTMLElement;
  const rootToggle = rootRow.querySelector(
    ".devmode-debug-variable-toggle",
  ) as HTMLButtonElement;
  assert.equal((rows[1] as HTMLElement).querySelector(".devmode-debug-variable-toggle")?.disabled, true);
  assert.equal(rootToggle.disabled, false);
  assert.equal(
    rootRow.querySelector("code")?.textContent,
    "{...}",
  );

  rootToggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  let childRows = [
    ...view.root.querySelectorAll(".devmode-debug-variable"),
  ];
  // Document order: root row, its child, then the untouched plain row.
  assert.equal(childRows.length, 3);
  assert.deepEqual(expanded, [1]);
  const childToggle = childRows[1].querySelector(
    ".devmode-debug-variable-toggle",
  ) as HTMLButtonElement;
  // Expanding the child (ref 2) fetches a node pointing back at ref 1.
  childToggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  childRows = [...view.root.querySelectorAll(".devmode-debug-variable")];
  assert.equal(childRows.length, 4);
  const cycleToggle = childRows[2].querySelector(
    ".devmode-debug-variable-toggle",
  ) as HTMLButtonElement;
  assert.equal(cycleToggle.disabled, true, "cycle ref is not expandable");
  assert.equal(
    childRows[2].querySelector(".devmode-debug-row-main")?.textContent,
    "parent",
  );

  // Collapse hides the children without another fetch.
  rootToggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const children = view.root.querySelector(
    ".devmode-debug-variable-children",
  ) as HTMLElement;
  assert.equal(children.hidden, true);
  childRows = [...view.root.querySelectorAll(".devmode-debug-variable")];
  assert.equal(childRows.length, 4, "rows stay, just hidden");
  assert.deepEqual(expanded, [1, 2]);
  view.root.remove();
});

test("keeps expanded Variables rows when snapshot locals are unchanged", async () => {
  const view = new DebugPanelView();
  document.body.append(view.root);
  view.onVariableExpand = async () => [
    {
      name: "child",
      value: "1",
      variablesReference: 0,
      depth: 1,
      ancestors: new Set([1]),
      expandable: false,
    },
  ];
  const snapshot = {
    workspacePath: "E:/game",
    status: "stopped" as const,
    stack: [],
    locals: [
      {
        name: "root",
        value: "{...}",
        type: "Root",
        variablesReference: 1,
      },
    ],
  };
  view.setSnapshot(snapshot);
  const toggle = view.root.querySelector(
    ".devmode-debug-variable-toggle",
  ) as HTMLButtonElement;
  toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const children = view.root.querySelector(
    ".devmode-debug-variable-children",
  ) as HTMLElement;
  assert.ok(children);
  assert.equal(children.hidden, false);
  assert.equal(toggle.classList.contains("is-open"), true);

  view.setSnapshot({
    ...snapshot,
    progressText: "Debugger attached",
    locals: snapshot.locals.map((local) => ({ ...local })),
  });
  const after = view.root.querySelector(
    ".devmode-debug-variable-children",
  ) as HTMLElement;
  assert.equal(after, children, "tree node stays in the document");
  assert.equal(after.hidden, false);
  assert.equal(toggle.classList.contains("is-open"), true);
  assert.equal(
    view.root.querySelector(".devmode-debug-row-main")?.textContent,
    "root",
  );

  view.setSnapshot({
    ...snapshot,
    locals: [
      {
        name: "root",
        value: "{changed}",
        type: "Root",
        variablesReference: 1,
      },
    ],
  });
  assert.equal(
    view.root.querySelector(".devmode-debug-variable-children"),
    null,
    "changed locals rebuild and collapse",
  );
  view.root.remove();
});

test("toggles breakpoint enabled state and renders disabled marks gray", () => {
  const view = new DebugPanelView();
  const rows = [
    {
      path: "E:/game/Source/Foo.cpp",
      line: 42,
      condition: "",
      enabled: false,
    },
    {
      path: "E:/game/Source/Foo.cpp",
      line: 52,
      condition: "Health <= 0",
      enabled: true,
    },
  ];
  let toggled: (typeof rows)[number] | null = null;
  view.onBreakpointToggleEnabled = (row) => {
    toggled = row;
  };
  view.setBreakpoints(rows);

  const items = [...view.root.querySelectorAll(".devmode-debug-bp")];
  assert.equal(items.length, 2);
  assert.ok(items[0]?.classList.contains("is-disabled"));
  assert.ok(
    items[0]
      ?.querySelector(".devmode-debug-bp-mark")
      ?.classList.contains("is-disabled"),
  );
  assert.equal(items[0]?.querySelector("input"), null);
  assert.ok(
    items[1]
      ?.querySelector(".devmode-debug-bp-mark")
      ?.classList.contains("is-conditional"),
  );

  const toggle = items[0]?.querySelector(
    ".devmode-debug-bp-mark",
  ) as HTMLButtonElement;
  toggle.click();
  assert.equal(toggled, rows[0]);
});

test("pauses while running and steps only while paused", async () => {
  const view = new DebugPanelView();
  let stateHandler: ((snapshot: DebugSnapshot) => void) | null = null;
  const commands: string[] = [];
  Object.assign(window, {
    jellybot: {
      onDebugState: (handler: (snapshot: DebugSnapshot) => void) => {
        stateHandler = handler;
        return () => undefined;
      },
      getDebugState: async (): Promise<DebugSnapshot> => ({
        workspacePath: "E:/game",
        status: "idle",
        stack: [],
        locals: [],
      }),
      runDebugCommand: async (command: string) => {
        commands.push(command);
        return { ok: true };
      },
    },
  });
  const controller = new DebugController(view, {
    getWorkspacePath: () => "E:/game",
    setEditorBreakpoints: () => undefined,
    setEditorExecutionLocation: () => undefined,
    setEditorFrameLocation: () => undefined,
    revealPanel: () => undefined,
    revealFileLine: async () => undefined,
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const press = async (key: string, shiftKey = false): Promise<void> => {
    const event = new dom.window.Event("keydown", { cancelable: true });
    Object.assign(event, { key, shiftKey });
    window.dispatchEvent(event);
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  stateHandler?.({
    workspacePath: "E:/game",
    status: "running",
    stack: [],
    locals: [],
  });
  view.pauseButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commands, ["pause"]);
  commands.length = 0;
  await press("F5");
  assert.deepEqual(commands, [], "running debuggee ignores step keys");

  stateHandler?.({
    workspacePath: "E:/game",
    status: "stopped",
    stopped: { reason: "breakpoint", threadId: 1 },
    stack: [],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  await press("F10");
  await press("F11");
  await press("F11", true);
  await press("F5");
  assert.deepEqual(commands, ["next", "stepIn", "stepOut", "continue"]);

  controller.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
  commands.length = 0;
  await press("F5");
  assert.deepEqual(commands, [], "destroy detaches the shortcuts");
});

test("workspace switch keeps a live session and gates its editor reveal", async () => {
  const view = new DebugPanelView();
  let stateHandler: ((snapshot: DebugSnapshot) => void) | null = null;
  const commands: string[] = [];
  const execution: Array<{ path: string | null; line?: number }> = [];
  const reveals: Array<{ path: string; line: number }> = [];
  const liveFlags: boolean[] = [];
  let revealsPanel = 0;
  let wsPath = "E:/NF";
  Object.assign(window, {
    jellybot: {
      onDebugState: (handler: (snapshot: DebugSnapshot) => void) => {
        stateHandler = handler;
        return () => undefined;
      },
      getDebugState: async (): Promise<DebugSnapshot> => ({
        workspacePath: "E:/NF",
        status: "idle",
        stack: [],
        locals: [],
      }),
      runDebugCommand: async (command: string) => {
        commands.push(command);
        return { ok: true };
      },
    },
  });
  const controller = new DebugController(view, {
    getWorkspacePath: () => wsPath,
    setEditorBreakpoints: () => undefined,
    setEditorExecutionLocation: (path, line) =>
      execution.push(line === undefined ? { path } : { path, line }),
    setEditorFrameLocation: () => undefined,
    revealPanel: () => {
      revealsPanel += 1;
    },
    revealFileLine: async (path, line) => {
      reveals.push({ path, line });
    },
    onSessionLive: (live) => liveFlags.push(live),
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const stoppedAt = (line: number): void => {
    stateHandler?.({
      workspacePath: "E:/NF",
      status: "stopped",
      stopped: { reason: "breakpoint", threadId: 1 },
      stack: [
        {
          id: 1,
          name: "ANFCharacter::Tick",
          line,
          column: 1,
          source: { path: "E:/NF/Source/NFCharacter.cpp", name: "NFCharacter.cpp" },
        },
      ],
      locals: [],
    });
  };

  stoppedAt(42);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(execution.at(-1), {
    path: "E:/NF/Source/NFCharacter.cpp",
    line: 42,
  });
  assert.deepEqual(liveFlags, [true]);
  const banner = view.root.querySelector<HTMLElement>(".devmode-debug-foreign")!;
  assert.equal(banner.hidden, true, "own workspace shows no banner");

  // Switch away — the session must keep running (no stop command).
  wsPath = "E:/Other";
  await controller.setWorkspace("E:/Other");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(commands, [], "workspace switch must not stop the session");
  assert.equal(banner.hidden, false, "foreign banner appears");
  assert.match(banner.textContent ?? "", /NF/);

  // A stop while foreign must not touch this workspace's editor.
  execution.length = 0;
  reveals.length = 0;
  revealsPanel = 0;
  stoppedAt(44);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(execution.length, 0, "foreign frames do not set editor markers");
  assert.equal(reveals.length, 0, "foreign frames do not open files");
  assert.equal(revealsPanel, 0, "foreign stops do not steal the panel");

  // Switch back — the stopped frame re-attaches.
  wsPath = "E:/NF";
  await controller.setWorkspace("E:/NF");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(execution.at(-1), {
    path: "E:/NF/Source/NFCharacter.cpp",
    line: 44,
  });
  assert.equal(banner.hidden, true, "banner clears on return");

  // Session end reports liveness false.
  stateHandler?.({
    workspacePath: "E:/NF",
    status: "idle",
    stack: [],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(liveFlags, [true, false]);

  controller.destroy();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

test("keeps an execution marker while stopped and clears it on resume", async () => {
  const view = new DebugPanelView();
  let stateHandler: ((snapshot: DebugSnapshot) => void) | null = null;
  const locations: Array<{ path: string | null; line?: number }> = [];
  Object.assign(window, {
    jellybot: {
      onDebugState: (handler: (snapshot: DebugSnapshot) => void) => {
        stateHandler = handler;
        return () => undefined;
      },
      getDebugState: async (): Promise<DebugSnapshot> => ({
        workspacePath: "E:/game",
        status: "idle",
        stack: [],
        locals: [],
      }),
    },
  });
  const controller = new DebugController(view, {
    getWorkspacePath: () => "E:/game",
    setEditorBreakpoints: () => undefined,
    setEditorExecutionLocation: (path, line) =>
      locations.push(line === undefined ? { path } : { path, line }),
    setEditorFrameLocation: () => undefined,
    revealPanel: () => undefined,
    revealFileLine: async () => undefined,
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  locations.length = 0;

  stateHandler?.({
    workspacePath: "E:/game",
    status: "stopped",
    stopped: { reason: "breakpoint", threadId: 1 },
    stack: [
      {
        id: 1,
        name: "AFoo::Tick",
        line: 42,
        column: 1,
        source: { path: "E:/game/Source/Foo.cpp", name: "Foo.cpp" },
      },
    ],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(locations.at(-1), {
    path: "E:/game/Source/Foo.cpp",
    line: 42,
  });

  stateHandler?.({
    workspacePath: "E:/game",
    status: "running",
    stack: [],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(locations.at(-1), { path: null });
});

test("opens an upper stack frame: locals, highlight, and mapped source", async () => {
  const view = new DebugPanelView();
  const reveals: Array<{ path: string; line: number }> = [];
  const frameLocations: Array<{ path: string | null; line?: number }> = [];
  const selectedFrames: number[] = [];
  let stateHandler: ((snapshot: DebugSnapshot) => void) | undefined;
  Object.assign(window, {
    jellybot: {
      getDebugState: async (): Promise<DebugSnapshot> => ({
        workspacePath: "E:/game",
        status: "idle",
        stack: [],
        locals: [],
      }),
      onDebugState: (handler: (snapshot: DebugSnapshot) => void) => {
        stateHandler = handler;
        return () => undefined;
      },
      selectDebugFrame: async (frameId: number) => {
        selectedFrames.push(frameId);
        return { ok: true };
      },
    },
  });
  const controller = new DebugController(view, {
    getWorkspacePath: () => "E:/game",
    setEditorBreakpoints: () => undefined,
    setEditorExecutionLocation: () => undefined,
    setEditorFrameLocation: (path, line) =>
      frameLocations.push(line === undefined ? { path } : { path, line }),
    revealPanel: () => undefined,
    resolveSourcePath: async () => "E:/game/Source/Foo.cpp",
    revealFileLine: async (path, line) => {
      reveals.push({ path, line });
    },
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stateHandler?.({
    workspacePath: "E:/game",
    status: "stopped",
    selectedThreadId: 1,
    selectedFrameId: 1,
    threads: [{ id: 1, name: "GameThread" }],
    stack: [
      {
        id: 1,
        name: "AFoo::Tick",
        line: 42,
        column: 1,
        source: { path: "Z:/build/Source/Foo.cpp" },
      },
      {
        id: 2,
        name: "AActor::Tick",
        line: 88,
        column: 1,
        source: { path: "Z:/build/Source/Actor.cpp" },
      },
    ],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  reveals.length = 0;
  frameLocations.length = 0;

  (
    view.root.querySelectorAll(".devmode-debug-frame")[1] as HTMLButtonElement
  ).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(reveals, [{ path: "E:/game/Source/Foo.cpp", line: 88 }]);
  // The caller line gets its own green arrow + wash marker.
  assert.deepEqual(frameLocations, [
    { path: "E:/game/Source/Foo.cpp", line: 88 },
  ]);
  assert.deepEqual(selectedFrames, [2]);
  const rows = [...view.root.querySelectorAll(".devmode-debug-frame")];
  assert.equal(rows[1]?.classList.contains("is-selected"), true);
  assert.equal(rows[0]?.classList.contains("is-selected"), false);
  // Frames with real source never hydrate symbols → no spinner.
  assert.equal(rows[1]?.classList.contains("is-pdb-loading"), false);

  // Going back to the top frame retires the green marker (gold owns it).
  (rows[0] as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(frameLocations.at(-1), { path: null });

  // A fresh stop event resets the selection to the top frame → no marker.
  (rows[1] as HTMLButtonElement).click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stateHandler?.({
    workspacePath: "E:/game",
    status: "stopped",
    selectedThreadId: 1,
    selectedFrameId: 1,
    stack: [
      {
        id: 1,
        name: "AFoo::Tick",
        line: 43,
        column: 1,
        source: { path: "Z:/build/Source/Foo.cpp" },
      },
    ],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(frameLocations.at(-1), { path: null });
  controller.destroy();
});

test("opens an Engine frame after its module PDB is hydrated on demand", async () => {
  const view = new DebugPanelView();
  const reveals: Array<{ path: string; line: number }> = [];
  const executionLocations: Array<{ path: string | null; line?: number }> = [];
  let resolveSelect: (() => void) | undefined;
  let stateHandler: ((snapshot: DebugSnapshot) => void) | undefined;
  Object.assign(window, {
    jellybot: {
      getDebugState: async (): Promise<DebugSnapshot> => ({
        workspacePath: "E:/game",
        status: "idle",
        stack: [],
        locals: [],
      }),
      onDebugState: (handler: (snapshot: DebugSnapshot) => void) => {
        stateHandler = handler;
        return () => undefined;
      },
      selectDebugFrame: async () => {
        await new Promise<void>((resolve) => {
          resolveSelect = resolve;
        });
        return {
          ok: true,
          frame: {
            id: 7,
            name: "UnrealEditor-Core!FMemory::Malloc",
            moduleId: "core",
            line: 314,
            column: 1,
            source: {
              path:
                "Z:/build/++UE5/Sync/Engine/Source/Runtime/Core/Private/HAL/UnrealMemory.cpp",
            },
          },
        };
      },
    },
  });
  const controller = new DebugController(view, {
    getWorkspacePath: () => "E:/game",
    setEditorBreakpoints: () => undefined,
    setEditorExecutionLocation: (path, line) =>
      executionLocations.push(line === undefined ? { path } : { path, line }),
    setEditorFrameLocation: () => undefined,
    revealPanel: () => undefined,
    resolveSourcePath: async () =>
      "E:/UE/Engine/Source/Runtime/Core/Private/HAL/UnrealMemory.cpp",
    revealFileLine: async (path, line) => {
      reveals.push({ path, line });
    },
  });
  controller.mount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  stateHandler?.({
    workspacePath: "E:/game",
    status: "stopped",
    selectedThreadId: 1,
    selectedFrameId: 7,
    threads: [{ id: 1, name: "GameThread" }],
    stack: [
      // lldb-dap answers a skipped-PDB frame with a disassembly source: the
      // path is the module itself and the line indexes the disassembly.
      {
        id: 7,
        name: "FMemory::Malloc",
        line: 12,
        column: 1,
        source: {
          name: "UnrealEditor-Core.dll`FMemory::Malloc",
          path: "E:/UE/Engine/Binaries/Win64/UnrealEditor-Core.dll",
          sourceReference: 4321,
        },
      },
    ],
    locals: [],
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const row = view.root.querySelector(
    ".devmode-debug-frame",
  ) as HTMLButtonElement;
  assert.ok(row.classList.contains("is-external"));
  assert.match(row.title, /UnrealEditor-Core\.dll · no source yet/);
  row.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const frameRow = () =>
    view.root.querySelector('[data-frame-id="7"]') as HTMLElement;
  // Grace period: a cached module answers in a few round-trips and must
  // not flash a spinner.
  assert.equal(frameRow().classList.contains("is-pdb-loading"), false);
  await new Promise((resolve) => setTimeout(resolve, 300));
  // A genuinely slow symbol load spins in the frame's index lane.
  assert.equal(frameRow().classList.contains("is-pdb-loading"), true);
  resolveSelect?.();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(frameRow().classList.contains("is-pdb-loading"), false);
  // The `.dll` must never be revealed: only the hydrated source counts.
  assert.deepEqual(reveals, [
    {
      path:
        "E:/UE/Engine/Source/Runtime/Core/Private/HAL/UnrealMemory.cpp",
      line: 314,
    },
  ]);
  // Top frame → the gold execution marker moves onto the hydrated source.
  assert.deepEqual(executionLocations.at(-1), {
    path: "E:/UE/Engine/Source/Runtime/Core/Private/HAL/UnrealMemory.cpp",
    line: 314,
  });
  controller.destroy();
});
