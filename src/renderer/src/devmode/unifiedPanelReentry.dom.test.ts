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
    getDevTaskConfig: async () => ({ ok: true, tasks: [{ id: "build", command: "Build.bat NFEditor Win64 Development" }] }),
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
const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  ({ UnifiedPanelController } = await import("./UnifiedPanelController.js"));
});

function terminalText(panel: InstanceType<UnifiedPanelControllerT>): string {
  return panel.terminalView.outputEl.textContent ?? "";
}

function buildText(panel: InstanceType<UnifiedPanelControllerT>): string {
  return panel.root.querySelector(".devmode-panel-build-output")?.textContent ?? "";
}

function tabPip(
  panel: InstanceType<UnifiedPanelControllerT>,
  label: string,
): HTMLElement {
  const tab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find(
    (t) => t.textContent?.includes(label),
  )!;
  return tab.querySelector(".devmode-panel-pip") as HTMLElement;
}

function terminalPip(panel: InstanceType<UnifiedPanelControllerT>): HTMLElement {
  return tabPip(panel, "Terminal");
}

function buildPip(panel: InstanceType<UnifiedPanelControllerT>): HTMLElement {
  return tabPip(panel, "Build");
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function output(p: OutputPayload): void {
  for (const h of main.outputHandlers) h(p);
}

function exit(s: Snapshot): void {
  for (const h of main.exitHandlers) h(s);
}

test("NF build survives leave + return: missing lines only, one head, live stream re-attached", async () => {
  main.active = [];
  main.last = {};
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  await tick();

  const snap: Snapshot = {
    runId: "run-1",
    task: "build",
    workspacePath: NF,
    command: "Build.bat NFEditor Win64 Development",
    status: "running",
    exitCode: null,
    startedAt: Date.now() - 5000,
    durationMs: null,
    buffer: "",
  };
  const first = "[1/100] Compile A.cpp\n[2/100] Compile B.cpp\n";
  snap.buffer = first;
  main.active = [snap];
  panel.revealForTask("build");
  output({ runId: "run-1", task: "build", workspacePath: NF, stream: "stdout", text: first });
  assert.match(buildText(panel), /Compile B\.cpp/, "live log visible before leaving");
  assert.equal(occurrences(buildText(panel), "$ Build.bat NFEditor Win64 Development"), 1);

  main.active = [];
  panel.setWorkspace(OTHER);
  await tick();
  assert.equal(buildPip(panel).className, "devmode-panel-pip", "run state dropped for another workspace");
  assert.equal(terminalPip(panel).className, "devmode-panel-pip");

  snap.buffer = `${first}[3/100] Compile C.cpp\n[4/100] Compile D.cpp\n`;
  main.active = [snap];
  panel.setWorkspace(NF);
  await tick();

  const restored = buildText(panel);
  assert.match(restored, /Compile D\.cpp/, "lines produced while away are replayed");
  assert.equal(occurrences(restored, "Compile B.cpp"), 1, "already printed lines are not duplicated");
  assert.equal(
    occurrences(restored, "$ Build.bat NFEditor Win64 Development"),
    1,
    "the head is printed once per run",
  );
  assert.equal(buildPip(panel).className.includes("is-running"), true);

  output({ runId: "run-1", task: "build", workspacePath: NF, stream: "stdout", text: "[5/100] Compile E.cpp\n" });
  assert.match(buildText(panel), /Compile E\.cpp/, "live stream re-attached");

  snap.status = "done";
  snap.exitCode = 0;
  snap.durationMs = 12000;
  main.active = [];
  main.last = { build: snap };
  exit({ ...snap, workspacePath: NF });
  assert.match(buildText(panel), /— exit 0/);
  assert.equal(buildPip(panel).className.includes("is-ok"), true);
  panel.destroy();
});

test("re-opening the panel heals a stale view without duplicating the run", async () => {
  main.active = [];
  main.last = {};
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  await tick();

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

  panel.revealForTask("build");
  await tick();
  assert.match(buildText(panel), /Compile X\.cpp/);
  assert.equal(buildPip(panel).className.includes("is-running"), true);

  const terminalTab = [...panel.root.querySelectorAll(".devmode-panel-tab")].find(
    (t) => t.textContent === "Terminal",
  ) as HTMLElement;
  terminalTab.click();
  panel.revealForTask("build");
  await tick();
  assert.equal(occurrences(buildText(panel), "Compile X.cpp"), 1, "heal never reprints");
  panel.destroy();
});

test("live Build diagnostics stream independently, navigate, flush on exit and clear with the list", async () => {
  main.active = [];
  main.last = {};
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  await tick();
  const rows = () => [...panel.root.querySelectorAll<HTMLElement>(".devmode-build-problem")];
  const count = (severity: string) =>
    panel.root.querySelector(`.devmode-build-problems-count.is-${severity}`)?.textContent;
  const local = (text: string, stream: "stdout" | "stderr" = "stdout") =>
    output({ runId: "diagnostics", task: "build", workspacePath: NF, stream, text });
  try {
    local("C:\\Game\\Source\\Actor.cpp(142,");
    local("Actor.cpp(208): warning C4189: unused variable\n", "stderr");
    assert.equal(count("warning"), "1");
    assert.equal(count("error"), "0");
    local("9): error C2065: missing name\n");
    assert.equal(count("error"), "1");
    let opened: unknown;
    panel.onOpenBuildDiagnostic = (item, root) => {
      opened = [item.path, item.line, item.column, root];
    };
    rows()[0]!.click();
    assert.deepEqual(opened, ["C:/Game/Source/Actor.cpp", 142, 9, NF]);
    const selected = rows()[0];
    local("Actor.cpp(208): warning C4189: unused variable\n", "stderr");
    assert.equal(count("warning"), "1", "duplicate summary lines do not inflate counts");
    assert.equal(panel.root.querySelector('[aria-current="location"]'), selected);

    const frame = { runId: "diagnostics", task: "build", workspacePath: NF, elapsedMs: 1000, phase: "analyzing", totalActions: null, doneActions: null, etaMs: null, currentAction: null, actionsPerSecond: null };
    for (const handler of main.progressHandlers) handler(frame);
    const progress = panel.root.querySelector<HTMLElement>(".devmode-panel-progress")!;
    const bar = progress.querySelector<HTMLElement>(".devmode-panel-progress-bar")!;
    assert(progress.classList.contains("is-indeterminate"));
    assert(!bar.hasAttribute("aria-valuenow"));
    for (const handler of main.progressHandlers) handler({ ...frame, phase: "compiling", totalActions: 100, doneActions: 60 });
    assert(!progress.classList.contains("is-indeterminate"));
    assert.equal(bar.getAttribute("aria-valuenow"), "60");

    local("Actor.cpp(209): warning C4100: unused parameter");
    exit({ runId: "diagnostics", task: "build", workspacePath: NF, command: "UBT", status: "failed", exitCode: 1, startedAt: 1, durationMs: 1, buffer: "" });
    assert.equal(count("warning"), "2", "last unterminated diagnostic is retained");
    assert.equal(progress.hidden, true);
    assert.equal(rows().length, 3);
    (panel.root.querySelector(".devmode-build-problems-clear") as HTMLButtonElement).click();
    assert.equal(rows().length, 0);
    assert.equal(count("error"), "0");
    assert.equal(buildText(panel), "", "one Clear empties the Build panel it belongs to");
  } finally {
    panel.destroy();
  }
});

test("finished diagnostics restore from replay and never leak to another project or build", async () => {
  const snap: Snapshot = {
    runId: "retained",
    task: "build",
    workspacePath: NF,
    command: "UBT",
    status: "failed",
    exitCode: 1,
    startedAt: 1,
    durationMs: 1,
    buffer: "Source/Main.cpp(42,2): error C2065: missing name\nSource/Main.cpp(45): warning C4100: unused parameter",
  };
  main.active = [];
  main.last = { build: snap };
  const panel = new UnifiedPanelController();
  panel.mount(document.createElement("div"));
  panel.setWorkspace(NF);
  const rows = () => panel.root.querySelectorAll(".devmode-build-problem").length;
  try {
    await tick();
    assert.equal(rows(), 2);
    assert.equal(buildText(panel), "", "a finished run is not replayed into the log");
    main.last = {};
    panel.setWorkspace(OTHER);
    await tick();
    assert.equal(rows(), 0);
    main.last = { build: snap };
    panel.setWorkspace(NF);
    await tick();
    assert.equal(rows(), 2);
    output({ runId: "next-build", task: "build", workspacePath: NF, stream: "stdout", text: "Analyzing targets…\n" });
    assert.equal(rows(), 0, "a new build clears the previous run's diagnostics");
    assert.match(buildText(panel), /Analyzing targets/);
  } finally {
    panel.destroy();
    main.last = {};
  }
});
