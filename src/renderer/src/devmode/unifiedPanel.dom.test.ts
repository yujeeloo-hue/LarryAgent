import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import { Hammer, Terminal } from "lucide";
import { PRE_BUILD_TASK_ID } from "../../../shared/devTaskIds.js";
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
  command?: string;
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
  tasks: Array<{ id: string; command: string }>;
  stopped: string[];
};

const bridge: BridgeMock = {
  outputHandlers: [],
  exitHandlers: [],
  progressHandlers: [],
  state: { ok: true, active: [], last: {} },
  tasks: [],
  stopped: [],
};

(window as unknown as { jellybot: unknown }).jellybot = {
  getDevTaskState: async () => bridge.state,
  getDevTaskConfig: async () => ({ ok: true, tasks: bridge.tasks }),
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
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  ({ UnifiedPanelController } = await import("./UnifiedPanelController.js"));
});

async function fresh(): Promise<UnifiedPanelController> {
  bridge.outputHandlers = [];
  bridge.exitHandlers = [];
  bridge.progressHandlers = [];
  bridge.state = { ok: true, active: [], last: {} };
  bridge.tasks = [
    { id: "build", command: "call Build\\BuildAndRun.bat -skip-lint" },
    { id: "lint-only", command: "py -3 Build\\Lint\\check_lint.py --all" },
  ];
  bridge.stopped.length = 0;
  const panel = new UnifiedPanelController();
  const host = document.createElement("div");
  panel.mount(host);
  panel.setWorkspace(WS);
  await tick();
  return panel;
}

function tabs(panel: UnifiedPanelController): HTMLElement[] {
  return [...panel.root.querySelectorAll(".devmode-panel-tab")];
}

function visibleTabs(panel: UnifiedPanelController): string[] {
  return tabs(panel)
    .filter((t) => !t.hidden)
    .map((t) => t.textContent ?? "");
}

function tabNamed(panel: UnifiedPanelController, label: string): HTMLElement | undefined {
  return tabs(panel).find((t) => t.textContent === label || t.textContent?.startsWith(label));
}

function views(panel: UnifiedPanelController): HTMLElement[] {
  return [...panel.root.querySelectorAll(".devmode-panel-view, .devmode-panel-term")];
}

function problemsView(panel: UnifiedPanelController): HTMLElement {
  return panel.root.querySelector(".devmode-panel-build .devmode-build-problems") as HTMLElement;
}

function buildOutputEl(panel: UnifiedPanelController): HTMLElement {
  return panel.root.querySelector(".devmode-panel-build-output") as HTMLElement;
}

function buildText(panel: UnifiedPanelController): string {
  return buildOutputEl(panel).textContent ?? "";
}

function chunks(panel: UnifiedPanelController, kind: string): HTMLElement[] {
  return [...panel.terminalView.outputEl.querySelectorAll(`.terminal-pane-chunk.is-${kind}`)];
}

function buildChunks(panel: UnifiedPanelController, kind: string): HTMLElement[] {
  return [...buildOutputEl(panel).querySelectorAll(`.terminal-pane-chunk.is-${kind}`)];
}

function terminalText(panel: UnifiedPanelController): string {
  return panel.terminalView.outputEl.textContent ?? "";
}

function tabPip(panel: UnifiedPanelController, label: string): HTMLElement {
  return tabNamed(panel, label)!.querySelector(".devmode-panel-pip") as HTMLElement;
}

function terminalPip(panel: UnifiedPanelController): HTMLElement {
  return tabPip(panel, "Terminal");
}

