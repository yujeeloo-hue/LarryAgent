import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { createAskUserPanel } from "./AskUserPanelView.js";
import { createAskUserAnswerView } from "../../../../../shared/askUserPanel.js";
import type { UserAskAnswer } from "../../../../../shared/askUser.js";

const dom = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document: dom.document });
const events = dom.window.Event;
function select(panel: HTMLElement, label: string, checked = true) {
  const choice = [...panel.querySelectorAll<HTMLInputElement>("input[data-option]")].find(input => input.value === label)!;
  choice.checked = checked; choice.dispatchEvent(new events("change"));
}
function write(panel: HTMLElement, text: string) {
  const field = panel.querySelector("textarea")!;
  field.value = text; field.dispatchEvent(new events("input"));
  return field;
}
function confirm(panel: HTMLElement) { return panel.querySelector<HTMLButtonElement>(".content-card-ask-user-confirm")!; }
function key(field: HTMLTextAreaElement, properties: Record<string, unknown>) {
  const event = new events("keydown", { cancelable: true });
  Object.assign(event, { key: "Enter", ...properties }); field.dispatchEvent(event);
  return event;
}

test("single choice waits for confirmation and sends multiline details once", () => {
  const answers: UserAskAnswer[] = [];
  const panel = createAskUserPanel({ question: "Scope?", options: ["Preview", "Build"], allowCustom: true,
    optionDetails: [{ label: "Preview", description: "Review first", recommended: true }], onAnswer: a => answers.push(a) });
  assert.equal(confirm(panel).disabled, true);
  assert.match(panel.textContent!, /Review first/);
  select(panel, "Preview");
  assert.equal(answers.length, 0);
  assert.match(panel.textContent!, /Additional details/);
  const field = write(panel, "No deployment.\nKeep drafts.");
  key(field, {}); assert.equal(answers.length, 0, "plain Enter is a newline");
  key(field, { ctrlKey: true, isComposing: true }); assert.equal(answers.length, 0);
  key(field, { metaKey: true, keyCode: 229 }); assert.equal(answers.length, 0);
  key(field, { ctrlKey: true });
  assert.deepEqual(answers, [{ selected: "Preview", custom: false, comment: "No deployment.\nKeep drafts." }]);
  confirm(panel).click(); assert.equal(answers.length, 1);
  assert.equal(field.disabled, true);
});

test("custom mode and remount preserve drafts and restore selections", () => {
  const answers: UserAskAnswer[] = [];
  const input = { question: "Scope?", options: ["Preview", "Build"], allowCustom: true, draftKey: "draft-test", onAnswer: (a: UserAskAnswer) => answers.push(a) };
  const panel = createAskUserPanel(input);
  select(panel, "Build"); write(panel, "A different approach\nWith notes");
  const remounted = createAskUserPanel(input);
  assert.equal(remounted.querySelector<HTMLInputElement>('input[value="Build"]')!.checked, true);
  remounted.querySelector<HTMLButtonElement>(".content-card-ask-user-use-custom")!.click();
  assert.equal(remounted.querySelector("textarea")!.value, "A different approach\nWith notes");
  confirm(remounted).click();
  assert.deepEqual(answers, [{ selected: "A different approach\nWith notes", custom: true }]);
  const fresh = createAskUserPanel(input);
  assert.equal(fresh.querySelector("textarea")!.value, "");
});

test("multiple choice preserves option order and does not split labels containing commas", () => {
  const answers: UserAskAnswer[] = [];
  const panel = createAskUserPanel({ question: "Pick", options: ["A, B", "C"], allowCustom: true, allowMultiple: true, onAnswer: a => answers.push(a) });
  select(panel, "C"); select(panel, "A, B");
  write(panel, "Include both"); confirm(panel).click();
  assert.deepEqual(answers, [{ selected: "A, B, C", selections: ["A, B", "C"], custom: false, comment: "Include both" }]);
});

test("free response rejects blank input; restricted synthetic asks have no custom editor", () => {
  const answers: UserAskAnswer[] = [];
  const panel = createAskUserPanel({ question: "Explain", options: [], allowCustom: false, onAnswer: a => answers.push(a) });
  write(panel, "  \n "); assert.equal(confirm(panel).disabled, true);
  const field = write(panel, "Two\nlines"); key(field, { metaKey: true });
  assert.deepEqual(answers, [{ selected: "Two\nlines", custom: true }]);
  assert.equal(createAskUserPanel({ question: "Permission?", options: ["Enable", "Deny"], allowCustom: false, onAnswer: () => {} }).querySelector("textarea"), null);
});

test("settled answers render readable text safely; historical result text remains supported", () => {
  const view = createAskUserAnswerView(JSON.stringify({ selected_options: ["<b>Preview</b>"], custom_answer: null, comment: "One\nTwo" }), "Scope?")!;
  assert.match(view.textContent!, /Scope\?/);
  assert.match(view.textContent!, /One\nTwo/);
  assert.equal(view.querySelector("b"), null);
  assert.equal(createAskUserAnswerView("Selected: Preview"), null);
});
