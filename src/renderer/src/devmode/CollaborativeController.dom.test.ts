import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { CollaborativeRepository, CollaborativeRequest, CollaborativeResult } from "../../../shared/collaborative.js";
import type { EditorAreaController } from "./EditorAreaController.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.window.Event, EventTarget: dom.window.EventTarget });
Object.assign(dom.window, { innerWidth: 1200, innerHeight: 800 });
const modules = Module as unknown as { _load: (...args: any[]) => any; _extensions: Record<string, (...args: any[]) => void> };
modules._extensions[".css"] = () => {};
modules._extensions[".svg"] = (module: { exports: string }, file: string) => { module.exports = readFileSync(file, "utf8"); };
const originalLoad = modules._load;
modules._load = function (request: string, parent: { filename: string }, ...rest: unknown[]) {
  if (request === "./monacoSetup.js") return { resolveDevModeTheme: () => "jellybot-dark" };
  return originalLoad.call(this, request, parent, ...rest);
};
let Controller: typeof import("./CollaborativeController.js")["CollaborativeController"];
test.before(async () => {
  ({ CollaborativeController: Controller } = await import("./CollaborativeController.js"));
  Object.getPrototypeOf(document.createElement("textarea")).setSelectionRange ??= () => {};
});
const tick = async () => { for (let i = 0; i < 5; i++) await new Promise<void>(done => setImmediate(done)); };

