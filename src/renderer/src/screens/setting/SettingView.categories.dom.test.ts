import assert from "node:assert/strict";
import Module from "node:module";
import { before, test } from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request.includes("?raw")) return "";
  // Vite `?url` asset imports (e.g. cocoIcon svg urls) exist only after the
  // build pipeline resolves them; stub them like ?raw so node:test can load
  // the module graph. The value is only ever used as an <img src> string.
  if (request.includes("?url")) return request.slice(0, request.indexOf("?url"));
  return originalLoad.call(this, request, parent, isMain);
};
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  requestAnimationFrame: () => 0,
});
Object.assign(dom.window, { jellybot: { onRemoteStatus: () => () => {} } });
let SettingView: typeof import("./SettingView.js").SettingView;
before(async () => {
  ({ SettingView } = await import("./SettingView.js"));
});

function clickCategory(view: InstanceType<typeof SettingView>, id: string): void {
  const tab = view.root.querySelector<HTMLButtonElement>(`.setting-category-tab[data-category="${id}"]`)!;
  tab.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
}

function visibleCategories(view: InstanceType<typeof SettingView>): string[] {
  return Array.from(view.root.querySelectorAll<HTMLElement>(".setting-category-panel"))
    .filter((panel) => !panel.hidden)
    .map((panel) => panel.dataset.category!);
}

test("categories contain every setting once and keep all Composer defaults together", () => {
  const view = new SettingView();
  assert.deepEqual(
    Array.from(view.root.querySelectorAll(".setting-category-tab")).map((tab) => tab.textContent),
    ["Appearance", "Models", "Composer", "Agent", "CoCo", "Memory", "Security", "Remote Control", "Update", "Data & Backup"],
  );
  const expectedCards: Record<string, string[]> = {
    appearance: ["appearance"], models: ["providers", "vision", "completion", "imagegen"],
    composer: ["permissions"], agent: ["agent"], memory: ["user"],
    coco: ["coco"], security: ["safety"], remote: ["remote"], update: ["update"], data: ["objectstorage", "storage", "backup"],
  };
  assert.equal(view.root.querySelectorAll("[data-card]").length, 15);
  for (const [category, expected] of Object.entries(expectedCards)) {
    const panel = view.root.querySelector(`.setting-category-panel[data-category="${category}"]`)!;
    assert.deepEqual(Array.from(panel.querySelectorAll<HTMLElement>("[data-card]")).map((card) => card.dataset.card), expected);
  }
  for (const control of [view.fullPermissionsToggle, view.newTaskInfiniteToggle, view.newTaskReasoningSeg.root]) {
    assert.equal(control.closest<HTMLElement>(".setting-category-panel")!.dataset.category, "composer");
  }
  assert.deepEqual(visibleCategories(view), ["appearance"]);
  for (const id of Object.keys(expectedCards)) {
    clickCategory(view, id);
    assert.deepEqual(visibleCategories(view), [id]);
    const selected = view.root.querySelector('.setting-category-tab[aria-selected="true"]')!;
    const panel = view.root.querySelector(`#${selected.getAttribute("aria-controls")}`)!;
    assert.equal(panel.getAttribute("aria-labelledby"), selected.id);
  }
});

test("Models completion card lists every chat provider and a default option", () => {
  const view = new SettingView();
  clickCategory(view, "models");
  const card = view.root.querySelector('[data-card="completion"]')!;
  assert.match(card.textContent ?? "", /Completion/);
  assert.match(card.textContent ?? "", /Dev Mode ghost text/);
  view.setCompletionOptions(
    [
      {
        id: "fast",
        name: "Fast",
        baseUrl: "http://127.0.0.1:11434/v1",
        modelId: "coder",
        supportsMultimodal: false,
        imageInput: "url",
        rawEndpoint: false,
      },
      {
        id: "slow",
        name: "Slow",
        baseUrl: "https://api.example.com/v1",
        modelId: "reasoner",
        supportsMultimodal: true,
        imageInput: "url",
        rawEndpoint: false,
      },
    ],
    "fast",
  );
  const dropdown = view.completionProviderSelect;
  const rows = Array.from(
    dropdown.el.querySelectorAll(".app-dropdown-option"),
  );
  assert.equal(rows.length, 3);
  assert.equal(
    rows[0]?.querySelector(".app-dropdown-option-label")?.textContent,
    "Default — new-task provider",
  );
  assert.equal(dropdown.value, "fast");
  assert.equal(view.getCompletionSelectedId(), "fast");
  view.setCompletionOptions(
    [
      {
        id: "slow",
        name: "Slow",
        baseUrl: "https://api.example.com/v1",
        modelId: "reasoner",
        supportsMultimodal: true,
        imageInput: "url",
        rawEndpoint: false,
      },
    ],
    "fast",
  );
  assert.equal(view.getCompletionSelectedId(), "");
});

