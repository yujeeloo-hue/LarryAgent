import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { Hammer } from "lucide";
import { createLucideIcon } from "../ui/originalIcons.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

type OutputPayload = {
  runId: string;
  task: string;
  workspacePath: string;
  stream: "stdout" | "stderr";
  text: string;
};

type Snapshot = {
  runId: string;
  task: string;
  workspacePath: string;
  command: string;
  status: string;
  exitCode: number | null;
  startedAt: number;
  durationMs: number | null;
  buffer: string;
};

type ProgressPayload = {
  runId: string;
  task: string;
  workspacePath: string;
  elapsedMs: number;
  phase: string;
  doneActions: number | null;
  totalActions: number | null;
  etaMs: number | null;
  currentAction: string | null;
  actionsPerSecond: number | null;
};

type BridgeMock = {
  outputHandlers: Array<(p: OutputPayload) => void>;
  exitHandlers: Array<(s: Snapshot) => void>;
  progressHandlers: Array<(p: ProgressPayload) => void>;
  state: {
    ok: true;
    active: Snapshot[];
    last: Record<string, Snapshot>;
  };
  stopped: string[];
};

const bridge: BridgeMock = {
  outputHandlers: [],
  exitHandlers: [],
  progressHandlers: [],
  state: { ok: true, active: [], last: {} },
  stopped: [],
};

(window as unknown as { jellybot: unknown }).jellybot = {
  getDevTaskState: async () => bridge.state,
  stopDevTask: async (runId: string) => {
    bridge.stopped.push(runId);
    return { ok: true };
  },
  onDevTaskOutput: (h: (p: OutputPayload) => void) => {
    bridge.outputHandlers.push(h);
    return () => {
      bridge.outputHandlers = bridge.outputHandlers.filter((x) => x !== h);
    };
  },
  onDevTaskExit: (h: (s: Snapshot) => void) => {
    bridge.exitHandlers.push(h);
    return () => {
      bridge.exitHandlers = bridge.exitHandlers.filter((x) => x !== h);
    };
  },
  onDevTaskProgress: (h: (p: ProgressPayload) => void) => {
    bridge.progressHandlers.push(h);
    return () => {
      bridge.progressHandlers = bridge.progressHandlers.filter((x) => x !== h);
    };
  },
};

type UnifiedPanelControllerT = typeof import("./UnifiedPanelController.js")["UnifiedPanelController"];
let UnifiedPanelController: UnifiedPanelControllerT;

const WS = "/ws/project";

test.before(async () => {
  ({ UnifiedPanelController } = await import("./UnifiedPanelController.js"));
});

function fresh(): UnifiedPanelController {
  bridge.outputHandlers = [];
  bridge.exitHandlers = [];
  bridge.progressHandlers = [];
  bridge.state = { ok: true, active: [], last: {} };
  bridge.stopped.length = 0;
  const panel = new UnifiedPanelController();
  const host = document.createElement("div");
  panel.mount(host);
  panel.setWorkspace(WS);
  return panel;
}

test("each pane clears its own output — no strip-level Clear remains", async () => {
  const { DebugConsoleView } = await import("./DebugConsoleView.js");
  const panel = fresh();
  const debugConsole = new DebugConsoleView();
  panel.installDebugConsoleView(debugConsole.root);
  panel.setDebugAvailable(true, "electron");
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  assert.equal(strip.querySelectorAll('button[title*="Clear"]').length, 0);

  panel.terminalView.appendOutput("terminal output");
  panel.revealTerminal();
  assert.ok(panel.terminalView.clearButton.closest(".terminal-pane-form"));
  assert.match(
    panel.terminalView.clearButton.querySelector("svg")?.innerHTML ?? "",
    /m16 22-1-4/,
  );
  panel.terminalView.clearButton.click();
  assert.equal(panel.terminalView.outputEl.textContent, "");

  panel.revealForTask("build");
  emitOutput({ runId: "clear-build", task: "build", workspacePath: WS, stream: "stdout", text: "building...\n" });
  const buildLog = panel.root.querySelector(".devmode-panel-build-output") as HTMLElement;
  assert.match(buildLog.textContent ?? "", /building/);
  (panel.root.querySelector(".devmode-build-problems-clear") as HTMLButtonElement).click();
  assert.equal(buildLog.textContent, "");
  assert.equal(panel.root.querySelectorAll(".devmode-build-problem").length, 0);

  assert.equal(debugConsole.clearButton.previousElementSibling, debugConsole.copyButton);
  assert.ok(debugConsole.clearButton.closest(".devmode-debug-console-toolbar"));
  panel.destroy();
});

