import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { CocoRule, CocoSnapshot } from "../../../../coco/types.js";
import { defaultSettings, validateRule } from "../../../../coco/validation.js";

// AppDropdown imports its stylesheet, which only Vite can resolve.
(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
const dom = parseHTML("<!doctype html><html><body></body></html>");
// AppDropdown extends EventTarget and dispatches `change` on the instance, so
// Event and EventTarget must share the linkedom realm — and the editor must be
// imported *after* those globals exist (the class captures EventTarget). The
// runner compiles to CJS, so this cannot be a top-level await.
Object.assign(globalThis, { document: dom.document, window: dom.window, Event: dom.window.Event, EventTarget: dom.window.EventTarget });
let ruleEditor: (typeof import("./CocoRuleEditor.js"))["ruleEditor"];
test.before(async () => { ({ ruleEditor } = await import("./CocoRuleEditor.js")); });

const snapshot = (): CocoSnapshot => ({ settings: defaultSettings(), state: "idle", budget: { hourly: 0, daily: 0, estimated: false }, work: [], rules: [], messages: [], reports: [], verifications: [], attempts: [], legacyRuns: [], workspaces: [{ id: "app", name: "Larry Agent" }, { id: "relay", name: "Relay" }] });
const existing = (): CocoRule => ({ id: "rule", createdAt: 123, nextRunAt: 456, name: "Review progress", objective: "Review unfinished work", mode: "inspection", enabled: true, confirmed: true, fullPermissions: true, providerId: "reasoning", reasoningEffort: "high", runMode: "ask", scope: { all: true, workspaceIds: ["app"], excludedWorkspaceIds: ["relay"] }, cadence: { kind: "week", time: "09:30", weekdays: [1, 3, 5] }, acceptance: [{ id: "review", kind: "review", description: "Reference evidence" }, { id: "file", kind: "file_exists", description: "File exists: reports/review.md", path: "reports/review.md" }] });
const KIND_LABELS: Record<string, string> = { minute: "Every N minutes", hour: "Hourly", day: "Daily", week: "Weekly", month: "Monthly", year: "Yearly" };

const dropdownRoot = (form: HTMLElement, label: string): HTMLElement => {
  const found = [...form.querySelectorAll<HTMLElement>(".app-dropdown")].find(root => root.querySelector(".app-dropdown-btn")?.getAttribute("aria-label") === label);
  assert.ok(found, `dropdown ${label}`);
  return found!;
};
const shown = (form: HTMLElement, label: string): string | null | undefined =>
  dropdownRoot(form, label).querySelector(".app-dropdown-value")?.textContent;
const openMenu = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".app-dropdown-menu")].find(menu => !menu.hidden);
const choose = (form: HTMLElement, label: string, optionLabel: string): void => {
  dropdownRoot(form, label).querySelector<HTMLButtonElement>(".app-dropdown-btn")!.click();
  const menu = openMenu();
  assert.ok(menu, `menu for ${label}`);
  const row = [...menu!.querySelectorAll<HTMLElement>(".app-dropdown-option")].find(option => option.querySelector(".app-dropdown-option-label")?.textContent === optionLabel);
  assert.ok(row, `option ${optionLabel} in ${label}`);
  row!.click();
};
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const submit = async (form: HTMLElement): Promise<void> => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush(); };

test.beforeEach(() => {
  document.body.replaceChildren();
  window.jellybot = { getWorkspaceSettings: async () => ({ providers: [{ id: "reasoning", name: "Reasoning", modelId: "review-model" }] }) } as any;
});