test("switching categories preserves form nodes, unsaved values and save listeners", () => {
  const view = new SettingView();
  clickCategory(view, "composer");
  view.newTaskInfiniteToggle.checked = true;
  view.newTaskReasoningSeg.setLevel("high");
  clickCategory(view, "models");
  const nameInput = view.nameInput;
  nameInput.value = "Draft provider";
  view.apiKeyInput.value = "draft-key";
  let edits = 0;
  nameInput.addEventListener("input", () => { edits += 1; });
  clickCategory(view, "memory");
  view.userMemoryProfileInput.value = "Draft preference";
  clickCategory(view, "agent");
  view.contextLimitInput.value = "256000";
  clickCategory(view, "models");
  assert.equal(view.root.querySelector('input[name="name"]'), nameInput);
  assert.equal(view.nameInput.value, "Draft provider");
  assert.equal(view.apiKeyInput.value, "draft-key");
  nameInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  assert.equal(edits, 1);
  assert.equal(view.userMemoryProfileInput.value, "Draft preference");
  assert.equal(view.contextLimitInput.value, "256000");
  clickCategory(view, "composer");
  assert.equal(view.newTaskInfiniteToggle.checked, true);
  assert.equal(view.newTaskReasoningSeg.getLevel(), "high");
});

test("category keyboard navigation wraps and uses a single tab stop", () => {
  const view = new SettingView();
  const press = (key: string): void => {
    const selected = view.root.querySelector('.setting-category-tab[aria-selected="true"]')!;
    const event = new dom.window.Event("keydown", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "key", { value: key });
    selected.dispatchEvent(event);
  };
  press("ArrowUp");
  assert.deepEqual(visibleCategories(view), ["data"]);
  press("ArrowDown");
  assert.deepEqual(visibleCategories(view), ["appearance"]);
  press("End");
  assert.deepEqual(visibleCategories(view), ["data"]);
  press("Home");
  press("ArrowDown");
  press("ArrowDown");
  assert.deepEqual(visibleCategories(view), ["composer"]);
  const tabs = Array.from(view.root.querySelectorAll<HTMLButtonElement>(".setting-category-tab"));
  assert.equal(tabs.filter((tab) => tab.getAttribute("tabindex") === "0").length, 1);
  assert.equal(tabs.find((tab) => tab.getAttribute("tabindex") === "0")!.dataset.category, "composer");
});

test("category navigation restores scroll and keeps every settings card expanded", () => {
  const view = new SettingView();
  const content = view.root.querySelector<HTMLElement>(".setting-content")!;
  Object.defineProperty(content, "scrollTop", { value: 0, writable: true });
  clickCategory(view, "models");
  const vision = view.root.querySelector('[data-card="vision"]')!;
  assert.equal(view.root.querySelector(".setting-card-expand-btn"), null);
  for (const card of view.root.querySelectorAll(".setting-card")) {
    assert.ok(card.querySelector(":scope > .setting-card-body"));
    assert.ok(card.querySelector(":scope > .setting-card-footer"));
  }
  content.scrollTop = 420;
  clickCategory(view, "composer");
  assert.equal(content.scrollTop, 0);
  view.setCardStatus("vision", "Check the vision provider", "error");
  clickCategory(view, "models");
  assert.equal(content.scrollTop, 420);
  const status = vision.querySelector<HTMLElement>(".setting-card-status")!;
  assert.equal(status.hidden, false);
  assert.equal(status.textContent, "Check the vision provider");
});
