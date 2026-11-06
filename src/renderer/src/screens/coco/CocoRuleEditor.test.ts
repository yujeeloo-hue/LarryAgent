import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { CocoRule, CocoSnapshot } from "../../../../coco/types.js";
import { defaultSettings, validateRule } from "../../../../coco/validation.js";
import { installSelectPopups } from "../../ui/selectPopup.js";
import { ruleEditor } from "./CocoRuleEditor.js";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window, Event: dom.window.Event });
// Supply the select API that linkedom omits; the editor and shared popup stay real.
Object.defineProperties(dom.window.HTMLSelectElement.prototype, {
  value: {
    configurable: true,
    get(this: HTMLSelectElement) { return this.selectedOptions[0]?.value ?? ""; },
    set(this: HTMLSelectElement, next: string) { for (const option of this.options) { if (option.value === next) option.setAttribute("selected", ""); else option.removeAttribute("selected"); } },
  },
  selectedOptions: {
    configurable: true,
    get(this: HTMLSelectElement) { const options = [...this.options], selected = options.filter(option => option.selected); return selected.length ? selected : options.slice(0, 1); },
  },
});
const snapshot = (): CocoSnapshot => ({ settings: defaultSettings(), state: "idle", budget: { hourly: 0, daily: 0, estimated: false }, work: [], rules: [], messages: [], reports: [], verifications: [], attempts: [], legacyRuns: [], workspaces: [{ id: "app", name: "Larry Agent" }, { id: "relay", name: "Relay" }] });
const existing = (): CocoRule => ({ id: "rule", createdAt: 123, nextRunAt: 456, name: "Review progress", objective: "Review unfinished work", mode: "inspection", enabled: true, confirmed: true, fullPermissions: true, providerId: "reasoning", reasoningEffort: "high", runMode: "ask", scope: { all: true, workspaceIds: ["app"], excludedWorkspaceIds: ["relay"] }, cadence: { kind: "week", time: "09:30", weekdays: [1, 3, 5] }, acceptance: [{ id: "review", kind: "review", description: "Reference evidence" }, { id: "file", kind: "file_exists", description: "File exists: reports/review.md", path: "reports/review.md" }] });
const select = (form: HTMLElement, label: string): HTMLSelectElement => form.querySelector<HTMLSelectElement>(`select[aria-label="${label}"]`)!;
const changed = (select: HTMLSelectElement, value: string): void => { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); };
const flush = async (): Promise<void> => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const submit = async (form: HTMLElement): Promise<void> => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await flush(); };

test.beforeEach(() => {
  document.body.replaceChildren();
  window.jellybot = { getWorkspaceSettings: async () => ({ providers: [{ id: "reasoning", name: "Reasoning", modelId: "review-model" }] }) } as any;
});

for (const theme of ["dark", "light"]) {
  test(`${theme}: all four editor selects open the shared app popup and keep field changes`, () => {
    document.documentElement.dataset.theme = theme;
    const form = ruleEditor(snapshot(), undefined, async () => {}, () => {});
    document.body.append(form);
    const dispose = installSelectPopups(document);
    try {
      assert.equal(form.querySelectorAll("select").length, 4);
      for (const control of form.querySelectorAll<HTMLSelectElement>("select")) {
        const event = new Event("pointerdown", { bubbles: true, cancelable: true });
        control.dispatchEvent(event);
        assert.equal(event.defaultPrevented, true, control.getAttribute("aria-label")!);
        const menu = document.querySelector<HTMLElement>(".app-select-popup")!;
        assert.equal(menu.getAttribute("aria-label"), control.getAttribute("aria-label"));
        menu.querySelectorAll<HTMLElement>("[role=option]")[0]!.click();
        assert.equal(document.querySelector(".app-select-popup"), null);
      }
      changed(select(form, "Rule type"), "inspection");
      assert.equal(select(form, "Schedule").value, "minute");
      assert.equal(form.querySelector<HTMLInputElement>('input[type="number"]')!.value, String(snapshot().settings.heartbeatMinutes));
    } finally { dispose(); }
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
  const form = ruleEditor(snapshot(), existing(), async () => {}, () => {}), provider = select(form, "Model");
  let changes = 0; provider.addEventListener("change", () => { changes++; });
  changed(provider, "");
  resolveSettings({ providers: [{ id: "reasoning", name: "Reasoning", modelId: "review-model" }] }); await flush();
  assert.equal(provider.value, "");
  assert.equal(changes, 1);
  assert.equal(form.querySelectorAll(".coco-rule-disclosure-meta")[1]!.textContent, "Default model · Read only");
});

test("all schedule types save with hidden numeric fields disabled", async () => {
  for (const kind of ["minute", "hour", "day", "week", "month", "year"]) {
    let saved: CocoRule | undefined;
    const form = ruleEditor(snapshot(), existing(), async value => { saved = validateRule(value); }, () => {});
    changed(select(form, "Schedule"), kind);
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
