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

const { buildNewTaskPanel, releaseNewTaskComposer } = await import("../src/render.js");

const PROJECTS = [
  { id: "/Users/youyee/Developer/JellyBot", name: "JellyBot", path: "/Users/youyee/Developer/JellyBot" },
  { id: "/Users/youyee/Developer/JNote", name: "JNote", path: "/Users/youyee/Developer/JNote" },
];

function build(overrides: Record<string, unknown> = {}) {
  const picked: string[] = [];
  const sent: Array<{ text: string; workspaceId: string | null }> = [];
  const panel = buildNewTaskPanel({
    workspaces: PROJECTS,
    selectedWorkspaceId: null,
    draft: "",
    heroIconUrl: "favicon.png",
    onPickWorkspace: (id: string) => void picked.push(id),
    onSend: (text: string, workspaceId: string | null) => void sent.push({ text, workspaceId }),
    ...overrides,
  });
  return { panel, picked, sent };
}

test("menu lists existing projects with the default highlighted, no create item on legacy builds", () => {
  const { panel } = build();
  const menu = panel.root.querySelector(".new-task-workspace-menu")!;
  const items = [...menu.querySelectorAll(".new-task-workspace-item")];
  assert.equal(items.length, 2);
  assert.match(items[0].textContent!, /JellyBot/);
  assert.match(items[1].textContent!, /JNote/);
  assert.ok(items[0].classList.contains("is-active"));
  assert.ok(!menu.querySelector(".ws-new-project"));
  assert.ok(panel.root.querySelector(".new-task-workspace-name")!.textContent!.includes("JellyBot"));
});

test("picking a project updates the pill label and notifies the caller", () => {
  const { panel, picked } = build();
  const items = [...panel.root.querySelectorAll(".new-task-workspace-item")];
  (items[1] as HTMLElement).click();
  assert.deepEqual(picked, [PROJECTS[1].id]);
  assert.ok(panel.root.querySelector(".new-task-workspace-name")!.textContent!.includes("JNote"));
  const fresh = [...panel.root.querySelectorAll(".new-task-workspace-item")] as HTMLElement[];
  assert.ok(fresh[1].classList.contains("is-active"));
  assert.ok(!fresh[0].classList.contains("is-active"));
});

test("send is gated on prompt text and fires with the selected project", () => {
  const { panel, sent } = build();
  const sendBtn = panel.root.querySelector(".send-btn") as HTMLButtonElement;
  const before = sendBtn.hasAttribute("disabled");
  panel.textarea.value = "  ";
  panel.textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok(sendBtn.hasAttribute("disabled") || before);
  panel.textarea.value = "Fix the login bug";
  panel.textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  sendBtn.click();
  assert.deepEqual(sent, [{ text: "Fix the login bug", workspaceId: PROJECTS[0].id }]);
});

test("releasing the send lock re-enables the composer and toolbar", () => {
  const { panel } = build();
  let toolbarDisabled: boolean | null = null;
  panel.setBusy(true);
  assert.ok(panel.textarea.hasAttribute("disabled"), "composer locked while sending");
  releaseNewTaskComposer(panel, { setDisabled: (next) => { toolbarDisabled = next; } });
  assert.ok(!panel.textarea.hasAttribute("disabled"), "composer unlocked after send");
  assert.equal(toolbarDisabled, false, "toolbar unlocked with the composer");
});

test("draft text restores into the composer", () => {
  const { panel } = build({ draft: "half-typed thought" });
  assert.equal(panel.textarea.value, "half-typed thought");
});

test("empty project list renders the empty hint and keeps send disabled", () => {
  const { panel } = build({ workspaces: [] });
  assert.match(panel.root.querySelector(".new-task-workspace-menu")!.textContent!, /No projects yet\./);
  assert.equal(panel.root.querySelector(".new-task-workspace-name")!.textContent, "No projects");
  panel.textarea.value = "hello";
  panel.textarea.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.ok((panel.root.querySelector(".send-btn") as HTMLElement).hasAttribute("disabled"));
});

function buildWithCreate(overrides: Record<string, unknown> = {}) {
  const created: Array<{ name: string; path: string }> = [];
  const browseCalls: Array<string | null> = [];
  const { panel } = build({
    onCreateWorkspace: async (name: string, path: string) => {
      created.push({ name, path });
      return {
        ok: true,
        workspace: { id: "ws-new", name, path },
        existing: false,
      };
    },
    onBrowseDir: async (path: string | null) => ({
      ok: true as const,
      path: path ?? "/Users/x",
      parent: path ? "/Users/x" : null,
      dirs: path ? ["JellyBot", "ETHub"] : ["Developer", "Desktop"],
    }),
    ...overrides,
  });
  return { panel, created, browseCalls };
}

test("create entry appears with the callback and survives the empty list", () => {
  const { panel } = buildWithCreate();
  const menu = panel.root.querySelector(".new-task-workspace-menu")!;
  const entry = menu.querySelector(".ws-new-project") as HTMLElement;
  assert.ok(entry, "New Project… entry present");
  assert.match(entry.textContent!, /New Project/);

  const { panel: emptyPanel } = buildWithCreate({ workspaces: [] });
  const emptyMenu = emptyPanel.root.querySelector(".new-task-workspace-menu")!;
  assert.ok(emptyMenu.querySelector(".ws-new-project"), "entry shows on the empty list too");
  assert.doesNotMatch(emptyMenu.textContent!, /No projects yet/);
});