test("plain Run has its own log and stop action and disappears when switching workspaces", async () => {
  const panel = fresh();
  await new Promise(resolve => setTimeout(resolve, 0));
  panel.revealForTask("run");
  for (const handler of bridge.outputHandlers) handler({ runId: "plain-run", task: "run", workspacePath: WS, stream: "stdout", text: "program output\n" });
  assert.ok(panel.root.textContent?.includes("program output"));
  assert.ok([...panel.root.querySelectorAll(".devmode-panel-tab")].some(tab => tab.textContent?.startsWith("Run")));
  (panel.root.querySelector('button[title="Terminate the process group"]') as HTMLButtonElement).click();
  assert.deepEqual(bridge.stopped, ["plain-run"]);
  panel.setWorkspace("/other");
  assert.ok(![...panel.root.querySelectorAll(".devmode-panel-tab")].some(tab => tab.textContent?.startsWith("Run")));
  panel.destroy();
});

function tabs(panel: UnifiedPanelController): HTMLElement[] {
  return [...panel.root.querySelectorAll(".devmode-panel-tab")];
}

function views(panel: UnifiedPanelController): HTMLElement[] {
  return [...panel.root.querySelectorAll(".devmode-panel-view, .devmode-panel-term")];
}

function pipOf(panel: UnifiedPanelController, task: string): HTMLElement {
  const btn = tabs(panel).find(
    (t) => t.textContent?.includes(task === "deploy" ? "Deploy" : "Build"),
  );
  return btn?.querySelector(".devmode-panel-pip") as HTMLElement;
}

function emitOutput(p: OutputPayload): void {
  for (const h of bridge.outputHandlers) h(p);
}

function emitExit(s: Snapshot): void {
  for (const h of bridge.exitHandlers) h(s);
}

function emitProgress(p: ProgressPayload): void {
  for (const h of bridge.progressHandlers) h(p);
}

test("structure: tabs in strip, views outside, pips only on task tabs", () => {
  const panel = fresh();
  const handle = panel.root.querySelector(".devmode-panel-resize");
  assert.equal(panel.root.firstElementChild, handle);
  assert.equal(handle?.getAttribute("role"), "separator");
  assert.equal(handle?.getAttribute("aria-orientation"), "horizontal");
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  const tabLabels = tabs(panel).filter(t => !t.hidden).map((t) => t.textContent);
  assert.deepEqual(tabLabels, ["Terminal", "Build"]);
  for (const view of views(panel)) {
    assert.ok(!strip.contains(view), "view must not live in the tab strip");
    assert.equal(view.parentElement, panel.root);
  }
  const termTab = tabs(panel)[0] as HTMLElement;
  assert.equal(termTab.querySelector(".devmode-panel-pip"), null);
  assert.ok(pipOf(panel, "build"));
  assert.ok(pipOf(panel, "build"));
  panel.destroy();
});

test("tab switching swaps the visible view and the action buttons", () => {
  const panel = fresh();
  panel.revealTerminal();
  const [term, build] = views(panel);
  assert.equal(term.hidden, false);
  assert.equal(build.hidden, true);
  assert.ok(
    panel.terminalView.cwdEl.closest(".terminal-pane-form"),
  );

  panel.revealForTask("build");
  assert.equal(term.hidden, true);
  assert.equal(build.hidden, false);
  const stop = panel.root.querySelector(
    ".devmode-panel-ghost.is-danger",
  ) as HTMLElement;
  assert.equal(stop.hidden, true);
  assert.equal(panel.root.querySelector(".devmode-panel-ctx"), null);
  panel.destroy();
});

