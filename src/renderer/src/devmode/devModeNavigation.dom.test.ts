import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const extensions = (Module as unknown as { _extensions: Record<string, (...args: any[]) => void> })._extensions;
extensions[".css"] = () => {};
extensions[".svg"] = (module: { exports: string }, filename: string) => {
  module.exports = `data:image/svg+xml,${encodeURIComponent(readFileSync(filename, "utf8"))}`;
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
const values = new Map<string, string>();
let focused: HTMLElement | null = null;
Object.defineProperty(dom.document, "activeElement", { get: () => focused });
dom.HTMLElement.prototype.focus = function () { focused = this; };
dom.HTMLElement.prototype.getBoundingClientRect = () => ({
  x: 8, y: 32, left: 8, top: 32, right: 296, bottom: 66, width: 288, height: 34,
  toJSON: () => ({}),
});
Object.assign(globalThis, {
  document: dom.document, window: dom.window, Node: dom.Node, Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  localStorage: { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) },
});
Object.assign(dom.window, { innerWidth: 1024, innerHeight: 700 });

let Navigation: typeof import("./DevModeNavigationController.js")["DevModeNavigationController"];
test.before(async () => { ({ DevModeNavigationController: Navigation } = await import("./DevModeNavigationController.js")); });
test.beforeEach(() => { document.body.replaceChildren(); values.clear(); focused = null; });

function harness() {
  const workspaces = [
    { id: "a", name: "JellyBot", path: "E:/JellyBot" },
    { id: "b", name: "Project.NF", path: "E:/Project.NF" },
    { id: "empty", name: "Sandbox", path: "E:/Sandbox" },
  ];
  const tasks = new Map<string, Array<{ id: string; title: string; updatedAt: number; status?: string }>>([
    ["a", [{ id: "a1", title: "Build Windows", updatedAt: 200 }, { id: "a2", title: "Refresh files", updatedAt: 100 }]],
    ["b", [{ id: "b1", title: "Debug pause", updatedAt: 300 }, { id: "b2", title: "Build Unreal", updatedAt: 200, status: "running" }]],
    ["empty", []],
  ]);
  const chatPane = document.createElement("div");
  const chatTitleButton = document.createElement("button");
  chatTitleButton.textContent = "Task";
  chatPane.append(chatTitleButton);
  const opened: string[] = [], switched: string[] = [], archived: string[] = [], deleted: string[] = [];
  const newTasks: string[] = [];
  const createAnchors: HTMLButtonElement[] = [];
  const navigation = new Navigation({ chatPane, chatTitleButton }, {
    getWorkspaces: () => workspaces,
    getWorkspaceSessions: (id) => tasks.get(id) ?? [],
    onOpenSession: (id) => { opened.push(id); navigation.setContext(navigation.workspace!.path, id); },
    onWorkspaceSelected: (id) => {
      switched.push(id);
      navigation.setContext(workspaces.find((workspace) => workspace.id === id)!.path, navigation.taskForWorkspace(id));
    },
    onNewTask: () => { newTasks.push(navigation.workspace!.id); navigation.setContext(navigation.workspace!.path, null); },
    onCreateWorkspace: (anchor) => { createAnchors.push(anchor); },
    onArchiveSession: (id) => archived.push(id),
    onDeleteSession: (id) => deleted.push(id),
  });
  document.body.append(navigation.workspaceHeader, chatPane);
  navigation.setContext("E:/JellyBot", "a1");
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]')!;
  const click = (selector: string) => {
    const target = document.querySelector<HTMLElement>(selector);
    assert.ok(target, selector);
    target.dispatchEvent(new dom.Event("click", { bubbles: true }));
  };
  return { navigation, chatTitleButton, workspaces, tasks, opened, switched, archived, deleted, newTasks, createAnchors, menu, click };
}

test("the chat menu exposes only current-workspace tasks and uses Task wording", () => {
  const h = harness();
  try {
    h.chatTitleButton.click();
    assert.equal(h.menu().getAttribute("aria-label"), "Tasks");
    assert.deepEqual([...h.menu().querySelectorAll<HTMLElement>("[role=menuitem][data-session-id]")].map((row) => row.dataset.sessionId), ["a1", "a2"]);
    assert.equal(h.menu().querySelector("[data-workspace-id]"), null);
    assert.equal(h.menu().querySelector(".devmode-session-group-head"), null);
    assert.match(h.menu().textContent!, /New Task/);
    assert.doesNotMatch(h.menu().textContent!, /Session/);
    h.click('[data-navigation-key="a2"]');
    assert.deepEqual(h.opened, ["a2"]);
    assert.deepEqual(h.switched, []);
    assert.equal(h.navigation.workspace!.id, "a");
  } finally { h.navigation.destroy(); }
});

test("the tree header switches workspaces and restores each workspace's selected task", () => {
  const h = harness();
  try {
    h.navigation.setContext("E:/JellyBot", "a2");
    h.navigation.workspaceButton.click();
    assert.equal(h.menu().parentElement, document.body, "workspace menu escapes the clipped tree card");
    assert.equal(h.menu().querySelector("[data-session-id]"), null);
    h.click('[data-workspace-id="b"]');
    assert.equal(h.navigation.workspace!.id, "b");
    h.chatTitleButton.click(); h.click('[data-navigation-key="b2"]');
    h.navigation.workspaceButton.click(); h.click('[data-workspace-id="a"]');
    assert.equal(h.navigation.taskForWorkspace("a"), "a2");
    h.navigation.workspaceButton.click(); h.click('[data-workspace-id="b"]');
    assert.equal(h.navigation.taskForWorkspace("b"), "b2");
    assert.deepEqual(h.switched, ["b", "a", "b"]);
  } finally { h.navigation.destroy(); }
});

