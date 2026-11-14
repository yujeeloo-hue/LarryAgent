import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document: dom.document, window: dom.window });
const extensions = (Module as unknown as { _extensions: Record<string, (module: { exports: unknown }, filename: string) => void> })._extensions;
extensions[".css"] = () => {};
extensions[".svg"] = (module, filename) => { module.exports = `data:image/svg+xml,${encodeURIComponent(readFileSync(filename, "utf8"))}`; };

let GraphsView: typeof import("../screens/graphs/GraphsView.js")["GraphsView"];
let SkillsView: typeof import("../screens/skills/SkillsView.js")["SkillsView"];
test.before(async () => {
  ({ GraphsView } = await import("../screens/graphs/GraphsView.js"));
  ({ SkillsView } = await import("../screens/skills/SkillsView.js"));
});

const graph = { id: "custom", name: "Code review", updatedAt: Date.now(), enabled: true, origin: "user" as const, color: "#ff0000" };
const skill = { id: "review", name: "code-review", description: "Review changes", body: "<script>unsafe()</script>\n## Instructions", fileCount: 2, enabled: true, originLabel: "Auto", project: "", projectLabel: "Universal", usage: "Used 3× · last 2d ago · 67% success", deprecated: false };

test("graph header, templates and custom-row actions preserve their independent callbacks", () => {
  const view = new GraphsView();
  const calls: unknown[] = [];
  view.setOnCreate(() => calls.push("create"));
  view.setOnFork(mode => calls.push(mode));
  view.setOnOpen(id => calls.push(["open", id]));
  view.setOnDelete(id => calls.push(["delete", id]));
  view.setOnToggleEnabled((id, enabled) => calls.push([id, enabled]));
  view.setTemplates([
    { mode: "react", label: "Auto", description: "Loop" },
    { mode: "react_v2", label: "Auto V2", description: "Review" },
  ]);
  view.setGraphs([graph]);
  view.root.querySelector<HTMLButtonElement>(".graphs-header button")!.click();
  view.root.querySelectorAll<HTMLButtonElement>(".graphs-template-fork")[1]!.click();
  view.root.querySelector<HTMLButtonElement>(".graphs-row-main")!.click();
  const toggle = view.root.querySelector<HTMLInputElement>("[role=switch]")!;
  toggle.checked = false;
  toggle.dispatchEvent(new dom.window.Event("change"));
  assert.equal(toggle.checked, true, "show the persisted value until the controller reloads");
  view.root.querySelector<HTMLButtonElement>(".graphs-row-delete")!.click();
  assert.deepEqual(calls, ["create", "react_v2", ["open", "custom"], ["custom", false], ["delete", "custom"]]);
  const icons = view.root.querySelectorAll<HTMLImageElement>(".graphs-template-icon img");
  assert.equal(icons[0]!.src, icons[1]!.src);
  assert.ok(view.root.querySelector(".graphs-row .library-icon-badge .app-mono-icon"));
});

test("graph controls remain disabled through a reload and recover with empty state", () => {
  const view = new GraphsView();
  view.setBusy(true);
  view.setTemplates([{ mode: "ask", label: "Ask", description: "" }]);
  view.setGraphs([graph]);
  assert.ok([...view.root.querySelectorAll<HTMLInputElement>("button, input")].every(control => control.disabled));
  view.setGraphs([]);
  view.setBusy(false);
  assert.equal(view.root.querySelector(".graphs-list-titles .graphs-count")!.textContent, "0");
  assert.equal(view.root.querySelector(".graphs-empty")!.textContent, "No custom graphs yet. Fork a template or create a new graph.");
  assert.ok([...view.root.querySelectorAll<HTMLInputElement>("button, input")].every(control => !control.disabled));
});