test("create form validates and submits name + path", async () => {
  const { panel, created } = buildWithCreate({
    onCreateWorkspace: async (name: string, path: string) => {
      created.push({ name, path });
      if (!path.startsWith("/Users")) {
        return { ok: false, error: "Only folders inside the home directory can be browsed" };
      }
      return { ok: true, workspace: { id: "ws-new", name, path }, existing: false };
    },
  });
  const root = panel.root;
  (root.querySelector(".ws-new-project") as HTMLElement).click();

  const form = root.querySelector(".ws-form") as HTMLElement;
  const nameInput = form.querySelector(".ws-input:not(.mono)") as HTMLInputElement;
  const pathInput = form.querySelector(".ws-input.mono") as HTMLInputElement;
  const error = form.querySelector(".ws-form-error") as HTMLElement;
  assert.equal(form.hasAttribute("hidden"), false, "form visible after entry click");

  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(error.textContent!, /Name is required/);
  assert.equal(created.length, 0);

  nameInput.value = "PiBot";
  pathInput.value = "Developer/PiBot";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(error.textContent!, /absolute/);
  assert.equal(created.length, 0);

  pathInput.value = "/Users/x/Developer/PiBot";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(created, [{ name: "PiBot", path: "/Users/x/Developer/PiBot" }]);
  const menu = root.querySelector(".new-task-workspace-menu")!;
  assert.ok(!menu.classList.contains("is-open"), "menu closes on success");

  const fail = buildWithCreate({
    onCreateWorkspace: async () => ({ ok: false, error: "Device is in read-only mode" }),
  });
  (fail.panel.root.querySelector(".ws-new-project") as HTMLElement).click();
  const fForm = fail.panel.root.querySelector(".ws-form") as HTMLElement;
  (fForm.querySelector(".ws-input:not(.mono)") as HTMLInputElement).value = "X";
  (fForm.querySelector(".ws-input.mono") as HTMLInputElement).value = "/Users/x/X";
  fForm.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match((fForm.querySelector(".ws-form-error") as HTMLElement).textContent!, /read-only/);
});

test("folder browser navigates and Choose fills the path", async () => {
  const { panel } = buildWithCreate();
  const root = panel.root;
  (root.querySelector(".ws-new-project") as HTMLElement).click();
  const form = root.querySelector(".ws-form") as HTMLElement;
  (form.querySelector(".ws-browse-btn") as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));

  const browse = root.querySelector(".ws-browse") as HTMLElement;
  assert.equal(browse.hasAttribute("hidden"), false, "browse view visible");
  const items = [...browse.querySelectorAll(".ws-dir-item")] as HTMLElement[];
  assert.equal(items.length, 2, "home listing");
  assert.match(browse.querySelector(".ws-path-text")!.textContent!, /\/Users\/x/);

  (items.find((i) => i.textContent!.includes("Developer")) as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  const nested = [...browse.querySelectorAll(".ws-dir-item")] as HTMLElement[];
  assert.equal(nested.length, 2, "Developer listing");
  assert.match((browse.querySelector(".ws-choose-label") as HTMLElement).textContent!, /Developer/);

  (browse.querySelectorAll(".ws-choose-row .btn.primary")[0] as HTMLElement).click();
  assert.equal(form.hasAttribute("hidden"), false, "back to form");
  const pathInput = form.querySelector(".ws-input.mono") as HTMLInputElement;
  assert.equal(pathInput.value, "/Users/x/Developer");
});

test("disabled note locks the composer and shows the note", () => {
  const { panel } = build({ disabledNote: "Device is offline — new tasks unavailable." });
  assert.ok(panel.textarea.hasAttribute("disabled"));
  const err = panel.root.querySelector(".compose-error")!;
  assert.match(err.textContent!, /offline/);
  assert.equal(err.hasAttribute("hidden"), false);
});

test("inside clicks never close the picker; outside clicks do (regression: browse button)", async () => {
  const { panel } = build({
    onBrowseDir: async (path) => path === null
      ? { ok: true, path: "/Users/x", parent: null, dirs: ["Developer"] }
      : { ok: true, path, parent: "/Users", dirs: [] },
    onCreateWorkspace: async () => ({ ok: true, workspace: { id: "w9", name: "N", path: "/p" }, existing: false }),
  });
  const root = panel.root;
  document.body.append(root);
  const menu = root.querySelector(".new-task-workspace-menu") as HTMLElement;
  (root.querySelector(".new-task-workspace-btn") as HTMLElement).click();
  ([...menu.querySelectorAll("button")].find((b) => b.textContent!.includes("New Project")) as HTMLElement).click();
  assert.equal((menu.querySelector(".ws-form") as HTMLElement).hasAttribute("hidden"), false);
  (menu.querySelector(".ws-browse-btn") as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(menu.classList.contains("is-open"), true, "popover stays open on inside click");
  assert.equal((menu.querySelector(".ws-browse") as HTMLElement).hasAttribute("hidden"), false, "browse view stays up");
  (menu.querySelector(".ws-path-text") as HTMLElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
  assert.equal(menu.classList.contains("is-open"), true, "menu chrome click keeps it open");
  (root.querySelector(".welcome-title") as HTMLElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
  assert.equal(menu.classList.contains("is-open"), false, "outside click closes the popover");
  root.remove();
});

test("unresolved capability probe renders a loading placeholder, not a default composer", () => {
  const { panel } = build({ composerLoading: true });
  assert.ok(panel.root.querySelector(".composer-loading"), "loading placeholder rendered");
  assert.match(panel.root.querySelector(".composer-loading")!.textContent!, /Loading composer/);
  assert.equal(panel.root.querySelector(".composer-row"), null, "no legacy composer flash");
  assert.equal(panel.root.querySelector(".composer-card"), null, "no toolbar composer flash");
  assert.ok(panel.root.querySelector(".new-task-workspace-bar"), "picker still mounted");
  assert.ok(!panel.textarea.isConnected, "textarea stays detached while loading");
  panel.root.remove();
});
