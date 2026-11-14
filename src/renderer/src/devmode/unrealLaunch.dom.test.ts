import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import { createDevModeIcon } from "./launchIcon.js";
import type { UnrealBuildChoice, UnrealWorkspace } from "../../../unreal/workspaceTypes.js";

// The controls pull in AppDropdown (and its stylesheet); node:test needs the
// CSS stub, and the dropdown's Event/EventTarget must share the linkedom realm,
// so the module is imported after those globals exist.
(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, HTMLElement: dom.HTMLElement, Node: dom.Node, Event: dom.window.Event, EventTarget: dom.window.EventTarget });
Object.assign(window, { innerWidth: 1200, alert: (text: string) => { throw new Error(text); } });
let UnrealLaunchControls: (typeof import("./UnrealLaunchControls.js"))["UnrealLaunchControls"];
test.before(async () => { ({ UnrealLaunchControls } = await import("./UnrealLaunchControls.js")); });

const choices: UnrealBuildChoice[] = ["DebugGame", "Development"].map((configuration, i) => ({
  id: String(i), solution: "/game/Game.sln", project: "/game/Game.vcxproj", target: "GameEditor", targetType: "Editor",
  configuration, platform: "Win64", architecture: "x64", engineRoot: "/UE/Engine", projectRoot: "/game", uproject: "/game/Game.uproject",
  kind: "native", command: `build ${configuration}`, output: "/UE/Engine/Editor.exe", buildReason: null, runReason: null, debugReason: null,
}));
const model = (items = choices): UnrealWorkspace => ({ workspacePath: "/game", engineRoot: "/UE/Engine", projects: [], choices: items, selectedId: items[0]?.id ?? null, hasChoices: items.length > 1, warnings: [] });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const fieldDropdown = (title: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".devmode-build-menu .app-dropdown")]
    .find(root => root.querySelector(".app-dropdown-btn")?.getAttribute("aria-label") === title);

test("uses the app dropdown inside the configuration menu and preserves selection and dismissal", async () => {
  const h = harness(model());
  try {
    await h.control.setWorkspace("/game");
    const arrow = h.pill.firstElementChild as HTMLButtonElement;
    arrow.getBoundingClientRect = () => ({ left: 800, bottom: 34 } as DOMRect);
    arrow.click();
    const configuration = fieldDropdown("Configuration");
    assert.ok(configuration, "the configuration field renders a dropdown");
    configuration!.querySelector<HTMLButtonElement>(".app-dropdown-btn")!.click();
    const menu = [...document.querySelectorAll<HTMLElement>(".app-dropdown-menu")].find(entry => !entry.hidden)!;
    const rows = [...menu.querySelectorAll<HTMLElement>(".app-dropdown-option")];
    assert.equal(rows.length, 2);
    rows[1]!.click();
    await tick();
    assert.ok(h.calls.includes("select:1"));
    assert.ok(document.querySelector(".devmode-build-menu"), "picking a value keeps the menu open");
    assert.equal(fieldDropdown("Configuration")?.querySelector(".app-dropdown-value")?.textContent, "Development");
    h.control.dispose();
    assert.equal(document.querySelector(".devmode-build-menu"), null);
  } finally { h.dispose(); }
});

function harness(workspace: UnrealWorkspace | null) {
  let exit: (event: { task: string; workspacePath: string; runId: string }) => void = () => {};
  const calls: string[] = [];
  let active: Array<{ task: string; runId: string }> = [];
  Object.assign(window, { jellybot: {
    getUnrealWorkspace: async () => ({ ok: true, workspace }),
    getDevTaskState: async () => ({ ok: true, active, last: {}, buildGate: { ok: false } }),
    onDevTaskExit: (listener: typeof exit) => { exit = listener; return () => {}; },
    selectUnrealBuild: async (_root: string, id: string) => { calls.push(`select:${id}`); workspace = { ...workspace!, selectedId: id }; return { ok: true, workspace }; },
    runUnreal: async (_root: string, id: string) => { calls.push(`run:${id}`); active = [{ task: "run", runId: "run1" }]; return { ok: true, runId: "run1", command: "run" }; },
    stopDevTask: async (id: string) => { calls.push(`stop:${id}`); active = []; exit({ task: "run", workspacePath: "/game", runId: id }); return { ok: true }; },
    buildUnreal: async (_root: string, id: string) => { calls.push(`build:${id}`); return { ok: true, runId: "build1", command: "build" }; },
  } });
  const pill = document.createElement("div"), build = document.createElement("button"), debug = document.createElement("button");
  build.append(createDevModeIcon("build")); debug.append(createDevModeIcon("run"));
  debug.title = "Debug Electron"; pill.append(build, debug); document.body.append(pill);
  const control = new UnrealLaunchControls(build, debug, { revealTask: task => calls.push(`reveal:${task}`), debug: id => calls.push(`debug:${id}`), stopDebug: () => calls.push("stop-debug") });
  return { pill, build, debug, control, calls, exit: (id: string) => exit({ task: "run", workspacePath: "/game", runId: id }), dispose: () => { control.dispose(); pill.remove(); } };
}