test("skill search and relocated header and row controls keep their callbacks while busy", () => {
  const view = new SkillsView();
  const calls: unknown[] = [];
  view.setOnAdd(() => calls.push("add"));
  view.setOnInstallZip(() => calls.push("install"));
  view.setOnEdit(id => calls.push(["edit", id]));
  view.setOnRemove(id => calls.push(["delete", id]));
  view.setOnQueryChange(query => calls.push(query));
  view.setOnToggle((id, enabled) => calls.push([id, enabled]));
  view.setOnHistory(id => calls.push(["history", id]));
  view.setOnDeprecate((id, deprecated) => calls.push(["deprecate", id, deprecated]));
  view.setSkills([skill]);
  const actions = view.root.querySelectorAll<HTMLButtonElement>(".skills-header-actions button");
  actions[0]!.click(); actions[1]!.click();
  const search = view.root.querySelector<HTMLInputElement>("input[type=search]")!;
  search.value = "review";
  search.dispatchEvent(new dom.window.Event("input"));
  view.root.querySelector<HTMLButtonElement>(".skills-card-expand-btn")!.click();
  const rowActions = view.root.querySelectorAll<HTMLButtonElement>(".skills-detail-actions .tools-mcp-icon-btn");
  for (const button of rowActions) button.click();
  const toggle = view.root.querySelector<HTMLInputElement>("[role=switch]")!;
  toggle.checked = false;
  toggle.dispatchEvent(new dom.window.Event("change"));
  assert.equal(toggle.checked, true);
  assert.deepEqual(calls, ["install", "add", "review", ["edit", "review"], ["history", "review"], ["deprecate", "review", true], ["delete", "review"], ["review", false]]);
  assert.equal(view.root.querySelector(".skills-origin-badge")!.textContent, "Auto");
  assert.equal(view.root.querySelector(".skills-card-usage")!.textContent, skill.usage);
  view.setBusy(true);
  view.setSkills([{ ...skill, enabled: false }]);
  assert.ok([...view.root.querySelectorAll<HTMLInputElement>("button, input")].every(control => control.disabled));
  view.setBusy(false);
  assert.equal(view.root.querySelector<HTMLInputElement>("[role=switch]")!.checked, false);
});

test("skill details remain safe text and retain expansion after updating the list", () => {
  const view = new SkillsView();
  view.setSkills([skill]);
  view.root.querySelector<HTMLButtonElement>(".skills-card-expand-btn")!.click();
  view.setSkills([{ ...skill, fileCount: 3 }]);
  assert.equal(view.root.querySelector<HTMLButtonElement>(".skills-card-expand-btn")!.getAttribute("aria-expanded"), "true");
  assert.equal(view.root.querySelector<HTMLElement>(".skills-card-details")!.hidden, false);
  assert.equal(view.root.querySelector(".skills-card-body")!.textContent, skill.body);
  assert.equal(view.root.querySelector("script"), null);
  assert.equal(view.root.querySelector(".skills-card-files-meta")!.textContent, "Supporting files: 3");
});

test("deprecated skills sit in a collapsed section with Reactivate and no enable switch", () => {
  const view = new SkillsView();
  const calls: unknown[] = [];
  view.setOnDeprecate((id, deprecated) => calls.push([id, deprecated]));
  view.setSkills([]);
  view.setDeprecated([{ ...skill, deprecated: true, enabled: false, supersededByName: "review-v2" }]);
  const section = view.root.querySelector<HTMLElement>(".skills-deprecated-section")!;
  assert.equal(section.hidden, false);
  const list = section.querySelector<HTMLElement>(".tools-mcp-list")!;
  assert.equal(list.hidden, true);
  section.querySelector<HTMLButtonElement>(".skills-section-toggle")!.click();
  assert.equal(list.hidden, false);
  assert.equal(section.querySelector("[role=switch]"), null);
  assert.equal(section.querySelector(".skills-superseded")!.textContent, "→ review-v2");
  section.querySelector<HTMLButtonElement>('[aria-label^="Reactivate "]')!.click();
  assert.deepEqual(calls, [["review", false]]);
  view.setDeprecated([]);
  assert.equal(section.hidden, true);
});

test("suggestions resolve through callbacks and stale ones cannot be accepted", () => {
  const view = new SkillsView();
  const calls: unknown[] = [];
  view.setOnResolveSuggestion((id, decision) => calls.push([id, decision]));
  view.setSuggestions([
    { id: "p1", title: "Edit · code-review", reason: "fix step", meta: "Auto · 1h ago", stale: false, changes: [{ name: "code-review", diff: [{ kind: "add", text: "new line", oldLine: null, newLine: 1 }] }] },
    { id: "p2", title: "Merge · a, b", reason: "dupes", meta: "Auto · 2h ago", stale: true, changes: [] },
  ]);
  const cards = view.root.querySelectorAll<HTMLElement>(".skills-suggestion");
  assert.equal(cards.length, 2);
  cards[0]!.querySelector<HTMLButtonElement>('[aria-label^="Apply "]')!.click();
  cards[1]!.querySelector<HTMLButtonElement>('[aria-label^="Dismiss "]')!.click();
  assert.deepEqual(calls, [["p1", "accept"], ["p2", "reject"]]);
  assert.equal(cards[1]!.querySelector<HTMLButtonElement>('[aria-label^="Apply "]')!.disabled, true);
  assert.ok(cards[1]!.querySelector(".skills-stale-badge"));
  view.setBusy(true);
  view.setBusy(false);
  assert.equal(cards[1]!.querySelector<HTMLButtonElement>('[aria-label^="Apply "]')!.disabled, true, "stale accept stays disabled after busy");
});
