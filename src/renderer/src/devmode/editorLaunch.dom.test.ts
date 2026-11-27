import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { readFileSync } from "node:fs";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});
Object.assign(dom.window, {
  matchMedia: () => ({ matches: true }),
  CSS: { escape: (value: string) => value },
});
for (const proto of [dom.window.HTMLElement.prototype, dom.window.Element.prototype]) {
  if (typeof proto.scrollIntoView !== "function") {
    proto.scrollIntoView = () => undefined;
  }
}

const origLoad = (
  Module as unknown as {
    _load: (...args: unknown[]) => unknown;
  }
)._load;
(Module as unknown as { _load: (...args: unknown[]) => unknown })._load =
  function patchedLoad(
    this: unknown,
    request: string,
    ...rest: unknown[]
  ): unknown {
    if (request.includes("?worker&inline")) {
      return class WorkerStub {};
    }
    if (request === "monaco-editor/languages/definitions/cpp/cpp.js") {
      return { language: { tokenizer: {} } };
    }
    if (request.endsWith(".css")) return {};
    return origLoad.call(this, request, ...rest);
  };

type EditorAreaControllerT = typeof import("./EditorAreaController.js")["EditorAreaController"];
let EditorAreaController: EditorAreaControllerT;
let WorkbenchView: typeof import("./WorkbenchView.js")["WorkbenchView"];

test.before(async () => {
  ({ EditorAreaController } = await import("./EditorAreaController.js"));
  ({ WorkbenchView } = await import("./WorkbenchView.js"));
});

function fresh(): InstanceType<EditorAreaControllerT> {
  return new EditorAreaController();
}

test("returning to an already active local view does not relayout the editor on every tab change", () => {
  const area = fresh();
  let layouts = 0;
  Object.assign(area, { editor: { layout: () => { layouts++; }, dispose() {} } });
  try {
    area.showCollaborativeView(false); area.showCollaborativeView(false);
    assert.equal(layouts, 0);
    area.showCollaborativeView(true); area.showCollaborativeView(false);
    assert.equal(layouts, 1, "a real return from collaborative view still lays out the local editor");
    area.showCollaborativeView(false); assert.equal(layouts, 1);
  } finally { area.destroy(); }
});

test("collaborative dual view hides local minimap and blame until returning to the local editor", () => {
  const area = fresh();
  const minimap = launchButtons(area)[5];
  const blame = launchButtons(area)[7];
  assert.equal(minimap.hidden, false);
  assert.equal(blame.hidden, false);
  area.showCollaborativeView(true);
  assert.equal(minimap.hidden, true, "branch dual view has no local minimap to toggle");
  assert.equal(blame.hidden, true, "branch dual view has no local blame to toggle");
  area.showCollaborativeView(false);
  assert.equal(minimap.hidden, false);
  assert.equal(blame.hidden, false);
  area.destroy();
});

test("bottom bar carries notice + progress only, no path or file-detail controls", () => {
  const area = fresh();
  const status = area.root.querySelector(".devmode-editor-status")!;
  const notice = status.querySelector(".devmode-status-notice");
  const progress = status.querySelector(".devmode-status-index");
  const host = document.createElement("div");
  area.mountStatusBar(host);
  assert.equal(host.firstElementChild, status);
  assert.equal(status.querySelectorAll(".devmode-status-path, .devmode-status-file").length, 0);
  assert.equal(status.querySelector(".devmode-status-notice"), notice);
  assert.equal(status.querySelector(".devmode-status-index"), progress);
  assert.equal(area.root.querySelector(".devmode-editor-status"), null);
  assert.equal(status.querySelector<HTMLButtonElement>(".devmode-index-boost")?.hidden, true);
  assert.ok(status.classList.contains("is-panel-inline"));
  area.destroy();
  assert.equal(host.childElementCount, 0);
});