for (const theme of ["dark", "light"]) {
  test(`${theme}: all four editor dropdowns open the app menu and keep field changes`, () => {
    document.documentElement.dataset.theme = theme;
    const form = ruleEditor(snapshot(), undefined, async () => {}, () => {});
    document.body.append(form);
    assert.equal(form.querySelectorAll("select").length, 0, "no native select survives");
    const roots = [...form.querySelectorAll<HTMLElement>(".app-dropdown")];
    assert.equal(roots.length, 4);
    for (const root of roots) {
      const button = root.querySelector<HTMLButtonElement>(".app-dropdown-btn")!;
      const label = button.getAttribute("aria-label")!;
      assert.ok(label, "every editor dropdown keeps an accessible name");
      // The menu is portaled to <body> while open, so count the rows first.
      const optionCount = root.querySelectorAll(".app-dropdown-option").length;
      assert.ok(optionCount > 0, `${label} offers options`);
      button.click();
      const menu = openMenu()!;
      assert.equal(menu.querySelectorAll("[role=option]").length, optionCount);
      menu.querySelector<HTMLElement>("[role=option]")!.click();
      assert.equal(openMenu(), undefined, `${label} menu closes after a pick`);
    }
    choose(form, "Rule type", "Proactive inspection");
    assert.equal(shown(form, "Schedule"), "Every N minutes");
    assert.equal(form.querySelector<HTMLInputElement>('input[type="number"]')!.value, String(snapshot().settings.heartbeatMinutes));
  });
}

test("saving collapsed settings preserves rule identity, scope, model and acceptance IDs", async () => {
  const rule = existing(); let saved: CocoRule | undefined;
  const form = ruleEditor(snapshot(), rule, async value => { saved = validateRule(value); }, () => {});
  document.body.append(form); await flush();
  assert.equal(form.querySelectorAll("details[open]").length, 0);
  assert.match(form.querySelectorAll(".coco-rule-disclosure-meta")[1]!.textContent!, /Reasoning · review-model · Read only/);
  await submit(form);
  assert.deepEqual(saved, { ...rule, nextRunAt: 0, acceptance: [{ id: "review", kind: "review", description: "Reference evidence" }, { id: "file", kind: "review", description: "File exists: reports/review.md" }] });
});

test("model summary follows a delayed menu refresh without resetting the current choice", async () => {
  let resolveSettings!: (value: { providers: Array<{ id: string; name: string; modelId: string }> }) => void;
  window.jellybot = { getWorkspaceSettings: () => new Promise(resolve => { resolveSettings = resolve; }) } as any;
  const form = ruleEditor(snapshot(), existing(), async () => {}, () => {});
  document.body.append(form);
  choose(form, "Model", "Use CoCo default model");
  assert.equal(shown(form, "Model"), "Use CoCo default model");
  resolveSettings({ providers: [{ id: "reasoning", name: "Reasoning", modelId: "review-model" }] }); await flush();
  assert.equal(shown(form, "Model"), "Use CoCo default model", "the refresh keeps the chosen default");
  assert.equal(form.querySelectorAll(".coco-rule-disclosure-meta")[1]!.textContent, "Default model · Read only");
});

test("all schedule types save with hidden numeric fields disabled", async () => {
  for (const kind of ["minute", "hour", "day", "week", "month", "year"]) {
    let saved: CocoRule | undefined;
    const form = ruleEditor(snapshot(), existing(), async value => { saved = validateRule(value); }, () => {});
    choose(form, "Schedule", KIND_LABELS[kind]!);
    for (const field of form.querySelectorAll<HTMLElement>(".coco-rule-grid>.coco-field[hidden]")) {
      for (const input of field.querySelectorAll<HTMLInputElement>("input")) assert.equal(input.disabled, true);
    }
    await submit(form);
    assert.equal(saved?.cadence.kind, kind);
  }
});

test("save errors remain visible in the footer and allow retry without losing edits", async () => {
  let calls = 0;
  const form = ruleEditor(snapshot(), existing(), async () => { if (++calls === 1) throw new Error("Save failed"); }, () => {});
  const name = form.querySelector<HTMLInputElement>('input[type="text"]')!; name.value = "Keep this edit";
  await submit(form);
  assert.match(form.querySelector(".coco-rule-footer [role=alert]")!.textContent!, /Save failed/);
  assert.equal(form.querySelector<HTMLButtonElement>(".coco-rule-footer .primary")!.disabled, false);
  await submit(form);
  assert.equal(calls, 2);
  assert.equal(name.value, "Keep this edit");
  assert.equal(form.querySelector(".coco-rule-footer [role=alert]")!.textContent, "");
});
