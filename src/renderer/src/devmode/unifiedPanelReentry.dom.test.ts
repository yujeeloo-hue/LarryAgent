import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLDivElement: dom.window.HTMLDivElement,
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

  main.active = [];
  panel.setWorkspace(OTHER);
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(buildView(panel).textContent, "", "build log cleared on other workspace");
  assert.equal(buildPip(panel).className.includes("is-running"), false);

  snap.buffer += "[3/100] Compile C.cpp\n[4/100] Compile D.cpp\n";

  main.active = [snap];
  panel.setWorkspace(NF);
  await new Promise((r) => setTimeout(r, 5));

  const view = buildView(panel);
  assert.match(view.textContent ?? "", /Compile D\.cpp/, "full buffer (incl. while-away lines) restored");
  assert.equal(buildPip(panel).className.includes("is-running"), true, "pip running");
  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find((t) => t.textContent === "Build")!;
  assert.match(buildTab.title, /Build\.bat NFEditor/, "tab title carries command");
  assert.match(buildTab.title, /running/, "tab title carries running state");

  for (const h of main.outputHandlers) {
    h({ runId: "run-1", task: "build", workspacePath: NF, stream: "stdout", text: "[5/100] Compile E.cpp\n" });
  }
  assert.match(view.textContent ?? "", /Compile E\.cpp/, "live stream re-attached");

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

  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find(
    (t) => t.textContent === "Build",
  )!;
  buildTab.click();
  await new Promise((r) => setTimeout(r, 5));

  const view = buildView(panel);
  assert.match(view.textContent ?? "", /Compile X\.cpp/, "stale tab re-attached the live log");
  assert.equal(buildPip(panel).className.includes("is-running"), true, "pip running again");
  assert.match(buildTab.title, /running/, "title carries running state");

  for (const h of main.outputHandlers) {
    h({ runId: "run-2", task: "build", workspacePath: NF, stream: "stdout", text: "[11/100] Compile Y.cpp\n" });
  }
  assert.match(view.textContent ?? "", /Compile Y\.cpp/, "live stream re-attached");
  panel.destroy();
});

function buildView(panel: UnifiedPanelController): HTMLElement {
  return panel.root.querySelector(".devmode-panel-build-output") as HTMLElement;
}
function buildPip(panel: UnifiedPanelController): HTMLElement {
  const buildTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find((t) => t.textContent === "Build")!;
  return buildTab.querySelector(".devmode-panel-pip") as HTMLElement;
}

test("live Build diagnostics stream independently, navigate, flush on exit and clear with output", async () => {
  main.active = []; main.last = {};
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div")); panel.setWorkspace(NF);
  await new Promise(resolve => setTimeout(resolve, 0));
  const output = (text: string, stream: "stdout" | "stderr" = "stdout") => {
    for (const handler of main.outputHandlers) handler({ runId: "diagnostics", task: "build", workspacePath: NF, stream, text });
  };
  const rows = () => [...panel.root.querySelectorAll<HTMLElement>(".devmode-build-problem")];
  const count = (severity: string) => panel.root.querySelector(`.devmode-build-problems-count.is-${severity}`)?.textContent;
  try {
    output("C:\\Game\\Source\\Actor.cpp(142,");
    output("Actor.cpp(208): warning C4189: unused variable\n", "stderr");
    assert.equal(count("warning"), "1"); assert.equal(count("error"), "0");
    output("9): error C2065: missing name\n");
    assert.equal(count("error"), "1");
    let opened: unknown;
    panel.onOpenBuildDiagnostic = (item, root) => { opened = [item.path, item.line, item.column, root]; };
    rows()[0]!.click();
    assert.deepEqual(opened, ["C:/Game/Source/Actor.cpp", 142, 9, NF]);
    const selected = rows()[0];
    output("Actor.cpp(208): warning C4189: unused variable\n", "stderr");
    assert.equal(count("warning"), "1", "duplicate summary lines do not inflate counts");
    assert.equal(panel.root.querySelector('[aria-current="location"]'), selected);
    const frame = { runId: "diagnostics", task: "build", workspacePath: NF, elapsedMs: 1000, phase: "analyzing", totalActions: null, doneActions: null, etaMs: null, currentAction: null, actionsPerSecond: null };
    for (const handler of main.progressHandlers) handler(frame);
    const progress = panel.root.querySelector<HTMLElement>(".devmode-panel-progress")!;
    const bar = progress.querySelector<HTMLElement>(".devmode-panel-progress-bar")!;
    assert(progress.classList.contains("is-indeterminate")); assert(!bar.hasAttribute("aria-valuenow"));
    for (const handler of main.progressHandlers) handler({ ...frame, phase: "compiling", totalActions: 100, doneActions: 60 });
    assert(!progress.classList.contains("is-indeterminate")); assert.equal(bar.getAttribute("aria-valuenow"), "60");
    output("Actor.cpp(209): warning C4100: unused parameter");
    for (const handler of main.exitHandlers) handler({ runId: "diagnostics", task: "build", workspacePath: NF, command: "UBT", status: "failed", exitCode: 1, startedAt: 1, durationMs: 1, buffer: "" });
    assert.equal(count("warning"), "2", "last unterminated diagnostic is retained");
    assert.equal(progress.hidden, true); assert.equal(rows().length, 3);
    (panel.root.querySelector(".devmode-build-problems-clear") as HTMLButtonElement).click();
    assert.equal(rows().length, 0); assert.equal(count("error"), "0"); assert.equal(buildView(panel).textContent, "");
  } finally { panel.destroy(); }
});

test("finished diagnostics restore from replay and never leak to another project or build", async () => {
  const snap: Snapshot = { runId: "retained", task: "build", workspacePath: NF, command: "UBT", status: "failed", exitCode: 1, startedAt: 1, durationMs: 1, buffer: "Source/Main.cpp(42,2): error C2065: missing name\nSource/Main.cpp(45): warning C4100: unused parameter" };
  main.active = []; main.last = { build: snap };
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div")); panel.setWorkspace(NF);
  const rows = () => panel.root.querySelectorAll(".devmode-build-problem").length;
  try {
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(rows(), 2);
    main.last = {}; panel.setWorkspace(OTHER);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(rows(), 0);
    main.last = { build: snap }; panel.setWorkspace(NF);
    await new Promise(resolve => setTimeout(resolve, 0)); assert.equal(rows(), 2);
    for (const handler of main.outputHandlers) handler({ runId: "next-build", task: "build", workspacePath: NF, stream: "stdout", text: "Analyzing targets…\n" });
    assert.equal(rows(), 0, "a new build clears the previous run's diagnostics");
    assert.match(buildView(panel).textContent!, /Analyzing targets/);
  } finally { panel.destroy(); main.last = {}; }
});