test("Stop moves into the Build progress row and back to the strip", () => {
  const panel = fresh();
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  const stop = panel.root.querySelector<HTMLButtonElement>(".devmode-panel-ghost.is-danger")!;
  const progress = panel.root.querySelector<HTMLElement>(".devmode-panel-progress")!;

  panel.revealForTask("build");
  emitOutput({ runId: "r-progress", task: "build", workspacePath: WS, stream: "stdout", text: "building\n" });
  assert.equal(stop.hidden, false);
  assert.equal(stop.parentElement, strip, "before a progress frame the strip keeps Stop");

  emitProgress({
    runId: "r-progress", task: "build", workspacePath: WS, elapsedMs: 1000,
    phase: "compiling", doneActions: 40, totalActions: 100,
    etaMs: 1000, currentAction: null, actionsPerSecond: null,
  });
  assert.equal(progress.hidden, false);
  assert.equal(stop.parentElement, progress, "progress row owns Stop while building");
  assert.equal(stop.previousElementSibling?.className, "devmode-panel-progress-metrics");
  assert.equal(stop.nextElementSibling?.className, "devmode-panel-progress-bar");
  assert.equal(panel.root.querySelectorAll(".devmode-panel-ghost.is-danger").length, 1);
  stop.click();
  assert.deepEqual(bridge.stopped, ["r-progress"]);

  emitExit({
    runId: "r-progress", task: "build", workspacePath: WS, command: "UBT",
    status: "done", exitCode: 0, startedAt: Date.now() - 1000, durationMs: 1000,
    buffer: "building\n",
  });
  assert.equal(progress.hidden, true);
  assert.equal(stop.parentElement, strip, "Stop returns to the strip when the row closes");
  panel.destroy();
});

test("panel tabs and actions retain the original outline icons", () => {
  const panel = fresh();
  const buildIcon = tabs(panel).find(tab => tab.textContent === "Build")!.querySelector("svg")!;
  assert.equal(buildIcon.innerHTML, createLucideIcon(Hammer, { size: 12, strokeWidth: 2 }).innerHTML);
  panel.setDebugAvailable(true, "electron");
  const icons = [...panel.root.querySelectorAll(".devmode-panel-tabs svg")];
  assert.ok(icons.length >= 5);
  for (const svg of icons) {
    assert.equal(svg.getAttribute("fill"), "none");
    assert.equal(svg.getAttribute("stroke"), "currentColor");
    assert.equal(svg.hasAttribute("data-functional-icon"), false);
  }
  panel.destroy();
});

