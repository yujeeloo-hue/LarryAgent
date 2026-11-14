/**
 * Scratch DOM repro: NF build running → leave workspace → return.
 * Verifies the panel restores log lines / pip / tab title from replay.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

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
  progress?: unknown;
};

// Mutable main-side simulation.
const main = {
  outputHandlers: [] as Array<(p: OutputPayload) => void>,
  exitHandlers: [] as Array<(s: Snapshot) => void>,
  progressHandlers: [] as Array<(p: unknown) => void>,
  active: [] as Snapshot[],
  last: {} as Record<string, Snapshot>,
};

(Object.assign(window, {
  jellybot: {
    getDevTaskState: async () => ({ ok: true, active: main.active, last: main.last }),
    stopDevTask: async () => ({ ok: true }),
    onDevTaskOutput: (h: (p: OutputPayload) => void) => {
      main.outputHandlers.push(h);
      return () => {
        main.outputHandlers = main.outputHandlers.filter((x) => x !== h);
      };
    },
    onDevTaskExit: (h: (s: Snapshot) => void) => {
      main.exitHandlers.push(h);
      return () => {
        main.exitHandlers = main.exitHandlers.filter((x) => x !== h);
      };
    },
    onDevTaskProgress: (h: (p: unknown) => void) => {
      main.progressHandlers.push(h);
      return () => {
        main.progressHandlers = main.progressHandlers.filter((x) => x !== h);
      };
    },
  },
}));

type UnifiedPanelControllerT = typeof import("./UnifiedPanelController.js")["UnifiedPanelController"];
let UnifiedPanelController: UnifiedPanelControllerT;

const NF = "E:/Projects/NF";
const OTHER = "E:/Other";

test.before(async () => {
  ({ UnifiedPanelController } = await import("./UnifiedPanelController.js"));
});

test("NF build survives leave + return (log, pip, title restore)", async () => {
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  await new Promise((r) => setTimeout(r, 5));

  // User clicks Build → main runs it; live output streams.
  const snap: Snapshot = {
    runId: "run-1",
    task: "build",
    workspacePath: NF,
    command: "Build.bat NFEditor Win64 Development",
    status: "running",
    exitCode: null,
    startedAt: Date.now() - 5000,
    durationMs: null,
    buffer: "[1/100] Compile A.cpp\n[2/100] Compile B.cpp\n",
  };
  main.active = [snap];
  for (const h of main.outputHandlers) {
    h({ runId: "run-1", task: "build", workspacePath: NF, stream: "stdout", text: "[1/100] Compile A.cpp\n[2/100] Compile B.cpp\n" });
  }
  panel.revealForTask("build");
  assert.match(buildView(panel).textContent ?? "", /Compile B\.cpp/, "live log visible before leaving");

  // Leave NF → other workspace (no runs there).
  main.active = [];
  panel.setWorkspace(OTHER);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(buildView(panel).textContent, "", "build log cleared on other workspace");
  assert.equal(buildPip(panel).className.includes("is-running"), false);

  // While away, the NF build keeps streaming into main's buffer.
  snap.buffer += "[3/100] Compile C.cpp\n[4/100] Compile D.cpp\n";

  // Return to NF.
  main.active = [snap];
  panel.setWorkspace(NF);
  await new Promise((r) => setTimeout(r, 5));

  const view = buildView(panel);
  assert.match(view.textContent ?? "", /Compile D\.cpp/, "full buffer (incl. while-away lines) restored");
  assert.equal(buildPip(panel).className.includes("is-running"), true, "pip running");
  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find((t) => t.textContent === "Build")!;
  assert.match(buildTab.title, /Build\.bat NFEditor/, "tab title carries command");
  assert.match(buildTab.title, /running/, "tab title carries running state");

  // Live output resumes appending after the return.
  for (const h of main.outputHandlers) {
    h({ runId: "run-1", task: "build", workspacePath: NF, stream: "stdout", text: "[5/100] Compile E.cpp\n" });
  }
  assert.match(view.textContent ?? "", /Compile E\.cpp/, "live stream re-attached");

  // Build exits while we are here → exit event applies.
  snap.status = "done";
  snap.exitCode = 0;
  snap.durationMs = 12000;
  main.active = [];
  main.last = { build: snap };
  for (const h of main.exitHandlers) {
    h({ ...snap, workspacePath: NF });
  }
  assert.match(view.textContent ?? "", /exit 0/, "exit footer lands");
  assert.equal(buildPip(panel).className.includes("is-ok"), true);
  panel.destroy();
});

test("Build tab click heals a stale tab (superseded switch left it idle)", async () => {
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  await new Promise((r) => setTimeout(r, 5));

  // Build runs in main, but the panel missed it (superseded workspace
  // switch skipped panel.setWorkspace → build tab idle, no log).
  const snap: Snapshot = {
    runId: "run-2",
    task: "build",
    workspacePath: NF,
    command: "Build.bat NFEditor Win64 Development",
    status: "running",
    exitCode: null,
    startedAt: Date.now() - 1000,
    durationMs: null,
    buffer: "[10/100] Compile X.cpp\n",
  };
  main.active = [snap];
  main.last = {};

  // Clicking the Build tab re-attaches the live run.
  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find(
    (t) => t.textContent === "Build",
  )!;
  buildTab.click();
  await new Promise((r) => setTimeout(r, 5));

  const view = buildView(panel);
  assert.match(view.textContent ?? "", /Compile X\.cpp/, "stale tab re-attached the live log");
  assert.equal(buildPip(panel).className.includes("is-running"), true, "pip running again");
  assert.match(buildTab.title, /running/, "title carries running state");

  // Live output resumes appending.
  for (const h of main.outputHandlers) {
    h({ runId: "run-2", task: "build", workspacePath: NF, stream: "stdout", text: "[11/100] Compile Y.cpp\n" });
  }
  assert.match(view.textContent ?? "", /Compile Y\.cpp/, "live stream re-attached");
  panel.destroy();
});

function buildView(panel: UnifiedPanelController): HTMLElement {
  const views = [...panel.root.querySelectorAll(".devmode-panel-view")];
  return views[0] as HTMLElement;
}
function buildPip(panel: UnifiedPanelController): HTMLElement {
  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find((t) => t.textContent === "Build")!;
  return buildTab.querySelector(".devmode-panel-pip") as HTMLElement;
}