function model(initial: string) {
  let value = initial;
  const listeners = new Set<() => void>();
  function setValue(text: string) { value = text; for (const callback of listeners) callback(); }
  return { getValue: () => value, setValue,
    getLineCount: () => value.split("\n").length, getLineMaxColumn: (line: number) => value.split("\n")[line - 1]!.length + 1,
    onDidChangeContent: (callback: () => void) => { listeners.add(callback); return { dispose: () => listeners.delete(callback) }; }, dispose() {} };
}
function harness(configured = true, readGate?: Promise<void>) {
  document.body.replaceChildren();
  const repositories: CollaborativeRepository[] = [
    { id: "engine", name: "Engine", kind: "git", root: "E:/NF/Engine", materialized: [], ...(configured ? { binding: { branch: "origin/release", directory: "E:/branches/engine", revision: "abc", localBranch: "release" } } : {}) },
    { id: "game", name: "Game", kind: "svn", root: "E:/NF/Game", materialized: [] },
  ];
  let enabled = false, saved = "branch content", checkedOut = false, activePath = "E:/NF/Engine/test.cpp", originalFocused = false;
  let save!: () => boolean;
  const calls: CollaborativeRequest[] = [], createdModels: ReturnType<typeof model>[] = [], diffOptions: any[] = [];
  const local = model("local content"), root = document.createElement("div"), header = document.createElement("div"), fab = document.createElement("div"), localTree = document.createElement("div");
  document.body.append(header, localTree, fab, root);
  const api = { Uri: { from: (uri: { path: string }) => uri }, editor: {
    createModel: (text: string) => { const result = model(text); createdModels.push(result); return result; },
    create: () => ({ dispose() {}, focus() {} }),
    createDiffEditor: (_host: HTMLElement, options: any) => { diffOptions.push(options); return { setModel() {}, dispose() {}, getLineChanges: () => null,
      onDidUpdateDiff: () => ({ dispose() {} }), onDidChangeModel: () => ({ dispose() {} }),
      getModifiedEditor: () => ({ focus() {}, getModel: () => createdModels[0] }), getOriginalEditor: () => ({ hasTextFocus: () => originalFocused }) }; },
  } };
  const area = { appendFab: (button: HTMLElement) => fab.append(button),
    installCollaborativeView: (host: HTMLElement, tab: HTMLElement, handlers: { save: () => boolean }) => { root.append(tab, host); save = handlers.save; },
    showCollaborativeView: (visible: boolean) => root.classList.toggle("is-collaborative-view", visible),
    prepareCollaborativeEditor: async () => api, getActiveDocument: () => activePath ? ({ path: activePath, text: local.getValue() }) : null,
    collaborativeLocalDocument: (path: string) => path === "E:/NF/Engine/test.cpp" ? { model: local, readOnly: false, savedContent: "local content" } : null,
    openFile: async (path: string) => { activePath = path; controller.onLocalFile(path); },
  } as unknown as EditorAreaController;
  Object.assign(window, { jellybot: { platform: "win32", collaborativeBranch: async (request: CollaborativeRequest): Promise<CollaborativeResult> => {
    calls.push(request);
    if (request.op === "scan" || request.op === "state") return { enabled, repositories: structuredClone(repositories) };
    if (request.op === "enable") { enabled = !!request.enabled; return { enabled }; }
    if (request.op === "exists") return { exists: request.path === "test.cpp" };
    if (request.op === "list") return { entries: [{ name: "test.cpp", path: "test.cpp", directory: false, materialized: checkedOut, modified: false }] };
    if (request.op === "read" && readGate) await readGate;
    if (request.op === "materialize") checkedOut = true;
    if (request.op === "save") { checkedOut = true; saved = request.content!; }
    if (request.op === "changes") return { paths: [] };
    return { file: { path: "test.cpp", content: saved, hash: saved, binary: false, materialized: checkedOut } };
  } } });
  const controller = new Controller({ area, localTree, headerActions: header });
  document.body.append(controller.tree);
  const click = async (label: string) => { const button = document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`); assert(button, label); button.click(); await tick(); };
  return { controller, calls, repositories, header, fab, localTree, root, local, createdModels, diffOptions, click, save: () => save(), focusOriginal: () => { originalFocused = true; },
    openLocal: (path: string) => { activePath = path; controller.onLocalFile(path); }, closeLocal: () => { activePath = ""; controller.onLocalDocumentChanged(); } };
}

test("an unconfigured branch button opens the same repository settings as the right arrow", async () => {
  const h = harness(false);
  try {
    await h.controller.setWorkspace("E:/NF");
    const editorButton = h.fab.querySelector<HTMLButtonElement>("button")!;
    assert(editorButton.hidden);
    await h.click("Collaborative Branch Project");
    assert(document.querySelector(".collaborative-settings"), "the branch button opens settings when no branch is configured");
    assert.equal(h.calls.some(call => call.op === "enable"), false, "settings open instead of enabling an unusable tree");
    assert.equal(h.localTree.style.display, "", "the local tree stays visible before configuration");
    assert(editorButton.hidden);
    assert.equal(h.root.classList.contains("is-collaborative-view"), false);
    assert(h.root.querySelector<HTMLElement>(".devmode-diff-headings")!.hidden);
    await h.click("Close settings");
    await h.click("Repository settings");
    assert.equal(document.querySelectorAll(".collaborative-settings select").length, 0);
    assert(document.querySelector('[aria-label="Repository settings"]')!.classList.contains("devmode-build-selector"));
    assert(document.querySelector('[aria-label="Close settings"]')!.classList.contains("is-icon"));
    assert.equal(document.querySelectorAll(".collaborative-settings .app-dropdown [role=option]").length, 2);
    assert.match(document.querySelector(".collaborative-settings")!.textContent!, /GIT.*SVN/);
    await h.click("Repository");
    const menu = document.querySelector<HTMLElement>("body > .app-dropdown-menu")!;
    assert(menu); assert.equal(menu.querySelectorAll("[role=option]").length, 2);
    const game = menu.querySelectorAll<HTMLElement>("[role=option]")[1]!;
    game.dispatchEvent(new dom.Event("pointerdown", { bubbles: true })); game.click(); await tick();
    assert(document.querySelector(".collaborative-settings"), "using the portal menu keeps repository settings open");
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Collaborative branch"]')!.placeholder, "SVN branch URL");
    await h.click("Repository"); await h.click("Close settings");
    assert.equal(document.querySelector("body > .app-dropdown-menu"), null, "closing settings also closes its dropdown portal");
    assert.equal(h.root.classList.contains("is-collaborative-view"), false);
  } finally { h.controller.destroy(); }
});

test("opening a branch file does not enable dual view; editing materializes automatically and Ctrl+S saves only the branch model", async () => {
  const h = harness();
  try {
    await h.controller.setWorkspace("E:/NF");
    await h.click("Collaborative Branch Project");
    assert.equal(h.fab.querySelector<HTMLButtonElement>("button")!.hidden, false);
    await h.click("Engine"); await h.click("test.cpp");
    assert.equal(h.diffOptions.length, 0);
    assert(h.root.querySelector<HTMLElement>(".devmode-diff-headings")!.hidden);
    assert.equal(h.calls.filter(r => r.op === "materialize").length, 0);
    await h.click("Toggle collaborative dual view");
    assert.equal(h.diffOptions.length, 1); assert.equal(h.diffOptions[0].originalEditable, true);
    const headings = h.root.querySelector<HTMLElement>(".devmode-diff-headings")!;
    assert.equal(headings.hidden, false);
    assert.equal(headings.querySelectorAll(":scope > span").length, 2);
    assert.equal(headings.querySelector("button"), null);
    await h.click("test.cpp");
    assert.equal(h.diffOptions.length, 2, "file navigation preserves an explicitly activated dual view");
    h.createdModels[0]!.setValue("edited branch"); await tick();
    assert.equal(h.calls.filter(r => r.op === "materialize").length, 1);
    assert.equal(h.save(), true); await tick();
    assert.equal(h.calls.find(r => r.op === "save")?.content, "edited branch");
    assert.equal(h.calls.find(r => r.op === "save")?.workspacePath, "E:/NF");
    assert.equal(h.calls.some(r => r.op === "commit"), false);
    h.focusOriginal(); assert.equal(h.save(), false, "original side uses the existing local save path");
    await h.click("Toggle collaborative dual view");
    assert.equal(h.root.classList.contains("is-collaborative-view"), false);
    assert(headings.hidden);
  } finally { h.controller.destroy(); }
});

test("a slow branch read cannot replace a newer local file selection", async () => {
  let release!: () => void;
  const h = harness(true, new Promise<void>(done => { release = done; }));
  try {
    await h.controller.setWorkspace("E:/NF"); await h.click("Collaborative Branch Project"); await h.click("Engine");
    h.fab.querySelector<HTMLButtonElement>("button")!.click(); await tick();
    h.controller.onLocalFile("E:/NF/Engine/new.cpp"); release(); await tick();
    assert.equal(h.root.classList.contains("is-collaborative-view"), false);
    assert(h.root.querySelector<HTMLElement>(".devmode-diff-headings")!.hidden);
  } finally { release(); h.controller.destroy(); }
});

test("dual view toggle shows the build-style running pip until the branch read settles", async () => {
  let release!: () => void;
  const h = harness(true, new Promise<void>(done => { release = done; }));
  try {
    await h.controller.setWorkspace("E:/NF");
    await h.click("Collaborative Branch Project");
    const toggle = h.fab.querySelector<HTMLButtonElement>('[aria-label="Toggle collaborative dual view"]')!;
    assert(toggle);
    toggle.click(); await tick();
    assert.ok(toggle.classList.contains("is-running"), "branch read in flight shows the pulsing dot");
    release(); await tick();
    assert.ok(!toggle.classList.contains("is-running"), "the dot clears when the read settles");
    assert(h.root.classList.contains("is-collaborative-view"));
  } finally { release(); h.controller.destroy(); }
});

test("Checkout uses the folder picker, keeps the path on cancellation and ignores a closed settings panel", async () => {
  const h = harness();
  let picked: string | null = "E:/picked/release";
  window.jellybot!.pickWorkspaceFolder = async () => picked;
  try {
    await h.controller.setWorkspace("E:/NF"); await h.click("Repository settings");
    const picker = () => document.querySelector<HTMLButtonElement>('button[aria-label="Checkout directory"]')!;
    assert(picker(), "checkout is a button, not an editable path input");
    assert.equal(document.querySelector('input[aria-label="Checkout directory"]'), null);
    await h.click("Checkout directory"); assert.equal(picker().textContent, picked);
    picked = null; await h.click("Checkout directory"); assert.equal(picker().textContent, "E:/picked/release");
    assert.equal(h.calls.some(call => call.op === "bind"), false, "choosing a folder does not apply the binding");
    await h.click("Apply"); assert.equal(h.calls.find(call => call.op === "bind")?.directory, "E:/picked/release");

    await h.click("Repository settings");
    let finish!: (value: string) => void;
    window.jellybot!.pickWorkspaceFolder = () => new Promise(resolve => { finish = resolve; });
    await h.click("Checkout directory");
    assert(document.querySelector<HTMLButtonElement>('[aria-label="Apply"]')!.disabled);
    await h.click("Close settings"); await h.click("Repository settings");
    finish("E:/stale/selection"); await tick();
    assert.equal(picker().textContent, "E:/branches/engine", "a late picker result cannot alter another settings panel");
    assert.equal(document.querySelector<HTMLButtonElement>('[aria-label="Apply"]')!.disabled, false);
  } finally { h.controller.destroy(); }
});

test("a settings panel opened during discovery receives the completed repository scan automatically", async () => {
  const h = harness();
  const original = window.jellybot!.collaborativeBranch;
  let finish!: () => void, scans = 0;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  window.jellybot!.collaborativeBranch = async request => {
    if (request.op === "scan") { scans++; await gate; }
    return original(request);
  };
  try {
    const initial = h.controller.setWorkspace("E:/NF"); await tick();
    await h.click("Repository settings");
    assert.match(document.querySelector(".collaborative-settings-status")!.textContent!, /Scanning/);
    assert.equal(document.querySelectorAll(".collaborative-settings [role=option]").length, 0);
    assert.equal(scans, 1, "opening settings reuses the in-flight discovery request");
    finish(); await initial; await tick();
    assert.equal(document.querySelectorAll(".collaborative-settings [role=option]").length, 2);
    assert.match(document.querySelector(".collaborative-settings-status")!.textContent!, /2 repositories detected/);
    assert.equal(document.querySelector<HTMLInputElement>('[aria-label="Collaborative branch"]')!.value, "origin/release");
  } finally { finish(); h.controller.destroy(); }
});

test("reopening settings refreshes repository discovery without losing an in-progress binding draft", async () => {
  const h = harness();
  try {
    await h.controller.setWorkspace("E:/NF"); await h.click("Repository settings"); await h.click("Close settings");
    const original = window.jellybot!.collaborativeBranch;
    let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    window.jellybot!.collaborativeBranch = async request => { if (request.op === "scan") await gate; return original(request); };
    await h.click("Repository settings");
    const branch = document.querySelector<HTMLInputElement>('[aria-label="Collaborative branch"]')!;
    branch.value = "feature/typed-draft";
    h.repositories.push({ id: "plugin", name: "Plugin", kind: "git", root: "E:/NF/Game/Plugin", materialized: [] });
    finish(); await tick();
    assert.equal(document.querySelectorAll(".collaborative-settings [role=option]").length, 3);
    assert.equal(branch.value, "feature/typed-draft");
    assert.equal(h.calls.filter(call => call.op === "scan").length, 3, "each opening refreshes automatically");
  } finally { h.controller.destroy(); }
});

test("the dual-view toggle appears only when the current file has a version in its owning branch", async () => {
  const h = harness();
  try {
    await h.controller.setWorkspace("E:/NF"); await tick();
    const toggle = h.fab.querySelector<HTMLButtonElement>("button")!;
    assert.equal(toggle.hidden, false);
    h.openLocal("E:/NF/Engine/local-only.cpp"); await tick(); assert(toggle.hidden);
    h.openLocal("E:/NF/Game/test.cpp"); await tick(); assert(toggle.hidden, "the owning repository has no branch binding");
    h.openLocal("E:/NF/Engine/test.cpp"); await tick(); assert.equal(toggle.hidden, false);
    assert.equal(h.calls.some(call => call.op === "read" || call.op === "materialize"), false, "availability uses metadata only");
    await h.click("Collaborative Branch Project"); await h.click("Engine"); await h.click("test.cpp");
    h.closeLocal(); await tick(); assert(toggle.hidden, "there is no current editing file after closing the last tab");
  } finally { h.controller.destroy(); }
});

test("dual view is available with the local tree and stays active when the tree source changes", async () => {
  const h = harness();
  try {
    await h.controller.setWorkspace("E:/NF"); await tick();
    const toggle = h.fab.querySelector<HTMLButtonElement>("button")!;
    assert.equal(h.controller.tree.hidden, true);
    assert.equal(h.localTree.style.display, "");
    assert.equal(toggle.hidden, false, "matching runs while collaborative tree browsing is off");
    assert(h.calls.some(call => call.op === "exists" && call.path === "test.cpp"));
    assert.equal(h.controller.openLocalCommit("E:/NF/Engine/test.cpp"), false);
    await h.click("Toggle collaborative dual view");
    assert(h.root.classList.contains("is-collaborative-view"));
    assert.equal(h.calls.some(call => call.op === "enable"), false, "opening dual view does not enable the branch tree");
    await h.click("Collaborative Branch Project"); await h.click("Collaborative Branch Project");
    assert.equal(h.controller.tree.hidden, true);
    assert.equal(h.localTree.style.display, "");
    assert(h.root.classList.contains("is-collaborative-view"), "returning to the local tree does not close dual view");
    assert.equal(toggle.hidden, false); assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.equal(h.diffOptions.length, 1);
    assert.equal(h.controller.openLocalCommit("E:/NF/Game/test.cpp"), false);
    assert.equal(h.controller.openLocalCommit("E:/NF/Engine/test.cpp"), true);
    await tick();
    assert(h.calls.some(call => call.op === "editor-commit-files" && call.path === "test.cpp"));
    await h.controller.setWorkspace(null);
    assert.equal(document.querySelector(".devmode-commit"), null);
    assert.equal(h.root.classList.contains("is-collaborative-view"), false);
    assert.equal(h.controller.tree.hidden, true);
  } finally { h.controller.destroy(); }
});

test("tree Commit uses the clicked file, scopes AI generation, and retries only the failed branch", async () => {
  const h = harness();
  const original = window.jellybot!.collaborativeBranch;
  const files = [
    { side: "left", branch: "main", diskPath: "E:/NF/Engine/other.cpp", revision: "123", hash: "left", changed: true },
    { side: "right", branch: "release", diskPath: "E:/branches/engine/other.cpp", revision: "abc", hash: "right", changed: true, added: true },
  ] as const;
  let rightAttempts = 0;
  window.jellybot!.collaborativeBranch = async request => {
    if (request.op === "list") {
      assert.equal(request.includeWorkingCopy, true);
      return { entries: [{ name: "other.cpp", path: "other.cpp", directory: false, materialized: false, modified: false, localOnly: true }] };
    }
    if (request.op.startsWith("editor-commit")) h.calls.push(request);
    if (request.op === "editor-commit-files") return { commitFiles: [...files] };
    if (request.op === "editor-commit-message") return { commitMessage: { message: "Update other.cpp", source: "llm" } };
    if (request.op === "editor-commit") {
      if (request.commitFiles?.[0]?.side === "right" && ++rightAttempts === 1) return { commitError: "Commit hook failed" };
      return { commit: { subject: "Update other.cpp", shortHash: "deadbee" } };
    }
    return original(request);
  };
  try {
    await h.controller.setWorkspace("E:/NF");
    await h.click("Collaborative Branch Project");
    await h.click("Engine");
    h.local.setValue("Draft in test.cpp");
    const file = document.querySelector('[aria-label="other.cpp"]')!;
    const event = new dom.Event("contextmenu", { bubbles: true, cancelable: true });
    Object.assign(event, { clientX: 12, clientY: 12 });
    file.dispatchEvent(event);
    const menu = [...document.querySelectorAll<HTMLButtonElement>(".devmode-ctx-item")];
    assert.deepEqual(menu.map(item => item.textContent), ["Commit…"]);
    menu[0]!.click();
    await tick();

    const panel = document.querySelector(".devmode-commit")!;
    assert.match(panel.textContent!, /Left.*mainModified.*Right.*releaseAdded/);
    assert.match(panel.textContent!, /E:\/NF\/Engine\/other\.cpp/);
    assert.deepEqual(h.calls.find(call => call.op === "editor-commit-files")?.editorDrafts, {});
    const [left, right] = panel.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
    assert(left!.checked && right!.checked);
    left!.checked = false;
    left!.dispatchEvent(new dom.Event("change"));
    panel.querySelector<HTMLButtonElement>(".is-generate")!.click();
    await tick();
    assert.deepEqual(h.calls.find(call => call.op === "editor-commit-message")?.commitFiles, [files[1]]);
    assert.equal(panel.querySelector("textarea")!.value, "Update other.cpp");

    left!.checked = true;
    left!.dispatchEvent(new dom.Event("change"));
    const commit = panel.querySelector<HTMLButtonElement>(".is-primary")!;
    commit.click();
    await tick();
    assert(left!.disabled);
    assert.match(panel.textContent!, /release: Commit hook failed/);
    assert.equal(commit.disabled, false);
    commit.click();
    await tick();
    assert.equal(commit.textContent, "Done");
    assert.deepEqual(h.calls.filter(call => call.op === "editor-commit").map(call => [call.repositoryId, call.path, call.commitFiles?.[0]?.side]), [
      ["engine", "other.cpp", "left"], ["engine", "other.cpp", "right"], ["engine", "other.cpp", "right"],
    ]);
    commit.click();
    assert.equal(document.querySelector(".devmode-commit"), null);
  } finally { h.controller.destroy(); }
});

test("a late branch-version match cannot show the toggle for a newer unmatched file", async () => {
  const h = harness();
  const original = window.jellybot!.collaborativeBranch;
  let finish!: (result: CollaborativeResult) => void;
  window.jellybot!.collaborativeBranch = request => request.op === "exists" && request.path === "test.cpp"
    ? new Promise(resolve => { finish = resolve; }) : original(request);
  try {
    await h.controller.setWorkspace("E:/NF"); await h.click("Collaborative Branch Project");
    const toggle = h.fab.querySelector<HTMLButtonElement>("button")!;
    assert(toggle.hidden, "the match is still pending");
    h.openLocal("E:/NF/Engine/local-only.cpp"); await tick();
    finish({ exists: true }); await tick(); assert(toggle.hidden);
    h.openLocal("E:/NF/Engine/test.cpp"); await tick(); assert.equal(toggle.hidden, false);
  } finally { h.controller.destroy(); }
});

test("a successful automatic scan retries an unavailable branch-version lookup", async () => {
  const h = harness(), original = window.jellybot!.collaborativeBranch;
  let available = false;
  window.jellybot!.collaborativeBranch = async request => {
    if (request.op === "exists") { if (!available) throw new Error("Repository temporarily unavailable"); return { exists: true }; }
    return original(request);
  };
  try {
    await h.controller.setWorkspace("E:/NF"); await h.click("Collaborative Branch Project");
    const toggle = h.fab.querySelector<HTMLButtonElement>("button")!; assert(toggle.hidden);
    available = true; await h.click("Repository settings"); assert.equal(toggle.hidden, false);
  } finally { h.controller.destroy(); }
});