test("hidden terminal view is display:none — form never leaks (CSS gate)", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("./devmode.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.devmode-panel-term\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.devmode-panel-term\s*\{\s*[^}]*display:\s*flex/);
  assert.match(
    css,
    /\.devmode-panel\s*\{\s*[^}]*flex:\s*0 0 var\(--devmode-panel-height/,
  );
  assert.match(css, /\.devmode-panel-resize\s*\{/);

  const panel = fresh();
  panel.revealForTask("build");
  const term = views(panel)[0] as HTMLElement;
  assert.equal(term.hidden, true);
  assert.equal(term.contains(panel.terminalView.input), true);
  panel.destroy();
});

test("revealForTask while idle shows the waiting line", () => {
  const panel = fresh();
  panel.revealForTask("build");
  const build = views(panel)[1] as HTMLElement;
  assert.match(build.textContent ?? "", /Waiting for output/);
  panel.destroy();
});

test("revealForTask adopts an active run from main (stale panel self-heal)", async () => {
  const panel = fresh();
  await new Promise((r) => setTimeout(r, 10));
  bridge.state = {
    ok: true,
    active: [
      {
        runId: "r-heal",
        task: "build",
        workspacePath: WS,
        command: "ubt MyGame",
        status: "running",
        exitCode: null,
        startedAt: Date.now() - 2000,
        durationMs: null,
        buffer: "[1/4] Compile Module1.cpp\n",
      },
    ],
    last: {},
  };
  panel.revealForTask("build");
  await new Promise((r) => setTimeout(r, 10));
  assert.match(pipOf(panel, "build").className, /is-running/);
  const build = views(panel)[1] as HTMLElement;
  assert.match(build.textContent ?? "", /Compile Module1\.cpp/);
  assert.doesNotMatch(build.textContent ?? "", /Waiting for output/);
  panel.destroy();
});

test("fresh run: pip spins, autoswitch, exit ok → green pip + badge", () => {
  const panel = fresh();
  emitOutput({
    runId: "r1",
    task: "build",
    workspacePath: WS,
    stream: "stdout",
    text: "building...\n",
  });
  assert.ok(panel.isOpen());
  const build = views(panel)[1] as HTMLElement;
  assert.equal(build.hidden, false);
  assert.match(build.textContent ?? "", /building\.\.\./);
  assert.match(pipOf(panel, "build").className, /is-running/);

  emitExit({
    runId: "r1",
    task: "build",
    workspacePath: WS,
    command: "dotnet build",
    status: "done",
    exitCode: 0,
    startedAt: Date.now() - 1000,
    durationMs: 1000,
    buffer: "building...\n",
  });
  assert.match(pipOf(panel, "build").className, /is-ok/);
  assert.match(
    (views(panel)[1] as HTMLElement).textContent ?? "",
    /— exit 0 · /,
  );
  assert.match(
    tabs(panel).find((t) => t.textContent?.includes("Build"))?.title ?? "",
    /exit 0/,
  );
  panel.destroy();
});

test("terminal typing guard: no autoswitch while focused", () => {
  const panel = fresh();
  panel.revealTerminal();
  const input = panel.terminalView.input;
  input.dispatchEvent(new window.Event("focus"));
  emitOutput({
    runId: "r2",
    task: "build",
    workspacePath: WS,
    stream: "stdout",
    text: "starting\n",
  });
  const term = views(panel)[0] as HTMLElement;
  assert.equal(term.hidden, false);
  assert.match(pipOf(panel, "build").className, /is-running/);

  input.dispatchEvent(new window.Event("blur"));
  panel.revealForTask("build");
  const build = views(panel)[1] as HTMLElement;
  assert.equal(build.hidden, false);
  panel.destroy();
});

test("failure exit → red pip + exit badge, stop routes to main", async () => {
  const panel = fresh();
  emitOutput({
    runId: "r3",
    task: "build",
    workspacePath: WS,
    stream: "stderr",
    text: "boom\n",
  });
  panel.revealForTask("build");
  emitExit({
    runId: "r3",
    task: "build",
    workspacePath: WS,
    command: "dotnet build",
    status: "failed",
    exitCode: 1,
    startedAt: Date.now() - 500,
    durationMs: 500,
    buffer: "boom\n",
  });
  assert.match(pipOf(panel, "build").className, /is-failed/);
  assert.match(
    (views(panel)[1] as HTMLElement).textContent ?? "",
    /— exit 1 · /,
  );
  const errLine = views(panel)[1]?.querySelector(".devmode-panel-line.is-err");
  assert.ok(errLine);
  panel.destroy();
});

test("closing keeps the persistent toolbar; re-open restores the panel", () => {
  const panel = fresh();
  panel.revealTerminal();
  assert.ok(panel.isOpen());
  panel.hide();
  assert.ok(!panel.isOpen());
  assert.equal(panel.root.hidden, false);
  assert.ok(panel.root.classList.contains("is-collapsed"));
  panel.revealTerminal();
  assert.ok(panel.isOpen());
  assert.equal(views(panel)[0].hidden, false);
  panel.destroy();
});

test("presented state follows panel content expansion", () => {
  let presented = -1;
  const panel = fresh();
  panel.onPresentedChange = (p) => {
    presented = p ? 1 : 0;
  };
  panel.revealForTask("build");
  assert.equal(presented, 1);
  panel.hide();
  assert.equal(presented, 0);
  panel.destroy();
});

test("collapse keeps the toolbar and reports content presentation", () => {
  const panel = fresh();
  const flips: boolean[] = [];
  panel.onPresentedChange = (p) => flips.push(p);
  panel.revealTerminal();
  const collapseBtn = panel.root.querySelector(
    ".devmode-panel-ghost[aria-label='Collapse panel']",
  ) as HTMLButtonElement;
  assert.ok(collapseBtn, "collapse button exists");
  collapseBtn.click();
  assert.deepEqual(flips.slice(-1), [false], "collapse → not presented");
  assert.ok(panel.isOpen());
  const handle = panel.root.querySelector(
    ".devmode-panel-resize",
  ) as HTMLElement;
  assert.equal(handle.hidden, true, "resize handle hides while collapsed");
  collapseBtn.click();
  assert.deepEqual(flips.slice(-1), [true], "expand → presented again");
  assert.equal(handle.hidden, false);
  panel.destroy();
});

test("top-edge keyboard and double-click resize the panel", () => {
  const panel = fresh();
  panel.revealTerminal();
  const handle = panel.root.querySelector(
    ".devmode-panel-resize",
  ) as HTMLElement;
  assert.ok(handle);
  const fire = (
    target: EventTarget,
    type: string,
    extra: Record<string, unknown>,
  ): void => {
    const event = new window.Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, extra);
    target.dispatchEvent(event);
  };
  fire(handle, "keydown", { key: "ArrowUp" });
  assert.equal(
    panel.root.style.getPropertyValue("--devmode-panel-height"),
    "248px",
  );
  fire(handle, "keydown", { key: "ArrowDown", shiftKey: true });
  assert.equal(
    panel.root.style.getPropertyValue("--devmode-panel-height"),
    "200px",
  );
  fire(handle, "dblclick", {});
  assert.equal(
    panel.root.style.getPropertyValue("--devmode-panel-height"),
    "232px",
  );
  fire(handle, "pointerdown", { button: 0, clientY: 400, pointerId: 1 });
  fire(window, "pointermove", { clientY: 340, pointerId: 1 });
  fire(window, "pointerup", { clientY: 340, pointerId: 1 });
  assert.equal(
    panel.root.style.getPropertyValue("--devmode-panel-height"),
    "292px",
  );
  panel.destroy();
});

test("replay: running task re-opens the panel on Dev Mode entry", async () => {
  bridge.outputHandlers = [];
  bridge.exitHandlers = [];
  bridge.state = {
    ok: true,
    active: [
      {
        runId: "r9",
        task: "build",
        workspacePath: WS,
        command: "dotnet build",
        status: "running",
        exitCode: null,
        startedAt: Date.now(),
        durationMs: null,
        buffer: "listening\n",
      },
    ],
    last: {},
  };
  const panel = new UnifiedPanelController();
  const host = document.createElement("div");
  panel.mount(host);
  panel.setWorkspace(WS);
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(panel.isOpen());
  assert.equal(views(panel)[1].hidden, false);
  assert.match(
    tabs(panel).find((t) => t.textContent?.includes("Build"))?.title ?? "",
    /dotnet build/,
  );
  panel.destroy();
});

test("UBT-style CR progress rewrites the current Build line", () => {
  const panel = fresh();
  emitOutput({
    runId: "r-ubt",
    task: "build",
    workspacePath: WS,
    stream: "stdout",
    text: "[1169/6169] Compile [x64] DataProcessor.cpp\r[2400/6169] Compile [x64] TextureEditor.cpp",
  });
  panel.revealForTask("build");
  const build = views(panel)[1] as HTMLElement;
  const lines = [...build.querySelectorAll(".devmode-panel-line")].map(
    (el) => el.textContent,
  );
  assert.deepEqual(lines, [
    "[2400/6169] Compile [x64] TextureEditor.cpp",
  ]);
  panel.destroy();
});

test("hides Debug tabs until the workspace supports debugging", () => {
  const panel = fresh();
  panel.installDebugView(document.createElement("div"));
  panel.installDebugConsoleView(document.createElement("div"));
  assert.equal(
    tabs(panel).find((t) => t.textContent === "Debug")?.hidden,
    true,
  );
  assert.equal(
    tabs(panel).find((t) => t.textContent === "Debug Console")?.hidden,
    true,
  );
  panel.setDebugAvailable(true);
  assert.equal(
    tabs(panel).find((t) => t.textContent === "Debug")?.hidden,
    false,
  );
  panel.revealDebug();
  panel.setDebugAvailable(false);
  assert.equal(
    tabs(panel).find((t) => t.textContent === "Debug")?.hidden,
    true,
  );
  assert.equal(
    tabs(panel).find((t) => t.getAttribute("aria-selected") === "true")
      ?.textContent,
    "Terminal",
  );
  panel.destroy();
});

test("Debug tab tooltips follow the workspace recipe", () => {
  const panel = fresh();
  panel.installDebugView(document.createElement("div"));
  panel.installDebugConsoleView(document.createElement("div"));
  const dbgTab = () =>
    tabs(panel).find((t) => t.textContent === "Debug");
  const conTab = () =>
    tabs(panel).find((t) => t.textContent === "Debug Console");
  panel.setDebugAvailable(true, "electron");
  assert.equal(dbgTab()?.title, "Electron Debug");
  assert.equal(conTab()?.title, "Inspector output");
  panel.setDebugAvailable(true, "unreal");
  assert.equal(conTab()?.title, "Debugger output");
  assert.equal(dbgTab()?.title, "C++ Debug");
  panel.setDebugAvailable(true, "web");
  assert.equal(dbgTab()?.title, "Web Debug");
  panel.destroy();
});

test("References view installs as a strip tab and reveals on demand", async () => {
  const { FindUsagesView } = await import("./FindUsagesView.js");
  const panel = fresh();
  const view = new FindUsagesView();
  view.renderResults("TryAddItem", [
    { path: "/ws/a.cpp", line: 3, column: 7, lineText: "TryAddItem();", kind: "call" },
  ]);
  panel.installReferencesView(view.root);
  panel.revealReferences();

  const referencesTab = tabs(panel).find((tab) =>
    tab.textContent?.includes("References"),
  );
  assert.ok(referencesTab?.classList.contains("is-on"));
  assert.equal(view.root.parentElement?.hidden, false);
  assert.ok(view.root.querySelector(".devmode-references-clear"));
  assert.equal(
    panel.root.querySelector(".devmode-panel-tabs .devmode-references-clear"),
    null,
  );
  panel.destroy();
});

test("the initial toolbar expands the selected tool and preserves its contents on collapse", () => {
  const panel = fresh();
  assert.equal(panel.root.hidden, false);
  assert.ok(panel.root.classList.contains("is-collapsed"));
  const toggle = panel.root.querySelector<HTMLButtonElement>("button[aria-label='Expand panel']")!;
  const buildTab = tabs(panel).find(tab => tab.textContent === "Build")!;
  const build = views(panel)[1]!;
  buildTab.click();
  emitOutput({ runId: "retained-build", task: "build", workspacePath: WS, stream: "stdout", text: "original log\n" });
  const line = build.firstElementChild;
  build.scrollTop = 24;
  panel.terminalView.input.value = "unfinished command";
  toggle.click();
  assert.ok(panel.root.classList.contains("is-collapsed"));
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(build.firstElementChild, line);
  toggle.click();
  assert.equal(build.hidden, false, "expands Build instead of switching to Terminal");
  assert.equal(build.firstElementChild, line, "does not recreate output nodes");
  assert.equal(build.scrollTop, 24);
  assert.equal(panel.terminalView.input.value, "unfinished command");
  panel.destroy();
});

test("every tool is a strip tab and switching never remounts a view", () => {
  const panel = fresh();
  const debug = document.createElement("div");
  const consoleView = document.createElement("div");
  const references = document.createElement("div");
  const input = document.createElement("input");
  input.value = "preserved expression";
  consoleView.append(input);
  panel.installDebugView(debug);
  panel.installDebugConsoleView(consoleView);
  panel.installReferencesView(references);
  panel.setDebugAvailable(true, "electron");
  const strip = panel.root.querySelector(".devmode-panel-tabs")!;
  assert.deepEqual(
    [...strip.querySelectorAll(".devmode-panel-tab")].map(tab => tab.textContent),
    ["Terminal", "Build", "Deploy", "Debug", "Debug Console", "References"],
  );
  assert.equal(panel.root.querySelector(".devmode-panel-more"), null);
  assert.equal(panel.root.querySelector(".devmode-panel-more-menu"), null);

  const consoleTab = tabs(panel).find(tab => tab.textContent === "Debug Console")!;
  const host = consoleView.parentElement;
  consoleTab.click();
  assert.equal(consoleView.parentElement, host);
  assert.equal(host?.parentElement, panel.root);
  panel.hide();
  panel.revealDebugConsole();
  assert.equal(consoleView.parentElement, host);
  assert.equal(input.value, "preserved expression");
  panel.destroy();
});

test("a task tab keeps its own status pip after the strip loses the overflow pip", () => {
  const panel = fresh();
  panel.setDeployAvailable(true);
  panel.revealForTask("deploy");
  emitOutput({ runId: "strip-deploy", task: "deploy", workspacePath: WS, stream: "stdout", text: "uploading\n" });
  assert.match(pipOf(panel, "deploy").className, /is-running/);
  emitExit({ runId: "strip-deploy", task: "deploy", workspacePath: WS, command: "deploy", status: "failed", exitCode: 1, startedAt: Date.now() - 1000, durationMs: 1000, buffer: "uploading\n" });
  tabs(panel).find(tab => tab.textContent === "Terminal")!.click();
  assert.match(pipOf(panel, "deploy").className, /is-failed/);
  panel.destroy();
});


test("Debug tabs stay reachable while a session runs under another workspace", () => {
  const panel = fresh();
  panel.installDebugView(document.createElement("div"));
  panel.installDebugConsoleView(document.createElement("div"));
  const debugTab = () =>
    tabs(panel).find((tab) => tab.textContent === "Debug");
  const consoleTab = () =>
    tabs(panel).find((tab) => tab.textContent === "Debug Console");

  panel.setDebugAvailable(false);
  assert.equal(debugTab()?.hidden, true);
  assert.equal(consoleTab()?.hidden, true);

  panel.setDebugSessionLive(true);
  assert.equal(debugTab()?.hidden, false);
  assert.equal(consoleTab()?.hidden, false);
  panel.revealDebug();
  assert.equal(debugTab()?.getAttribute("aria-selected"), "true");

  panel.setDebugSessionLive(false);
  assert.equal(debugTab()?.hidden, true);
  assert.equal(consoleTab()?.hidden, true);
  panel.destroy();
});

test("configured Deploy has separate output, stop action and retained failure logs", async () => {
  const panel = fresh();
  await new Promise(r => setTimeout(r, 0));
  const deployTab = tabs(panel).find(t => t.textContent === "Deploy")!;
  assert.equal(deployTab.hidden, true);
  panel.setDeployAvailable(true);
  assert.equal(deployTab.hidden, false);
  panel.revealForTask("deploy");
  const deployView = views(panel)[2];
  assert.equal(deployView.hidden, false);
  emitOutput({ runId: "deploy1", task: "deploy", workspacePath: WS, stream: "stdout", text: "uploading...\n" });
  assert.match(deployView.textContent ?? "", /uploading/);
  assert.doesNotMatch(views(panel)[1].textContent ?? "", /uploading/);
  assert.match(pipOf(panel, "deploy").className, /is-running/);
  const stop = panel.root.querySelector(".devmode-panel-ghost.is-danger") as HTMLButtonElement;
  assert.equal(stop.hidden, false);
  stop.click();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(bridge.stopped, ["deploy1"]);
  emitExit({ runId: "deploy1", task: "deploy", workspacePath: WS, command: "npm run deploy", status: "failed", exitCode: 1, startedAt: Date.now()-1000, durationMs: 1000, buffer: "uploading...\n" });
  assert.match(pipOf(panel, "deploy").className, /is-failed/);
  assert.match(deployView.textContent ?? "", /exit 1/);
  panel.setDeployAvailable(false);
  assert.equal(deployTab.hidden, false, "existing deployment logs stay accessible");
  assert.equal(deployView.hidden, false);
  panel.setWorkspace("/other-project");
  assert.equal(deployTab.hidden, true);
  assert.equal(deployView.hidden, true);
  assert.equal(views(panel)[0].hidden, false);
  panel.destroy();
});