function buildPip(panel: UnifiedPanelController): HTMLElement {
  return tabPip(panel, "Build");
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

test("every pane clears itself — no strip-level Clear", async () => {
  const { DebugConsoleView } = await import("./DebugConsoleView.js");
  const panel = await fresh();
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

  emitOutput({ runId: "clear-build", task: "build", workspacePath: WS, stream: "stderr", text: "Main.cpp(4): error C2065: nope\n" });
  assert.equal(panel.root.querySelectorAll(".devmode-build-problem").length, 1);
  assert.match(buildText(panel), /nope/, "the build log keeps the raw compiler line");
  (panel.root.querySelector(".devmode-build-problems-clear") as HTMLButtonElement).click();
  assert.equal(panel.root.querySelectorAll(".devmode-build-problem").length, 0);
  assert.equal(buildText(panel), "", "one Clear empties the Build panel it belongs to");

  assert.equal(debugConsole.clearButton.previousElementSibling, debugConsole.copyButton);
  assert.ok(debugConsole.clearButton.closest(".devmode-debug-console-toolbar"));
  panel.destroy();
});

test("precompile tasks (lint, generate) stream into the Build panel — no per-task tab is spawned", async () => {
  const panel = await fresh();
  emitOutput({ runId: "lint-1", task: "lint-only", workspacePath: WS, stream: "stdout", text: "529 error\n" });
  assert.ok(panel.isOpen());
  assert.equal(tabNamed(panel, "Build")?.getAttribute("aria-selected"), "true");
  assert.deepEqual(visibleTabs(panel), ["Terminal", "Build"]);
  assert.equal(buildText(panel).includes("lint-only"), false, "raw task id is never surfaced as a label");
  const head = buildChunks(panel, "meta").map((el) => el.textContent);
  assert.deepEqual(head, ["$ py -3 Build\\Lint\\check_lint.py --all\n"]);
  assert.match(buildText(panel), /529 error/);
  assert.equal(terminalText(panel), "", "the shell log stays clean");
  panel.destroy();
});

test("standalone Lint opens the Build panel and prints the command and exit code", async () => {
  const panel = await fresh();
  const runId = "standalone-lint";
  const command = "npm run typecheck";
  const task = PRE_BUILD_TASK_ID;
  emitOutput({ runId, task, workspacePath: WS, command, stream: "stdout", text: "" });
  assert.ok(panel.isOpen());
  assert.equal(tabNamed(panel, "Build")?.getAttribute("aria-selected"), "true");
  assert.ok(buildPip(panel).classList.contains("is-running"));
  emitOutput({ runId, task, workspacePath: WS, stream: "stderr", text: "Type check failed\n" });
  emitExit({ runId, task, workspacePath: WS, command, status: "failed", exitCode: 2,
    startedAt: Date.now(), durationMs: 50, buffer: "Type check failed\n" });
  assert.match(buildText(panel), /\$ npm run typecheck\nType check failed\n— exit 2/);
  assert.match(buildOutputEl(panel).querySelector('[data-build-tone="error"]')?.textContent ?? "", /— exit 2/);
  assert.ok(buildPip(panel).classList.contains("is-failed"));
  assert.equal(terminalText(panel), "");
  panel.destroy();
});

test("every Build-panel task feeds Problems; terminal tasks do not", async () => {
  const panel = await fresh();
  const rows = (): string[] =>
    [...problemsView(panel).querySelectorAll<HTMLElement>(".devmode-build-problem")].map((row) => row.dataset.severity ?? "");
  const lint = { runId: "lint-problems", task: PRE_BUILD_TASK_ID, workspacePath: WS };
  emitOutput({ ...lint, command: "py -3 Build\\Lint\\check_lint.py", stream: "stdout", text: "" });
  emitOutput({ ...lint, stream: "stdout", text: "src/A.cpp:3:1: warning: trailing space\nsrc/B.cpp(9): error L001: bad include\n" });
  assert.deepEqual(rows(), ["error", "warning"], "standalone Lint lands in Problems");

  const custom = { runId: "custom-check", task: "lint-only", workspacePath: WS };
  emitOutput({ ...custom, stream: "stdout", text: "C.cpp(2): warning C4100: unused\n" });
  assert.deepEqual(rows(), ["warning"], "a new Build-panel run replaces the previous run's problems");

  emitOutput({ runId: "app-run", task: "run", workspacePath: WS, stream: "stderr", text: "D.cpp(5): error C2065: runtime noise\n" });
  assert.deepEqual(rows(), ["warning"], "terminal tasks never touch Problems");
  panel.destroy();
});

test("concurrent Build-panel runs keep their partial lines apart", async () => {
  const panel = await fresh();
  const build = { runId: "par-build", task: "build", workspacePath: WS };
  const lint = { runId: "par-lint", task: PRE_BUILD_TASK_ID, workspacePath: WS };
  emitOutput({ ...build, stream: "stdout", text: "" });
  emitOutput({ ...lint, stream: "stdout", text: "" });
  emitOutput({ ...build, stream: "stdout", text: "Actor.cpp(4): error C2065: " });
  emitOutput({ ...lint, stream: "stdout", text: "Lint.cpp(1): warning L002: tab\n" });
  emitOutput({ ...build, stream: "stdout", text: "undefined\n" });
  const messages = [...problemsView(panel).querySelectorAll(".devmode-build-problem-message")].map((el) => el.textContent);
  assert.deepEqual(messages, ["undefined", "tab"]);
  panel.destroy();
});

test("Build output colors diagnostics by severity across streams and strips ANSI", async () => {
  const panel = await fresh();
  const run = { runId: "colored-build", task: "build", workspacePath: WS };
  emitOutput({ ...run, command: "dotnet build", stream: "stdout", text: "" });
  emitOutput({ ...run, stream: "stderr", text: "\x1b[3" });
  emitOutput({ ...run, stream: "stderr", text: "1mActor.cpp(4): warning C4100: unused\x1b[0m\n" });
  emitOutput({ ...run, stream: "stdout", text: "Actor.cpp(7): error C2065: undefined\n2 Warning(s)\n0 Error(s)\nAll checks passed\n" });

  const output = buildOutputEl(panel);
  const lines = (tone: string) => [...output.querySelectorAll(`[data-build-tone="${tone}"]`)].map(line => line.textContent?.trim());
  assert.deepEqual(lines("warning"), ["Actor.cpp(4): warning C4100: unused", "2 Warning(s)"]);
  assert.deepEqual(lines("error"), ["Actor.cpp(7): error C2065: undefined"]);
  assert.deepEqual(lines("success"), ["All checks passed"]);
  assert.equal(buildChunks(panel, "meta")[0]?.getAttribute("data-build-tone"), null);
  assert.ok([...output.querySelectorAll(".terminal-pane-chunk")].some(line => line.textContent === "0 Error(s)\n" && !line.hasAttribute("data-build-tone")));
  assert.equal(problemsView(panel).querySelectorAll(".devmode-build-problem").length, 2);
  panel.destroy();
});

test("structure: strip tabs, views outside, a pip on both task tabs", async () => {
  const panel = await fresh();
  const handle = panel.root.querySelector(".devmode-panel-resize");
  assert.equal(panel.root.firstElementChild, handle);
  assert.equal(handle?.getAttribute("role"), "separator");
  assert.equal(handle?.getAttribute("aria-orientation"), "horizontal");
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  assert.deepEqual(visibleTabs(panel), ["Terminal", "Build"]);
  for (const view of views(panel)) {
    assert.ok(!strip.contains(view), "view must not live in the tab strip");
    assert.equal(view.parentElement, panel.root);
  }
  assert.deepEqual(
    tabs(panel).map((tab) => tab.querySelector(".devmode-panel-pip") !== null),
    [true, true],
  );
  assert.equal(terminalPip(panel).className, "devmode-panel-pip");
  assert.equal(buildPip(panel).className, "devmode-panel-pip");
  panel.destroy();
});

test("tab switching swaps the visible view and the action buttons", async () => {
  const panel = await fresh();
  panel.revealTerminal();
  const [term, build] = views(panel);
  assert.equal(term.hidden, false);
  assert.equal(build.hidden, true);
  assert.ok(panel.terminalView.cwdEl.closest(".terminal-pane-form"));

  tabNamed(panel, "Build")!.click();
  assert.equal(term.hidden, true);
  assert.equal(build.hidden, false);
  assert.ok(problemsView(panel).parentElement === build, "Problems lives inside the Build view");
  assert.ok(buildOutputEl(panel).parentElement === build, "the build log shares that view");
  const stop = panel.root.querySelector(".devmode-panel-ghost.is-danger") as HTMLElement;
  assert.equal(stop.hidden, true);
  panel.destroy();
});

test("Stop surfaces while a task streams and returns to the strip with the progress row", async () => {
  const panel = await fresh();
  const strip = panel.root.querySelector(".devmode-panel-tabs") as HTMLElement;
  const stop = panel.root.querySelector<HTMLButtonElement>(".devmode-panel-ghost.is-danger")!;
  const progress = panel.root.querySelector<HTMLElement>(".devmode-panel-progress")!;

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

test("panel tabs keep the original outline icons", async () => {
  const panel = await fresh();
  const icons = [...panel.root.querySelectorAll(".devmode-panel-tabs svg")];
  assert.ok(icons.length >= 3);
  const terminalIcon = tabNamed(panel, "Terminal")!.querySelector("svg")!;
  assert.equal(terminalIcon.innerHTML, createLucideIcon(Terminal, { size: 12, strokeWidth: 2 }).innerHTML);
  const buildIcon = tabNamed(panel, "Build")!.querySelector("svg")!;
  assert.equal(buildIcon.innerHTML, createLucideIcon(Hammer, { size: 12, strokeWidth: 2 }).innerHTML);
  for (const svg of icons) {
    assert.equal(svg.getAttribute("fill"), "none");
    assert.equal(svg.getAttribute("stroke"), "currentColor");
    assert.equal(svg.hasAttribute("data-functional-icon"), false);
  }
  panel.destroy();
});

test("hidden views are display:none — the terminal form never leaks (CSS gate)", async () => {
  const { readFile } = await import("node:fs/promises");
  const css = await readFile(new URL("./devmode.css", import.meta.url), "utf8");
  assert.match(css, /\.devmode-panel-term\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.devmode-panel-term\s*\{\s*[^}]*display:\s*flex/);
  // A view that sets its own `display` beats `.devmode-panel-view[hidden]`, so the
  // Build view needs its own hidden rule or it renders on top of every other tab.
  assert.match(css, /\.devmode-panel-view\.devmode-panel-build\s*\{\s*[^}]*display:\s*flex/);
  assert.match(
    css,
    /\.devmode-panel-build\[hidden\]\s*\{\s*display:\s*none/,
    "the Build view must collapse to display:none while another tab is shown",
  );
  assert.match(css, /\.devmode-panel\s*\{\s*[^}]*flex:\s*0 0 var\(--devmode-panel-height/);
  assert.match(css, /\.devmode-panel-resize\s*\{/);
  // The Debug view owns a 4-column grid, so it must stretch to the panel height:
  // a content-sized view left the columns short and the column dividers half height.
  assert.match(
    css,
    /\.devmode-panel-view\.devmode-panel-debug\s*\{[^}]*display:\s*flex[^}]*flex-direction:\s*column/,
    "the Debug view is a flex column so .devmode-debug can fill the panel",
  );
  assert.match(css, /\.devmode-panel-view\.devmode-panel-debug\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /\.devmode-debug-body\s*\{[^}]*min-height:\s*0/);
  // Build output is chunk spans in a plain div, so it needs pre-wrap to keep newlines
  // (the Terminal pane gets that from its <pre>).
  assert.match(
    css,
    /\.devmode-panel-build-output\s*\{[^}]*white-space:\s*pre-wrap/,
    "the build log must preserve the newlines carried by its chunks",
  );

  const panel = await fresh();
  panel.revealTerminal();
  const term = views(panel)[0] as HTMLElement;
  assert.equal(term.hidden, false);
  assert.equal(term.contains(panel.terminalView.input), true);
  panel.destroy();
});

test("the Debug view gets its own full-height class", async () => {
  const panel = await fresh();
  const debugRoot = document.createElement("div");
  panel.installDebugView(debugRoot);
  const view = debugRoot.parentElement as HTMLElement;
  assert.ok(view.classList.contains("devmode-panel-view"));
  assert.ok(
    view.classList.contains("devmode-panel-debug"),
    "the Debug view must not inherit the padded, content-sized panel view",
  );
  panel.destroy();
});

test("the References view gets its own unpadded class", async () => {
  const { FindUsagesView } = await import("./FindUsagesView.js");
  const panel = await fresh();
  const view = new FindUsagesView();
  panel.installReferencesView(view.root);
  const host = view.root.parentElement as HTMLElement;
  assert.ok(host.classList.contains("devmode-panel-view"));
  assert.ok(
    host.classList.contains("devmode-panel-references"),
    "the References view must not inherit the padded panel-view box",
  );
  panel.destroy();
});

test("the Debug Console view gets its own unpadded class", async () => {
  const panel = await fresh();
  const root = document.createElement("div");
  panel.installDebugConsoleView(root);
  const host = root.parentElement as HTMLElement;
  assert.ok(host.classList.contains("devmode-panel-view"));
  assert.ok(
    host.classList.contains("devmode-panel-debug-console"),
    "the Debug Console view must not inherit the padded panel-view box",
  );
  panel.destroy();
});

test("revealForTask adopts an active run from main (stale panel self-heal)", async () => {
  const panel = await fresh();
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
        buffer: "[1/4] Compile Module1.cpp\nSource/Main.cpp(42,7): error C2065: missing name\n",
      },
    ],
    last: {},
  };
  panel.revealForTask("build");
  await tick();
  assert.match(buildPip(panel).className, /is-running/);
  assert.match(buildText(panel), /\$ ubt MyGame/);
  assert.match(buildText(panel), /Compile Module1\.cpp/);
  assert.equal(terminalText(panel), "", "a build never writes into the shell log");
  assert.equal(
    panel.root.querySelectorAll(".devmode-build-problem").length,
    1,
    "an adopted running build repopulates Problems from its buffer",
  );
  emitOutput({ runId: "r-heal", task: "build", workspacePath: WS, stream: "stdout", text: "[2/4] Compile Module2.cpp\n" });
  assert.match(buildText(panel), /Compile Module2\.cpp/);
  assert.equal(
    buildText(panel).split("Compile Module1.cpp").length - 1,
    1,
    "the adopted buffer is printed once",
  );
  panel.destroy();
});

test("fresh run: pip spins, Build autoswitches, exit ok lands the footer", async () => {
  const panel = await fresh();
  emitOutput({ runId: "r1", task: "build", workspacePath: WS, stream: "stdout", text: "building...\n" });
  assert.ok(panel.isOpen());
  assert.equal((views(panel)[1] as HTMLElement).hidden, false, "the Build tab is shown");
  assert.match(buildText(panel), /building\.\.\./);
  assert.match(buildPip(panel).className, /is-running/);

  emitExit({
    runId: "r1", task: "build", workspacePath: WS, command: "dotnet build",
    status: "done", exitCode: 0, startedAt: Date.now() - 1000, durationMs: 1000,
    buffer: "building...\n",
  });
  assert.match(buildPip(panel).className, /is-ok/);
  assert.match(buildText(panel), /— exit 0 · 1\.0s/);
  assert.match(buildOutputEl(panel).querySelector('[data-build-tone="success"]')?.textContent ?? "", /— exit 0/);
  assert.equal(buildOutputEl(panel).querySelectorAll(".terminal-pane-divider").length, 1);
  panel.destroy();
});

test("terminal typing guard: no Terminal autoswitch while the prompt is focused", async () => {
  const panel = await fresh();
  tabNamed(panel, "Build")!.click();
  const input = panel.terminalView.input;
  input.dispatchEvent(new window.Event("focus"));
  emitOutput({ runId: "r2", task: "run", workspacePath: WS, stream: "stdout", text: "starting\n" });
  assert.equal((views(panel)[1] as HTMLElement).hidden, false, "Build stays visible");
  assert.match(terminalPip(panel).className, /is-running/);

  input.dispatchEvent(new window.Event("blur"));
  panel.revealForTask("run");
  assert.equal((views(panel)[0] as HTMLElement).hidden, false);
  panel.destroy();
});

test("failure exit → red pip, stderr line and stop routing", async () => {
  const panel = await fresh();
  emitOutput({ runId: "r3", task: "build", workspacePath: WS, stream: "stderr", text: "boom\n" });
  emitExit({
    runId: "r3", task: "build", workspacePath: WS, command: "dotnet build",
    status: "failed", exitCode: 1, startedAt: Date.now() - 500, durationMs: 500,
    buffer: "boom\n",
  });
  assert.match(buildPip(panel).className, /is-failed/);
  assert.match(buildText(panel), /— exit 1 · 0\.5s/);
  assert.ok(buildChunks(panel, "stderr").some((el) => el.textContent === "boom\n"));
  assert.ok(buildChunks(panel, "stderr").some((el) => /— exit 1/.test(el.textContent ?? "")));
  panel.destroy();
});

test("closing keeps the toolbar; re-opening keeps the same terminal nodes", async () => {
  const panel = await fresh();
  panel.revealTerminal();
  emitOutput({ runId: "retained", task: "run", workspacePath: WS, stream: "stdout", text: "original log\n" });
  const line = panel.terminalView.outputEl.firstElementChild;
  panel.terminalView.input.value = "unfinished command";
  panel.hide();
  assert.ok(!panel.isOpen());
  assert.ok(panel.root.classList.contains("is-collapsed"));
  const expand = panel.root.querySelector<HTMLButtonElement>("button[aria-label='Expand panel']")!;
  expand.click();
  assert.ok(panel.isOpen());
  assert.equal((views(panel)[0] as HTMLElement).hidden, false);
  assert.equal(panel.terminalView.outputEl.firstElementChild, line, "no node is recreated");
  assert.equal(panel.terminalView.input.value, "unfinished command");
  panel.destroy();
});

test("presented state follows panel content expansion", async () => {
  let presented = -1;
  const panel = await fresh();
  panel.onPresentedChange = (p) => {
    presented = p ? 1 : 0;
  };
  panel.revealForTask("build");
  assert.equal(presented, 1);
  panel.hide();
  assert.equal(presented, 0);
  panel.destroy();
});

test("collapse keeps the toolbar and reports content presentation", async () => {
  const panel = await fresh();
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
  const handle = panel.root.querySelector(".devmode-panel-resize") as HTMLElement;
  assert.equal(handle.hidden, true, "resize handle hides while collapsed");
  collapseBtn.click();
  assert.deepEqual(flips.slice(-1), [true], "expand → presented again");
  assert.equal(handle.hidden, false);
  panel.destroy();
});

test("top-edge keyboard and double-click resize the panel", async () => {
  const panel = await fresh();
  panel.revealTerminal();
  const handle = panel.root.querySelector(".devmode-panel-resize") as HTMLElement;
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
  assert.equal(panel.root.style.getPropertyValue("--devmode-panel-height"), "248px");
  fire(handle, "keydown", { key: "ArrowDown", shiftKey: true });
  assert.equal(panel.root.style.getPropertyValue("--devmode-panel-height"), "200px");
  fire(handle, "dblclick", {});
  assert.equal(panel.root.style.getPropertyValue("--devmode-panel-height"), "232px");
  fire(handle, "pointerdown", { button: 0, clientY: 400, pointerId: 1 });
  fire(window, "pointermove", { clientY: 340, pointerId: 1 });
  fire(window, "pointerup", { clientY: 340, pointerId: 1 });
  assert.equal(panel.root.style.getPropertyValue("--devmode-panel-height"), "292px");
  panel.destroy();
});

test("replay: a running task re-opens the panel on Dev Mode entry", async () => {
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
  panel.mount(document.createElement("div"));
  panel.setWorkspace(WS);
  await tick();
  assert.ok(panel.isOpen());
  assert.equal((views(panel)[1] as HTMLElement).hidden, false, "a running build opens on its own tab");
  assert.match(buildText(panel), /\$ dotnet build/);
  assert.match(buildText(panel), /listening/);
  panel.destroy();
});

test("UBT-style CR progress rewrites the current build line", async () => {
  const panel = await fresh();
  emitOutput({
    runId: "r-ubt",
    task: "build",
    workspacePath: WS,
    stream: "stdout",
    text: "[1169/6169] Compile [x64] DataProcessor.cpp\r[2400/6169] Compile [x64] TextureEditor.cpp",
  });
  const lines = buildChunks(panel, "stdout").map((el) => el.textContent);
  assert.deepEqual(lines, ["[2400/6169] Compile [x64] TextureEditor.cpp"]);
  emitOutput({
    runId: "r-ubt", task: "build", workspacePath: WS, stream: "stdout", text: "\r[2401/6169] Compile [x64] Done.cpp\n",
  });
  assert.deepEqual(
    buildChunks(panel, "stdout").map((el) => el.textContent),
    ["[2401/6169] Compile [x64] Done.cpp\n"],
  );
  panel.destroy();
});

test("build diagnostics land in the Build panel, navigate and clear", async () => {
  const panel = await fresh();
  const rows = (): HTMLElement[] => [...panel.root.querySelectorAll<HTMLElement>(".devmode-build-problem")];
  const count = (severity: string): string | undefined =>
    panel.root.querySelector(`.devmode-build-problems-count.is-${severity}`)?.textContent ?? undefined;

  emitOutput({ runId: "diag", task: "build", workspacePath: WS, stream: "stderr", text: "Main.cpp(42,7): error C2065: missing name\n" });
  emitOutput({ runId: "diag", task: "build", workspacePath: WS, stream: "stdout", text: "Actor.cpp(8,3): warning C4100: unused\n" });
  assert.equal(count("error"), "1");
  assert.equal(count("warning"), "1");
  assert.equal(rows().length, 2);
  assert.equal(problemsView(panel).contains(rows()[0]!), true);

  let opened: unknown;
  panel.onOpenBuildDiagnostic = (item, root) => {
    opened = [item.path, item.line, item.column, root];
  };
  rows()[0]!.click();
  assert.deepEqual(opened, ["Main.cpp", 42, 7, WS]);
  assert.equal(panel.root.querySelector('[aria-current="location"]'), rows()[0]);

  emitExit({
    runId: "diag", task: "build", workspacePath: WS, command: "UBT",
    status: "failed", exitCode: 1, startedAt: 1, durationMs: 1, buffer: "",
  });
  (panel.root.querySelector(".devmode-build-problems-clear") as HTMLButtonElement).click();
  assert.equal(rows().length, 0);
  assert.equal(buildText(panel), "", "one Clear empties the Build panel it belongs to");
  panel.destroy();
});

test("switching workspaces drops run state and problems but keeps the console history", async () => {
  const panel = await fresh();
  emitOutput({ runId: "ws-run", task: "run", workspacePath: WS, stream: "stderr", text: "shell line\n" });
  emitOutput({ runId: "ws-build", task: "build", workspacePath: WS, stream: "stderr", text: "Main.cpp(4): error C2065: nope\n" });
  assert.match(terminalPip(panel).className, /is-running/);
  assert.match(buildPip(panel).className, /is-running/);
  assert.equal(panel.root.querySelectorAll(".devmode-build-problem").length, 1);

  panel.setWorkspace("/other-project");
  await tick();
  assert.equal(terminalPip(panel).className, "devmode-panel-pip");
  assert.equal(buildPip(panel).className, "devmode-panel-pip");
  assert.equal(panel.root.querySelectorAll(".devmode-build-problem").length, 0);
  assert.equal(buildText(panel), "", "the build log belongs to one project");
  assert.match(terminalText(panel), /shell line/, "a console keeps its scrollback");

  emitOutput({ runId: "ws-run", task: "run", workspacePath: WS, stream: "stdout", text: "old workspace chunk\n" });
  assert.doesNotMatch(terminalText(panel), /old workspace chunk/);
  panel.destroy();
});

test("hides Debug tabs until the workspace supports debugging", async () => {
  const panel = await fresh();
  panel.installDebugView(document.createElement("div"));
  panel.installDebugConsoleView(document.createElement("div"));
  assert.equal(tabNamed(panel, "Debug")?.hidden, true);
  assert.equal(tabNamed(panel, "Debug Console")?.hidden, true);
  panel.setDebugAvailable(true);
  assert.equal(tabNamed(panel, "Debug")?.hidden, false);
  panel.revealDebug();
  panel.setDebugAvailable(false);
  assert.equal(tabNamed(panel, "Debug")?.hidden, true);
  assert.equal(
    tabs(panel).find((t) => t.getAttribute("aria-selected") === "true")?.textContent,
    "Terminal",
  );
  panel.destroy();
});

test("Debug tab tooltips follow the workspace recipe", async () => {
  const panel = await fresh();
  panel.installDebugView(document.createElement("div"));
  panel.installDebugConsoleView(document.createElement("div"));
  panel.setDebugAvailable(true, "electron");
  assert.equal(tabNamed(panel, "Debug")?.title, "Electron Debug");
  assert.equal(tabNamed(panel, "Debug Console")?.title, "Inspector output");
  panel.setDebugAvailable(true, "unreal");
  assert.equal(tabNamed(panel, "Debug Console")?.title, "Debugger output");
  assert.equal(tabNamed(panel, "Debug")?.title, "C++ Debug");
  panel.setDebugAvailable(true, "web");
  assert.equal(tabNamed(panel, "Debug")?.title, "Web Debug");
  panel.destroy();
});

test("References installs as a strip tab and reveals on demand", async () => {
  const { FindUsagesView } = await import("./FindUsagesView.js");
  const panel = await fresh();
  const view = new FindUsagesView();
  view.renderResults("TryAddItem", [
    { path: "/ws/a.cpp", line: 3, column: 7, lineText: "TryAddItem();", kind: "call" },
  ]);
  panel.installReferencesView(view.root);
  panel.revealReferences();

  const referencesTab = tabNamed(panel, "References");
  assert.ok(referencesTab?.classList.contains("is-on"));
  assert.equal(view.root.parentElement?.hidden, false);
  assert.ok(view.root.querySelector(".devmode-references-clear"));
  assert.equal(panel.root.querySelector(".devmode-panel-tabs .devmode-references-clear"), null);
  panel.destroy();
});

test("every tool is a strip tab and switching never remounts a view", async () => {
  const panel = await fresh();
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
    [...strip.querySelectorAll(".devmode-panel-tab")].map((tab) => tab.textContent),
    ["Terminal", "Build", "Debug", "Debug Console", "References"],
  );
  assert.equal(panel.root.querySelector(".devmode-panel-more"), null);
  assert.equal(panel.root.querySelector(".devmode-panel-more-menu"), null);

  const consoleTab = tabNamed(panel, "Debug Console")!;
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

test("Deploy streams into the Terminal and Stop targets the live run", async () => {
  const panel = await fresh();
  bridge.tasks.push({ id: "deploy", command: "npm run deploy" });
  panel.setWorkspace(WS);
  await tick();
  panel.setDeployAvailable(true);
  await tick();
  panel.revealForTask("deploy");
  emitOutput({ runId: "deploy1", task: "deploy", workspacePath: WS, stream: "stdout", text: "uploading...\n" });
  assert.match(terminalText(panel), /uploading/);
  assert.deepEqual(visibleTabs(panel), ["Terminal", "Build"], "Deploy never adds a tab");
  assert.match(terminalPip(panel).className, /is-running/);

  const stop = panel.root.querySelector(".devmode-panel-ghost.is-danger") as HTMLButtonElement;
  assert.equal(stop.hidden, false);
  stop.click();
  await tick();
  assert.deepEqual(bridge.stopped, ["deploy1"]);

  emitExit({ runId: "deploy1", task: "deploy", workspacePath: WS, command: "npm run deploy", status: "failed", exitCode: 1, startedAt: Date.now() - 1000, durationMs: 1000, buffer: "uploading...\n" });
  assert.match(terminalPip(panel).className, /is-failed/);
  assert.match(terminalText(panel), /exit 1/);
  panel.destroy();
});

test("generate task streams into the Build panel like any other precompile step", async () => {
  const panel = await fresh();
  bridge.tasks.push({ id: "generate", command: "ubt -ProjectFiles" });
  panel.setWorkspace(WS);
  await tick();
  panel.revealForTask("generate");
  emitOutput({ runId: "gen1", task: "generate", workspacePath: WS, stream: "stdout", text: "Setting up Unreal Engine project files...\n" });
  assert.match(buildText(panel), /Setting up Unreal Engine project files/);
  assert.match(buildText(panel), /\$ ubt -ProjectFiles/);
  assert.equal(terminalText(panel), "", "generate never touches the shell log");
  assert.equal(tabNamed(panel, "Generate"), undefined);
  emitExit({ runId: "gen1", task: "generate", workspacePath: WS, command: "ubt -ProjectFiles", status: "done", exitCode: 0, startedAt: Date.now() - 1000, durationMs: 1000, buffer: "" });
  assert.match(buildText(panel), /— exit 0/);
  panel.destroy();
});