test("bottom bar keeps notices, never repeats the tab path or save state", async () => {
  (
    EditorAreaController.prototype as unknown as {
      ensureMonaco: () => Promise<void>;
    }
  ).ensureMonaco = () => Promise.resolve();
  const area = fresh();
  const notice = area.root.querySelector<HTMLElement>(".devmode-status-notice")!;
  Object.assign(window, {
    jellybot: {
      readFileForEditor: async () => ({
        ok: true as const,
        content: "int x;",
        encoding: "utf8" as const,
        sizeBytes: 6,
        mtimeMs: 1,
      }),
    },
  });
  await area.openFile("/work/Foo.cpp");
  assert.equal(notice.textContent, "", "a clean tab no longer prints Saved");
  assert.doesNotMatch(
    area.root.querySelector(".devmode-editor-status")?.textContent ?? "",
    /\/work\/Foo\.cpp/,
    "the active path stays on the tab only",
  );

  const tab = (area as unknown as { tabs: Array<Record<string, unknown>> }).tabs[0]!;
  tab.dirty = true;
  (area as unknown as { renderStatus: () => void }).renderStatus();
  assert.equal(notice.textContent, "", "Unsaved changes stays off the bar");

  (
    window.jellybot as unknown as {
      readFileForEditor: () => Promise<unknown>;
    }
  ).readFileForEditor = async () => ({ ok: false, message: "permission denied" });
  await area.openFile("/work/Bar.cpp");
  assert.match(notice.textContent ?? "", /permission denied/, "transient notices survive");
  area.destroy();
});

function launchButtons(
  area: InstanceType<EditorAreaControllerT>,
): HTMLButtonElement[] {
  return [...area.root.querySelectorAll(".devmode-launch-btn")] as HTMLButtonElement[];
}

test("structure: one merged pill, no separate fab row", () => {
  const area = fresh();
  const bar = area.root.querySelector(".devmode-tabs") as HTMLElement;
  assert.ok(bar);
  const launch = bar.querySelector(".devmode-editor-launch") as HTMLElement;
  assert.ok(launch, "launch cluster missing");
  assert.ok(
    !bar.querySelector(".devmode-editor-fabs"),
    "the fab row is gone — everything lives in the pill",
  );
  const btns = launchButtons(area);
  assert.equal(btns.length, 8);
  const names = ["build", "lint", "run", "deploy", "configure", "minimap", "diff", "blame"];
  for (const [index, button] of btns.entries()) {
    const icon = button.querySelector("img")!;
    assert.ok(icon, button.title);
    assert.equal(icon.dataset.devModeIcon, names[index], button.title);
    assert.equal(icon.getAttribute("width"), "14", button.title);
    assert.equal(icon.getAttribute("height"), "14", button.title);
    assert.equal(icon.getAttribute("aria-hidden"), "true", button.title);
    const artwork = decodeURIComponent(icon.src.slice(icon.src.indexOf(",") + 1));
    assert.equal(artwork,
      readFileSync(`src/renderer/src/assets/devmode-launch/${names[index]}.svg`, "utf8").trim(),
      `${button.title}: use the approved color artwork`);
  }
  assert.equal(
    (btns[0] as HTMLElement).getAttribute("aria-label"),
    "Build",
  );
  assert.equal(btns[1].getAttribute("aria-label"), "Lint");
  assert.ok(btns[1].hidden, "Lint hidden until preBuild is configured");
  assert.ok(btns[1].disabled);
  assert.ok(btns[2].title.length > 0, "debug title defaults to a recipe string");
  assert.ok(btns[2].disabled);
  assert.ok(btns[3].hidden, "deploy hidden until configured");
  assert.ok(btns[3].disabled);
  assert.match(btns[4].title, /Configure tasks/);
  assert.match(btns[5].title, /[Mm]inimap/);
  assert.ok(btns[6].disabled, "diff disabled until a model opens");
  assert.ok(btns[7].disabled, "annotate disabled until a tab is active");
  const pill = launch.querySelector(".devmode-launch-pill") as HTMLElement;
  assert.ok(pill, "segmented pill wrapping the task actions");
  assert.equal(
    btns.every((b) => pill.contains(b)),
    true,
    "all launch buttons live inside the pill",
  );
  assert.ok(
    !launch.querySelector(".devmode-launch-sep"),
    "no floating rule — the pill's internal borders separate segments",
  );
});

