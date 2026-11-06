/**
 * DOM tests: unified bottom panel (Terminal / Build tabs).
 *
 * Structure (tab order, pips only on task tabs, views outside the tab
 * strip), tab switching + contextual head swap, fresh-run autoswitch
 * (with the terminal-typing guard), pip lifecycle running → ok/failed,
 * and collapse/close visibility.
 */
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

type BridgeMock = {
  outputHandlers: Array<(p: OutputPayload) => void>;
  exitHandlers: Array<(s: Snapshot) => void>;
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
  bridge.state = { ok: true, active: [], last: {} };
  bridge.stopped.length = 0;
  const panel = new UnifiedPanelController();
  const host = document.createElement("div");
  panel.mount(host);
  panel.setWorkspace(WS);
  return panel;
}

test("Terminal, Build and Debug Console share one clear action that targets the active view", async () => {
  const { DebugConsoleView } = await import("./DebugConsoleView.js");
  const panel = fresh();
  const debugConsole = new DebugConsoleView();
  panel.installDebugConsoleView(debugConsole.root);
  panel.setDebugAvailable(true, "electron");
  debugConsole.setRows([{ timestamp: 1, direction: "receive", text: "debug output" }], 1);
  let debugClears = 0;
  panel.debugConsoleControllerClear = () => {
    debugClears++;
    debugConsole.setRows([], 0);
  };
  const clear = panel.root.querySelector<HTMLButtonElement>('button[title="Clear output"]')!;
  const assertOneClear = () => {
    assert.equal(panel.root.querySelectorAll('button[title^="Clear"]').length, 1);
  };
  panel.terminalView.appendOutput("terminal output");
  panel.revealTerminal();
  assertOneClear();
  clear.click();
  assert.equal(panel.terminalView.outputEl.textContent, "");
  assert.equal(debugClears, 0);
  assert.match(debugConsole.root.textContent ?? "", /debug output/);

  panel.revealForTask("build");
  assertOneClear();
  clear.click();
  assert.equal(views(panel)[1]?.textContent, "");
  assert.equal(debugClears, 0);

  tabs(panel).find((tab) => tab.textContent === "Debug Console")!.click();
  assertOneClear();
  clear.click();
  assert.equal(debugClears, 1);
  assert.equal(debugConsole.root.querySelectorAll(".devmode-debug-console-row").length, 0);
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

test("structure: tabs in strip, views outside, pips only on task tabs", () => {
  const panel = fresh();
  const handle = panel.root.querySelector(".devmode-panel-resize");
  assert.equal(panel.root.firstElementChild, handle);
  assert.equal(handle?.getAttribute("role"), "separator");
  assert.equal(handle?.getAttribute("aria-orientation"), "horizontal");
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  const tabLabels = tabs(panel).filter(t => !t.hidden).map((t) => t.textContent);
  assert.deepEqual(tabLabels, ["Terminal", "Build"]);
  // Views are siblings of the strip, not children.
  for (const view of views(panel)) {
    assert.ok(!strip.contains(view), "view must not live in the tab strip");
    assert.equal(view.parentElement, panel.root);
  }
  // Terminal tab has no pip; Build/Run do.
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
  // Cwd readout lives in the terminal input row now (not the strip head).
  assert.ok(
    panel.terminalView.cwdEl.closest(".terminal-pane-form"),
  );

  panel.revealForTask("build");
  assert.equal(term.hidden, true);
  assert.equal(build.hidden, false);
  // Idle task → Stop stays hidden; no contextual text strip remains.
  const stop = panel.root.querySelector(
    ".devmode-panel-ghost.is-danger",
  ) as HTMLElement;
  assert.equal(stop.hidden, true);
  assert.equal(panel.root.querySelector(".devmode-panel-ctx"), null);
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
  // linkedom has no getComputedStyle — assert the compiled stylesheet
  // carries the [hidden] gate for the flex terminal view (the exact class
  // of regression that leaked the input form under the task tabs).
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(
    new URL("./devmode.css", import.meta.url),
    "utf8",
  );
  assert.match(css, /\.devmode-panel-term\[hidden\]\s*\{\s*display:\s*none/);
  // And the flex rule it must override exists too.
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
  // Let the (empty) initial replay land → panel idle.
  await new Promise((r) => setTimeout(r, 10));
  // Main still runs the build, but the panel never attached it (e.g. a
  // superseded workspace switch raced the replay).
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
  // Fresh run opens the panel on its tab.
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
  // Exit summary lands on the log's last line; meta moves to the tooltip.
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
  // Panel stays on the terminal tab — only the pip moves.
  const term = views(panel)[0] as HTMLElement;
  assert.equal(term.hidden, false);
  assert.match(pipOf(panel, "build").className, /is-running/);

  // Blur → next chunk of a still-fresh... no, run already followed. The
  // guard only defers the switch; the run tab is selectable manually.
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
  // Stderr line is red.
  const errLine = views(panel)[1]?.querySelector(".devmode-panel-line.is-err");
  assert.ok(errLine);
  panel.destroy();
});

test("collapse keeps the strip; close hides everything; re-open restores", () => {
  const panel = fresh();
  panel.revealTerminal();
  assert.ok(panel.isOpen());
  panel.hide();
  assert.ok(!panel.isOpen());
  assert.equal(panel.root.hidden, true);
  // Outline button path re-opens on the terminal tab.
  panel.revealTerminal();
  assert.ok(panel.isOpen());
  assert.equal(views(panel)[0].hidden, false);
  panel.destroy();
});

test("status bar hides while the panel is open, returns when closed", () => {
  // Presented state = open && !collapsed — drives the status-bar
  // suppression in DevModeController. Every flip must fire.
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

test("collapse returns the status bar; expand re-hides it", () => {
  const panel = fresh();
  const flips: boolean[] = [];
  panel.onPresentedChange = (p) => flips.push(p);
  panel.revealTerminal();
  // Collapse via the strip's chevron button.
  const collapseBtn = panel.root.querySelector(
    ".devmode-panel-ghost[aria-label='Collapse panel']",
  ) as HTMLButtonElement;
  assert.ok(collapseBtn, "collapse button exists");
  collapseBtn.click();
  assert.deepEqual(flips.slice(-1), [false], "collapse → not presented");
  // Still open (outline button stays is-on).
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
  // Replay is async — let it land.
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

test("References view installs, reveals, and routes Clear", () => {
  const panel = fresh();
  const view = document.createElement("div");
  view.textContent = "usage rows";
  let cleared = 0;
  panel.installReferencesView(view);
  panel.referencesControllerClear = () => {
    cleared += 1;
  };
  panel.revealReferences();

  const referencesTab = tabs(panel).find((tab) =>
    tab.textContent?.includes("References"),
  );
  assert.ok(referencesTab?.classList.contains("is-on"));
  assert.equal(view.parentElement?.hidden, false);
  const clear = panel.root.querySelector(
    ".devmode-panel-ghost.is-icon:not([aria-label])",
  ) as HTMLButtonElement | null;
  clear?.click();
  assert.equal(cleared, 1);
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