test("ordinary workspaces preserve their buttons; only multiple choices insert the tiny selector", async () => {
  for (const workspace of [null, model(choices.slice(0, 1)), model()]) {
    const h = harness(workspace);
    try {
      await h.control.setWorkspace("/game");
      assert.equal(!!h.pill.querySelector(".devmode-build-selector"), workspace?.hasChoices ?? false);
      assert.equal(h.pill.children.length, workspace ? (workspace.hasChoices ? 4 : 3) : 2);
      if (!workspace) assert.equal(h.debug.querySelector("img")?.dataset.devModeIcon, "run");
      else assert.equal(h.debug.querySelector("img")?.dataset.devModeIcon, "debug");
    } finally { h.dispose(); }
  }
});

test("selector precedes Build, contains no persistent label and opens an accessible menu", async () => {
  const h = harness(model());
  try {
    await h.control.setWorkspace("/game");
    const arrow = h.pill.firstElementChild as HTMLButtonElement;
    assert.equal(arrow.nextElementSibling, h.build); assert.equal(arrow.textContent, "");
    arrow.getBoundingClientRect = () => ({ left: 1050, bottom: 34 } as DOMRect);
    arrow.click();
    assert.equal(arrow.getAttribute("aria-expanded"), "true");
    assert.equal(document.querySelectorAll(".devmode-build-menu .app-dropdown").length, 3);
    assert.equal(document.querySelectorAll(".devmode-build-menu select").length, 0, "no native select survives");
    const event = new dom.window.Event("keydown", { bubbles: true }); Object.assign(event, { key: "Escape" }); document.dispatchEvent(event);
    assert.equal(document.querySelector(".devmode-build-menu"), null);
  } finally { h.dispose(); }
});

test("Run and Debug are distinct; Stop replaces only the active button and restores it on exit", async () => {
  const h = harness(model());
  try {
    await h.control.setWorkspace("/game");
    const run = h.build.nextElementSibling as HTMLButtonElement;
    run.click(); await tick();
    assert.ok(h.calls.includes("run:0")); assert.ok(!h.calls.some(c => c.startsWith("debug:")));
    assert.equal(run.querySelector("img")?.dataset.devModeIcon, "stop"); assert.equal(h.debug.disabled, true);
    h.exit("old-run"); assert.equal(run.querySelector("img")?.dataset.devModeIcon, "stop");
    run.click(); await tick();
    assert.ok(h.calls.includes("stop:run1")); assert.equal(run.querySelector("img")?.dataset.devModeIcon, "run");
    h.control.debugClick(); assert.ok(h.calls.includes("debug:0"));
    h.control.setDebugState({ workspacePath: "/game", status: "building" });
    assert.equal(h.debug.querySelector("img")?.dataset.devModeIcon, "stop"); assert.equal(run.disabled, true);
    h.control.debugClick(); assert.ok(h.calls.includes("stop-debug"));
    h.control.setDebugState({ workspacePath: "/game", status: "idle" });
    assert.equal(h.debug.querySelector("img")?.dataset.devModeIcon, "debug"); assert.equal(run.disabled, false);
  } finally { h.dispose(); }
});

test("late workspace discovery cannot restore the selector in an ordinary project", async () => {
  const h = harness(model());
  try {
    let resolveFirst: (result: unknown) => void = () => {};
    Object.assign(window.jellybot!, { getUnrealWorkspace: (root: string) => root === "/game" ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ ok: true, workspace: null }) });
    const first = h.control.setWorkspace("/game");
    await h.control.setWorkspace("/ordinary");
    resolveFirst({ ok: true, workspace: model() }); await first;
    assert.equal(h.pill.children.length, 2); assert.equal(h.control.active, false);
  } finally { h.dispose(); }
});