test("New Task remains pinned and is restored instead of reopening an old task", () => {
  const h = harness();
  try {
    h.chatTitleButton.click(); h.click('[data-navigation-key="new-task"]');
    assert.deepEqual(h.newTasks, ["a"]);
    h.navigation.workspaceButton.click(); h.click('[data-workspace-id="b"]');
    assert.equal(h.navigation.taskForWorkspace("a"), null);
    h.navigation.workspaceButton.click(); h.click('[data-workspace-id="empty"]');
    h.chatTitleButton.click();
    assert.match(h.menu().textContent!, /No tasks yet/);
    assert.ok(h.menu().querySelector('[data-navigation-key="new-task"]'));
    assert.equal(h.navigation.taskForWorkspace("empty"), null);
  } finally { h.navigation.destroy(); }
});

test("remembered tasks persist across entries and fall back after deletion or archiving", () => {
  const h = harness();
  h.navigation.setContext("E:/Project.NF", "b2");
  h.navigation.destroy();
  const other = harness();
  try {
    assert.equal(other.navigation.taskForWorkspace("b"), "b2", "re-entering restores another workspace's last task");
    other.navigation.setContext("E:/JellyBot", "a2");
    other.navigation.setContext("E:/Project.NF", "b1");
    other.tasks.set("a", other.tasks.get("a")!.filter((task) => task.id !== "a2"));
    assert.equal(other.navigation.taskForWorkspace("a"), "a1");
  } finally { other.navigation.destroy(); }
});

test("streaming tasks keep their menu order and cannot be archived or deleted", () => {
  const h = harness();
  try {
    h.navigation.setContext("E:/Project.NF", "b1");
    h.chatTitleButton.click();
    const ids = () => [...h.menu().querySelectorAll<HTMLElement>("[data-navigation-key][data-session-id]")].map((row) => row.dataset.sessionId);
    assert.deepEqual(ids(), ["b1", "b2"]);
    h.tasks.get("b")![1]!.updatedAt = 500;
    h.navigation.refresh();
    assert.deepEqual(ids(), ["b1", "b2"]);
    const running = h.menu().querySelector('[data-navigation-key="b2"]')!;
    assert.equal(running.querySelector<HTMLButtonElement>(".devmode-session-item-delete")!.disabled, true);
    assert.equal(running.querySelector<HTMLButtonElement>(".devmode-session-item-archive")!.disabled, true);
    assert.ok(running.querySelector('[aria-label="Running"]'));
    h.tasks.get("b")![1]!.status = "idle";
    h.navigation.refresh();
    assert.deepEqual(ids(), ["b2", "b1"]);
  } finally { h.navigation.destroy(); }
});

test("task actions never open a task and keep Task labels", () => {
  const h = harness();
  try {
    h.chatTitleButton.click();
    h.click('[data-navigation-key="a2"] [aria-label="Archive task"]');
    assert.deepEqual(h.archived, ["a2"]);
    assert.deepEqual(h.opened, []);
    assert.equal(document.querySelector('[role="menu"]'), null);
    h.chatTitleButton.click();
    h.click('[data-navigation-key="a2"] [aria-label="Delete task"]');
    assert.deepEqual(h.deleted, ["a2"]);
    assert.deepEqual(h.opened, []);
  } finally { h.navigation.destroy(); }
});

test("menus are exclusive and keyboard/outside dismissal cleans up", () => {
  const h = harness();
  try {
    h.navigation.workspaceButton.click(); h.navigation.workspaceCreateButton.click();
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.deepEqual(h.createAnchors, [h.navigation.workspaceCreateButton]);
    assert.deepEqual(h.switched, []);
    assert.deepEqual(h.opened, []);
    assert.equal(h.navigation.workspace!.id, "a", "opening creation keeps the current workspace until it succeeds");
    h.navigation.workspaceButton.click(); h.chatTitleButton.click();
    assert.equal(document.querySelectorAll('[role="menu"]').length, 1);
    assert.equal(h.navigation.workspaceButton.getAttribute("aria-expanded"), "false");
    const down = new dom.Event("keydown", { bubbles: true, cancelable: true });
    Object.assign(down, { key: "ArrowDown" });
    focused!.dispatchEvent(down);
    assert.equal(focused!.dataset.navigationKey, "a2");
    const escape = new dom.Event("keydown", { bubbles: true }); Object.assign(escape, { key: "Escape" });
    document.dispatchEvent(escape);
    assert.equal(document.querySelector('[role="menu"]'), null);
    assert.equal(focused, h.chatTitleButton);
    h.navigation.workspaceButton.click();
    document.body.dispatchEvent(new dom.Event("pointerdown", { bubbles: true }));
    assert.equal(document.querySelector('[role="menu"]'), null);
    h.navigation.workspaceButton.click(); h.navigation.destroy();
    assert.equal(document.querySelector('[role="menu"]'), null);
    h.chatTitleButton.click();
    assert.equal(document.querySelector('[role="menu"]'), null);
    h.navigation.workspaceCreateButton.click();
    assert.equal(h.createAnchors.length, 1, "destroy removes the create handler");
  } finally { h.navigation.destroy(); }
});

test("Windows paths and renamed workspaces retain identity", () => {
  const h = harness();
  try {
    h.navigation.setContext("e:\\JELLYBOT\\", "a2");
    assert.equal(h.navigation.workspace!.id, "a");
    h.workspaces[0]!.name = "Larry Agent";
    h.navigation.refresh();
    assert.equal(h.navigation.workspaceButton.textContent, "Larry Agent");
  } finally { h.navigation.destroy(); }
});
