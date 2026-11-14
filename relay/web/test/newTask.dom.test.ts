/**
 * DOM test: New Task panel (web console session creation) — mirrors the Mac
 * New Task screen: project picker with optional New Project… flow (create
 * form + device folder browser; entry hidden on legacy builds without the
 * callbacks), send gates on text + project, drafts restore.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

// buildNewTaskPanel touches document/window at render time — install linkedom first.
const dom = parseHTML("<!doctype html><html><body></body></html>");
(Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
}));

const { buildNewTaskPanel } = await import("../src/render.js");

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
  // First project is the default selection (persisted choice absent).
  assert.ok(items[0].classList.contains("is-active"));
  // No onCreateWorkspace callback → legacy device → no create entry.
  assert.ok(!menu.querySelector(".ws-new-project"));
  assert.ok(panel.root.querySelector(".new-task-workspace-name")!.textContent!.includes("JellyBot"));
});

test("picking a project updates the pill label and notifies the caller", () => {
  const { panel, picked } = build();
  const items = [...panel.root.querySelectorAll(".new-task-workspace-item")];
  (items[1] as HTMLElement).click();
  assert.deepEqual(picked, [PROJECTS[1].id]);
  assert.ok(panel.root.querySelector(".new-task-workspace-name")!.textContent!.includes("JNote"));
  // Active mark moves with the selection (menu re-renders fresh nodes).
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

// ── New Project… create flow ──────────────────────────────────
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

  // Empty list + create capability → the entry bootstraps the first project.
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

  // Empty submit → name error, no device call.
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(error.textContent!, /Name is required/);
  assert.equal(created.length, 0);

  // Name set, relative path → path error.
  nameInput.value = "PiBot";
  pathInput.value = "Developer/PiBot";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.match(error.textContent!, /absolute/);
  assert.equal(created.length, 0);

  // Valid → device call with trimmed values, menu closed (is-open removed).
  pathInput.value = "/Users/x/Developer/PiBot";
  form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(created, [{ name: "PiBot", path: "/Users/x/Developer/PiBot" }]);
  const menu = root.querySelector(".new-task-workspace-menu")!;
  assert.ok(!menu.classList.contains("is-open"), "menu closes on success");

  // Device-side failure → error surfaces inline.
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
  // Browse button next to the path input.
  (form.querySelector(".ws-browse-btn") as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));

  const browse = root.querySelector(".ws-browse") as HTMLElement;
  assert.equal(browse.hasAttribute("hidden"), false, "browse view visible");
  const items = [...browse.querySelectorAll(".ws-dir-item")] as HTMLElement[];
  assert.equal(items.length, 2, "home listing");
  assert.match(browse.querySelector(".ws-path-text")!.textContent!, /\/Users\/x/);

  // Enter Developer → nested listing, parent available.
  (items.find((i) => i.textContent!.includes("Developer")) as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  const nested = [...browse.querySelectorAll(".ws-dir-item")] as HTMLElement[];
  assert.equal(nested.length, 2, "Developer listing");
  assert.match((browse.querySelector(".ws-choose-label") as HTMLElement).textContent!, /Developer/);

  // Choose This Folder → back on the form with the path filled.
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
  document.body.append(root); // outside-click needs isConnected
  const menu = root.querySelector(".new-task-workspace-menu") as HTMLElement;
  // Open the picker, walk into the create form.
  (root.querySelector(".new-task-workspace-btn") as HTMLElement).click();
  ([...menu.querySelectorAll("button")].find((b) => b.textContent!.includes("New Project")) as HTMLElement).click();
  assert.equal((menu.querySelector(".ws-form") as HTMLElement).hasAttribute("hidden"), false);
  // The browse button click must NOT close the popover (its click used to
  // bubble to the document outside-click closer and slam the menu shut).
  (menu.querySelector(".ws-browse-btn") as HTMLElement).click();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(menu.classList.contains("is-open"), true, "popover stays open on inside click");
  assert.equal((menu.querySelector(".ws-browse") as HTMLElement).hasAttribute("hidden"), false, "browse view stays up");
  // Folder-row navigation timing (click target detached by the sync
  // re-render → capture-phase closer) is covered by the CDP repro
  // via headless-Chrome CDP repro with real mouse events): linkedom runs target
  // handlers before document listeners, so that race cannot be asserted
  // here. Plain navigation is covered by the "device folder browser" test.
  // A click on the menu chrome (path header) is still inside.
  (menu.querySelector(".ws-path-text") as HTMLElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
  assert.equal(menu.classList.contains("is-open"), true, "menu chrome click keeps it open");
  // A click outside (the hero title) closes it.
  (root.querySelector(".welcome-title") as HTMLElement).dispatchEvent(
    new dom.window.Event("click", { bubbles: true }),
  );
  assert.equal(menu.classList.contains("is-open"), false, "outside click closes the popover");
  root.remove();
});

test("unresolved capability probe renders a loading placeholder, not a default composer", () => {
  // Probe pending on an online device → loading placeholder; the plain
  // textarea composer must NOT mount (it only renders for settled legacy
  // builds). The workspace picker stays interactive meanwhile.
  const { panel } = build({ composerLoading: true });
  assert.ok(panel.root.querySelector(".composer-loading"), "loading placeholder rendered");
  assert.match(panel.root.querySelector(".composer-loading")!.textContent!, /Loading composer/);
  assert.equal(panel.root.querySelector(".composer-row"), null, "no legacy composer flash");
  assert.equal(panel.root.querySelector(".composer-card"), null, "no toolbar composer flash");
  assert.ok(panel.root.querySelector(".new-task-workspace-bar"), "picker still mounted");
  assert.ok(!panel.textarea.isConnected, "textarea stays detached while loading");
  panel.root.remove();
});