test("appendFab mounts the chat segment at the pill's right end", () => {
  const area = fresh();
  const chat = new WorkbenchView().chatExpandButton;
  area.appendFab(chat);
  const pill = area.root.querySelector(".devmode-launch-pill") as HTMLElement;
  assert.equal(pill.lastElementChild, chat, "chat segment is the last child");
  assert.equal(chat.querySelector("img")?.dataset.devModeIcon, "chat");
  assert.equal(chat.getAttribute("aria-label"), "Expand chat panel");
  const source = chat.querySelector("img")!.src;
  assert.equal(decodeURIComponent(source.slice(source.indexOf(",") + 1)),
    readFileSync("src/renderer/src/assets/devmode-launch/chat.svg", "utf8").trim());
  assert.ok(
    !chat.classList.contains("is-in"),
    "starts collapsed — DevModeController toggles is-in",
  );
});

test("setDebugRecipe enables the button and titles it", () => {
  const area = fresh();
  const [, , debug] = launchButtons(area);
  area.setDebugRecipe("electron");
  assert.equal(debug.disabled, false);
  assert.match(debug.title, /[Ee]lectron/);
  area.setDebugRecipe(null);
  assert.equal(debug.disabled, true);
});

test("setConfigVisible(false) hides the gear segment, keeps the pair", () => {
  const area = fresh();
  area.setConfigVisible(false);
  const btns = launchButtons(area);
  assert.equal(btns.length, 8);
  assert.ok(btns[4].hidden, "gear hidden");
  area.setConfigVisible(true);
  assert.equal(btns[4].hidden, false);
});

test("setBuildState drives the running and failed button states", () => {
  const area = fresh();
  const [build] = launchButtons(area);
  area.setBuildState(true, false);
  assert.match(build.className, /is-running/);
  area.setBuildState(false, true);
  assert.ok(!/is-running/.test(build.className));
  assert.match(build.className, /is-failed/);
  assert.equal(build.children.length, 1);
});

test("clicks route through the wired callbacks", () => {
  const area = fresh();
  const fired: string[] = [];
  area.onBuildClick = () => fired.push("build");
  area.onLintClick = () => fired.push("lint");
  area.onDebugClick = () => fired.push("debug");
  area.onConfigClick = () => fired.push("config");
  const [build, lint, debug, , config] = launchButtons(area);
  build.click();
  config.click();
  assert.deepEqual(fired, ["build", "config"]);
  area.setDebugRecipe("web");
  debug.click();
  area.setLintAvailable(true);
  assert.equal(lint.hidden, false);
  lint.click();
  assert.deepEqual(fired, ["build", "config", "debug", "lint"]);
  area.setLintState(true, false);
  assert.ok(lint.classList.contains("is-running"));
  assert.ok(!build.classList.contains("is-running"));
  area.setLintState(false, true);
  assert.ok(lint.classList.contains("is-failed"));
  area.setLintAvailable(false);
  assert.ok(lint.disabled);
});

test("setLintAvailable hides the Lint segment instead of greying it out", () => {
  const area = fresh();
  const [, lint] = launchButtons(area);
  assert.ok(lint.hidden, "no preBuild task — the segment stays out of the pill");
  area.setLintAvailable(true);
  assert.equal(lint.hidden, false, "available again — the segment re-appears");
  assert.equal(lint.disabled, false);
  assert.equal(lint.title, "Lint · Run pre-build check");
  area.setLintAvailable(false);
  assert.ok(lint.hidden);
});


async function tick(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise<void>(done => setImmediate(done));
}

