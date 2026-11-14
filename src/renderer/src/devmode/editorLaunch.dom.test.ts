/**
 * DOM tests: the workspace launch cluster riding the editor tab bar's right
 * edge — one merged segmented pill (V1 uniform rules):
 * [Build][Debug ▶][gear | minimap][diff][annotate] (+ animated chat segment
 * appended via appendFab when the chat pane collapses).
 *
 * Structure (order, no fab row), state APIs (spinner/pip, debug enable,
 * Unreal gear hiding) and the click wiring.
 */
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

// EditorAreaController pulls monacoSetup, whose top level imports Vite
// `?worker&inline` workers and a stock language definition — neither runs
// under node. Stub those module requests; monaco itself stays lazy
// (loadMonaco) and is never touched by these tests.
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

test("file status moves into the shared toolbar without adding file-detail controls", () => {
  const area = fresh();
  const status = area.root.querySelector(".devmode-editor-status")!;
  const path = status.querySelector(".devmode-status-path");
  const saved = status.querySelector(".devmode-status-state");
  const progress = status.querySelector(".devmode-status-index");
  const host = document.createElement("div");
  area.mountStatusBar(host);
  assert.equal(host.firstElementChild, status);
  assert.equal(status.querySelector(".devmode-status-path"), path);
  assert.equal(status.querySelector(".devmode-status-state"), saved);
  assert.equal(status.querySelector(".devmode-status-index"), progress);
  assert.equal(area.root.querySelector(".devmode-editor-status"), null);
  assert.equal(status.querySelector("button"), null);
  assert.ok(status.classList.contains("is-panel-inline"));
  area.destroy();
  assert.equal(host.childElementCount, 0);
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
  assert.equal(btns.length, 7); // build, debug, optional deploy, config, minimap, diff, annotate
  const names = ["build", "run", "deploy", "configure", "minimap", "diff", "blame"];
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
  assert.ok(btns[1].title.length > 0, "debug title defaults to a recipe string");
  assert.ok(btns[1].disabled, "debug disabled until a recipe resolves");
  assert.ok(btns[2].hidden, "deploy hidden until configured");
  assert.ok(btns[2].disabled);
  assert.match(btns[3].title, /Configure tasks/);
  assert.match(btns[4].title, /[Mm]inimap/);
  assert.ok(btns[5].disabled, "diff disabled until a model opens");
  assert.ok(btns[6].disabled, "annotate disabled until a tab is active");
  const pill = launch.querySelector(".devmode-launch-pill") as HTMLElement;
  assert.ok(pill, "segmented pill wrapping the task actions");
  assert.equal(
    btns.every((b) => pill.contains(b)),
    true,
    "all seven segments live inside the pill",
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
  const [, debug] = launchButtons(area);
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
  assert.equal(btns.length, 7); // still in the DOM, gear is hidden
  assert.ok((btns[3] as HTMLElement).hidden, "gear hidden");
  area.setConfigVisible(true);
  assert.equal((btns[3] as HTMLElement).hidden, false);
});

test("setBuildState drives the spinner and failure pip", () => {
  const area = fresh();
  const [build] = launchButtons(area);
  area.setBuildState(true, false);
  assert.match(build.className, /is-running/);
  area.setBuildState(false, true);
  assert.ok(!/is-running/.test(build.className));
  assert.match(build.className, /is-failed/);
  const pip = build.querySelector(".devmode-launch-pip") as HTMLElement;
  assert.ok(pip);
});

test("clicks route through the wired callbacks", () => {
  const area = fresh();
  const fired: string[] = [];
  area.onBuildClick = () => fired.push("build");
  area.onDebugClick = () => fired.push("debug");
  area.onConfigClick = () => fired.push("config");
  const [build, , , config] = launchButtons(area);
  build.click();
  config.click();
  assert.deepEqual(fired, ["build", "config"]); // debug disabled → no click
  area.setDebugRecipe("web");
  launchButtons(area)[1].click();
  assert.deepEqual(fired, ["build", "config", "debug"]);
});


test("deploy follows config visibility and routes clicks with independent task state", () => {
  const area = fresh();
  const deploy = launchButtons(area)[2];
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
