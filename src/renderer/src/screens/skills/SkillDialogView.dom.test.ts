import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
(Module as unknown as { _extensions: Record<string, (module: { exports: unknown }) => void> })._extensions[".svg"] = (module) => { module.exports = ""; };
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  Event: dom.window.Event,
  EventTarget: dom.window.EventTarget,
});
let api: typeof import("./SkillDialogView.js");
test.before(async () => { api = await import("./SkillDialogView.js"); });

const openMenu = (): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>(".app-dropdown-menu")].find((menu) => !menu.hidden);
const optionLabels = (): (string | null | undefined)[] =>
  [...(openMenu()?.querySelectorAll(".app-dropdown-option-label") ?? [])].map((el) => el.textContent);
const openPicker = (dialog: HTMLElement): void => {
  dialog.querySelector<HTMLButtonElement>(".skill-dialog-project .app-dropdown-btn")!.click();
};
const pick = (label: string): void => {
  const menu = openMenu();
  assert.ok(menu, "project menu is open");
  const row = [...menu!.querySelectorAll<HTMLElement>(".app-dropdown-option")]
    .find((option) => option.querySelector(".app-dropdown-option-label")?.textContent === label);
  assert.ok(row, `option ${label}`);
  row!.click();
};
const fill = (dialog: HTMLElement): void => {
  dialog.querySelector<HTMLInputElement>(".skill-dialog-input")!.value = "jellybot-skill";
  dialog.querySelector<HTMLTextAreaElement>(".skill-dialog-textarea")!.value = "Explains the flow.";
};
const submit = (dialog: HTMLElement): void => {
  dialog.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

test.beforeEach(() => { document.body.replaceChildren(); });

test("workspace choices show the project name and store the slug", async () => {
  const pending = api.showSkillDialog({
    projectOptions: [
      { value: "dailywork", label: "DailyWork" },
      { value: "jellybot", label: "JellyBot" },
    ],
  });
  const dialog = document.querySelector<HTMLElement>(".skill-dialog")!;
  assert.ok(dialog, "dialog is mounted");
  openPicker(dialog);
  assert.deepEqual(optionLabels(), ["Universal", "DailyWork", "JellyBot"]);
  pick("JellyBot");
  assert.equal(
    dialog.querySelector(".app-dropdown-value")?.textContent,
    "JellyBot",
    "trigger shows the workspace name",
  );
  fill(dialog);
  submit(dialog);
  const draft = await pending;
  assert.equal(draft?.project, "jellybot", "the draft carries the slug, not the label");
  assert.equal(draft?.name, "jellybot-skill");
});

test("plain slug options stay label-as-slug (site preview shape)", async () => {
  const pending = api.showSkillDialog({ projectOptions: ["sample-project"] });
  const dialog = document.querySelector<HTMLElement>(".skill-dialog")!;
  openPicker(dialog);
  assert.deepEqual(optionLabels(), ["Universal", "sample-project"]);
  pick("sample-project");
  fill(dialog);
  submit(dialog);
  assert.equal((await pending)?.project, "sample-project");
});

test("a skill bound to an unknown project keeps that project selectable", async () => {
  const pending = api.showSkillDialog({
    project: "renamed-project",
    projectOptions: [{ value: "jellybot", label: "JellyBot" }],
  });
  const dialog = document.querySelector<HTMLElement>(".skill-dialog")!;
  openPicker(dialog);
  assert.deepEqual(optionLabels(), ["Universal", "renamed-project", "JellyBot"]);
  pick("JellyBot");
  fill(dialog);
  submit(dialog);
  assert.equal((await pending)?.project, "jellybot");
});