function installActiveTab(area: InstanceType<EditorAreaControllerT>): void {
  const internal = area as unknown as {
    tabs: Array<Record<string, unknown>>;
    activePath: string;
    monaco: unknown;
    updateEditorToggles: () => void;
  };
  internal.tabs = [{
    path: "/work/Foo.cpp",
    label: "Foo.cpp",
    languageId: "cpp",
    model: { getValue: () => "", getLineCount: () => 1, dispose() {} },
    dirty: false,
    annotated: false,
    blame: null,
    blameKind: null,
    viewState: null,
  }];
  internal.activePath = "/work/Foo.cpp";
  internal.updateEditorToggles();
}

test("annotate shows the running pip while blame is fetched", async () => {
  const area = new EditorAreaController({ getWorkspaceRoot: () => "/work" });
  let finish!: (result: unknown) => void;
  Object.assign(window, { jellybot: { annotateFile: () => new Promise<unknown>(resolve => { finish = resolve; }) } });
  installActiveTab(area);
  const annotate = launchButtons(area)[7];
  annotate.click();
  await tick();
  assert.ok(annotate.classList.contains("is-running"), "blame fetch in flight");
  finish({ ok: true, lines: [], kind: "git" });
  await tick();
  assert.ok(!annotate.classList.contains("is-running"), "pip clears on settle");
  assert.ok(annotate.classList.contains("is-on"));
  area.destroy();
});

test("diff shows the running pip while the working base is fetched", async () => {
  const area = new EditorAreaController({ getWorkspaceRoot: () => "/work" });
  let finish!: () => void;
  Object.assign(window, { jellybot: { getVcsFileBase: () => new Promise<unknown>(resolve => { finish = () => resolve({ ok: true, content: "base" }); }) } });
  const disposable = { dispose() {} };
  const sideEditor = () => ({ focus() {}, getContribution: () => null });
  const diffEditor = {
    setModel() {}, updateOptions() {}, layout() {}, dispose() {},
    getLineChanges: () => [],
    onDidUpdateDiff: () => disposable,
    onDidChangeModel: () => disposable,
    getContribution: () => null,
    getModifiedEditor: sideEditor,
    getOriginalEditor: sideEditor,
  };
  (area as unknown as { monaco: unknown }).monaco = {
    editor: {
      createModel: () => ({ dispose() {} }),
      createDiffEditor: () => diffEditor,
    },
  };
  installActiveTab(area);
  const [, , , , , minimap, diff, blame] = launchButtons(area);
  assert.equal(minimap.hidden, false);
  assert.equal(blame.hidden, false);
  diff.click();
  await tick();
  assert.ok(diff.classList.contains("is-running"), "VCS base fetch in flight");
  assert.equal(minimap.hidden, true, "side-by-side diff hides the local minimap control");
  assert.equal(blame.hidden, true, "side-by-side diff hides the local blame control");
  finish();
  await tick();
  assert.ok(!diff.classList.contains("is-running"), "pip clears on settle");
  assert.ok(diff.classList.contains("is-on"));
  diff.click();
  await tick();
  assert.ok(!diff.classList.contains("is-on"));
  assert.equal(minimap.hidden, false, "returning to the single editor restores minimap");
  assert.equal(blame.hidden, false, "returning to the single editor restores blame");
  area.destroy();
});

test("deploy follows config visibility and routes clicks with independent task state", () => {
  const area = fresh();
  const deploy = launchButtons(area)[3];
  const fired: string[] = [];
  area.onDeployClick = () => fired.push("deploy");
  area.setDeployCommand("npm run deploy");
  assert.equal(deploy.hidden, false);
  assert.equal(deploy.disabled, false);
  assert.match(deploy.title, /npm run deploy/);
  deploy.click();
  assert.deepEqual(fired, ["deploy"]);
  area.setDeployState(true, false);
  assert.ok(deploy.classList.contains("is-running"));
  assert.ok(!launchButtons(area)[0].classList.contains("is-running"));
  area.setDeployState(false, true);
  assert.ok(deploy.classList.contains("is-failed"));
  area.setDeployCommand(null);
  assert.equal(deploy.hidden, true);
  assert.equal(deploy.disabled, true);
});
