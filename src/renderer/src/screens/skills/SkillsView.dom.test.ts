import Module from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHTML } from "linkedom";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

const extensions = (Module as unknown as {
  _extensions: Record<string, (module: { exports: unknown }, path: string) => void>;
})._extensions;
extensions[".css"] = () => {};
extensions[".svg"] = (module) => { module.exports = ""; };
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document, window: dom.window, HTMLElement: dom.HTMLElement, Event: dom.window.Event,
});
let api: typeof import("./SkillsView.js");
before(async () => { api = await import("./SkillsView.js"); });
function row(overrides: Partial<import("./SkillsView.js").SkillsRow> & { id: string; name: string }) {
  return {
    enabled: true, description: `${overrides.name} description`, body: "# Instructions\n\nVerify the result.",
    fileCount: 2, originLabel: "User", projectLabel: "Universal", project: "", usage: "Used 4×",
    deprecated: false, ...overrides,
  };
}
const ROWS = [
  row({ id: "1", name: "jellybot-package", project: "jellybot", projectLabel: "JellyBot" }),
  row({ id: "2", name: "zsh-equals-expansion" }),
  row({ id: "3", name: "dailywork-report", project: "dailywork", projectLabel: "DailyWork" }),
  row({ id: "4", name: "jellybot-website", project: "jellybot", projectLabel: "JellyBot" }),
];
const MANY = Array.from({ length: 14 }, (_, index) => row({ id: `${index}`, name: `skill-${index}` }));
function button(view: InstanceType<typeof api.SkillsView>, selector: string) {
  const element = view.root.querySelector<HTMLButtonElement>(selector);
  assert.ok(element, `Missing button ${selector}`);
  return element;
}
function ids(view: InstanceType<typeof api.SkillsView>) {
  return [...view.root.querySelectorAll<HTMLElement>(".skills-installed-list > .skills-card")].map(el => el.dataset.skillId);
}
function suggestion(id: string, stale = false): import("./SkillsView.js").SkillSuggestionRow {
  return { id, title: `Update ${id}`, reason: "Add a missing verification step.", meta: "Auto · 1h ago", stale, changes: [{ name: "SKILL.md", diff: [] }] };
}

describe("SkillsView library", () => {
  it("shares Tools navigation, groups projects and keeps the library in one card", () => {
    const view = new api.SkillsView(); view.setSkills(ROWS);
    assert.deepEqual([...view.root.querySelectorAll(".tools-category-label")].map(el => el.textContent), ["All skills", "Universal", "DailyWork", "JellyBot"]);
    assert.deepEqual([...view.root.querySelectorAll(".tools-category-count")].map(el => el.textContent), ["4", "1", "1", "2"]);
    assert.deepEqual([...view.root.querySelectorAll(".tools-category-group")].map(el => el.textContent), ["Library", "Projects"]);
    assert.equal(view.root.querySelectorAll(".tools-category-artwork").length, 4);
    const library = view.root.querySelector(".skills-library")!;
    assert.ok(library.contains(view.root.querySelector(".skills-library-tabs")));
    assert.ok(library.contains(view.root.querySelector(".skills-installed-list")));
    assert.equal(view.root.querySelector(".skills-pagination"), null);
    assert.equal(view.root.querySelector(".screen-subtitle")?.textContent, "Manage your agent’s skills.");
  });

  it("renders every skill in one list without pagination controls", () => {
    const view = new api.SkillsView(); view.setSkills(MANY);
    assert.deepEqual(ids(view), MANY.map(row => row.id));
    view.setBusy(true); view.setBusy(false);
    assert.deepEqual(ids(view), MANY.map(row => row.id));
    assert.equal(view.root.querySelectorAll('[aria-label$="page"]').length, 0);
  });

  it("keeps project selection and global counts while search returns no rows", () => {
    const view = new api.SkillsView(); view.setSkills(ROWS);
    button(view, '[data-scope="jellybot"]').click();
    assert.deepEqual(ids(view), ["1", "4"]);
    view.setSkills([], { allSkills: ROWS, emptyMessage: "No matches." });
    assert.equal(button(view, '[data-scope="jellybot"]').getAttribute("aria-selected"), "true");
    assert.equal(view.root.querySelector('.skills-installed-list .tools-mcp-empty')?.textContent, "No skills in this scope.");
    assert.equal(view.root.querySelector('.skills-library-tab .skills-count')?.textContent, "4");
    assert.equal(view.root.querySelector('[data-scope="jellybot"] .tools-category-count')?.textContent, "2");
    view.setSkills(ROWS, { allSkills: ROWS }); assert.deepEqual(ids(view), ["1", "4"]);
    view.setSkills(ROWS.filter(row => row.project !== "jellybot"));
    assert.equal(button(view, '[data-scope="*"]').getAttribute("aria-selected"), "true");
  });

  it("reports the search query through the existing callback and shows only matches", () => {
    const view = new api.SkillsView(); view.setSkills(MANY);
    let query = "";
    view.setOnQueryChange(value => { query = value; view.setSkills([MANY[0]!], { allSkills: MANY }); });
    const search = view.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    search.value = "skill-0"; search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(query, "skill-0"); assert.deepEqual(ids(view), ["0"]);
  });

  it("keeps the usage meta inline on the name row with no extra wording", () => {
    const view = new api.SkillsView();
    view.setSkills([
      row({ id: "good", name: "good-skill", uses: 23, successRate: 95 }),
      row({ id: "warn", name: "warn-skill", uses: 8, successRate: 74 }),
      row({ id: "bad", name: "bad-skill", uses: 5, successRate: 40 }),
      row({ id: "unfinished", name: "unfinished-skill", uses: 2, successRate: null }),
      row({ id: "unknown", name: "unknown-skill" }),
    ]);
    const meta = (id: string) => view.root.querySelector<HTMLElement>(`[data-skill-id="${id}"] .skills-card-rate`);
    assert.equal(meta("good")?.textContent, "Used 23× · 95%");
    assert.ok(meta("good")?.closest(".skills-card-name-row"));
    assert.equal(view.root.querySelectorAll(".skills-card-info > .skills-card-rate").length, 0);
    assert.ok(meta("good")?.querySelector(".skills-card-rate-value")?.classList.contains("is-good"));
    assert.ok(meta("warn")?.querySelector(".skills-card-rate-value")?.classList.contains("is-warn"));
    assert.ok(meta("bad")?.querySelector(".skills-card-rate-value")?.classList.contains("is-bad"));
    assert.equal(meta("unfinished")?.textContent, "Used 2×");
    assert.equal(meta("unknown"), null);
    assert.equal(view.root.querySelector(".skills-rate-tag"), null);
  });

  it("preserves expanded content and all management callbacks through refresh and search", () => {
    const view = new api.SkillsView(); view.setSkills(ROWS);
    const calls: string[] = [];
    view.setOnEdit(id => calls.push(`edit:${id}`));
    view.setOnHistory(id => calls.push(`history:${id}`));
    view.setOnDeprecate((id, value) => calls.push(`deprecate:${id}:${value}`));
    view.setOnRemove(id => calls.push(`delete:${id}`));
    button(view, '[aria-label="Show details for jellybot-package"]').click();
    view.setSkills([], { allSkills: ROWS }); view.setSkills(ROWS, { allSkills: ROWS });
    const details = view.root.querySelector<HTMLElement>('[data-skill-id="1"] .skills-card-details')!;
    assert.equal(details.hidden, false); assert.ok(details.textContent?.includes("Supporting files: 2"));
    assert.equal(details.querySelector("pre")?.textContent, ROWS[0]!.body);
    button(view, '[aria-label="Edit jellybot-package"]').click();
    button(view, '[aria-label="History of jellybot-package"]').click();
    button(view, '[aria-label="Deprecate jellybot-package"]').click();
    button(view, '[aria-label="Delete jellybot-package"]').click();
    assert.deepEqual(calls, ["edit:1", "history:1", "deprecate:1:true", "delete:1"]);
  });

  it("keeps enable changes controlled by the controller until persistence succeeds", () => {
    const view = new api.SkillsView(); view.setSkills(ROWS);
    let changed: unknown;
    view.setOnToggle((id, enabled) => { changed = [id, enabled]; });
    const toggle = view.root.querySelector<HTMLInputElement>('[aria-label="Enable jellybot-package"]')!;
    toggle.checked = false; toggle.dispatchEvent(new dom.window.Event("change"));
    assert.deepEqual(changed, ["1", false]); assert.equal(toggle.checked, true);
  });

  it("shows an icon-free empty Suggestions panel and retains the selected tab after resolving", () => {
    const view = new api.SkillsView(); view.setSkills(ROWS); view.setSuggestions([suggestion("a")]);
    button(view, '.skills-library-tab[aria-controls$="suggestions-panel"]').click();
    view.setSuggestions([]);
    assert.equal((view.root.querySelector('.skills-suggestions-section') as HTMLElement).hidden, false);
    assert.equal(view.root.querySelector('.skills-suggestions-section')?.textContent, "No suggestions.");
    assert.equal(view.root.querySelector('.skills-suggestions-section svg'), null);
    button(view, '[data-scope=""]').click();
    assert.equal((view.root.querySelector('.skills-installed-panel') as HTMLElement).hidden, false);
  });

  it("keeps outdated suggestions unapplyable and diffs expanded after reload", () => {
    const view = new api.SkillsView(); view.setSuggestions([suggestion("a"), suggestion("stale", true)]);
    const calls: string[] = [];
    view.setOnResolveSuggestion((id, decision) => calls.push(`${id}:${decision}`));
    button(view, '.skills-review-changes').click();
    view.setSuggestions([suggestion("a"), suggestion("stale", true)]); view.setBusy(true); view.setBusy(false);
    assert.equal((view.root.querySelector('.skills-suggestion-diff') as HTMLElement).hidden, false);
    assert.equal(button(view, '[aria-label="Apply suggestion: Update stale"]').disabled, true);
    button(view, '[aria-label="Apply suggestion: Update a"]').click();
    button(view, '[aria-label="Dismiss suggestion: Update stale"]').click();
    assert.deepEqual(calls, ["a:accept", "stale:reject"]);
  });

  it("retains scoped deprecated skills and their reactivation action", () => {
    const view = new api.SkillsView();
    const archived = row({ id: "old", name: "old-skill", project: "old-project", projectLabel: "Old project", deprecated: true });
    view.setSkills(ROWS, { allSkills: [...ROWS, archived] }); view.setDeprecated([archived]);
    button(view, '[data-scope="old-project"]').click();
    assert.equal((view.root.querySelector('.skills-deprecated-section') as HTMLElement).hidden, false);
    button(view, '.skills-section-toggle').click();
    assert.equal((view.root.querySelector('.skills-deprecated-section .tools-mcp-list') as HTMLElement).hidden, false);
    let restored: unknown; view.setOnDeprecate((id, value) => { restored = [id, value]; });
    button(view, '[aria-label="Reactivate old-skill"]').click(); assert.deepEqual(restored, ["old", false]);
  });

  it("keeps curation progress and errors in its card without a duplicate result link", () => {
    const view = new api.SkillsView(); view.setCuration({ text: "Reviewing skills…", running: true });
    view.setBusy(true); view.setBusy(false);
    assert.equal(button(view, '.skills-curate-btn').disabled, true);
    view.setCuration({ text: "Review failed: <details>", running: false, kind: "error" });
    assert.equal(button(view, '.skills-curate-btn').disabled, false);
    assert.equal(view.root.querySelector('.skills-curation-text')?.textContent, "Review failed: <details>");
    assert.equal(view.root.querySelector('.skills-curation-state')?.textContent, "Failed");
    assert.equal(view.root.querySelector('.skills-curation a'), null);
    assert.equal(view.root.querySelectorAll('.skills-curation button').length, 1);
  });

  it("uses the final Gallery artwork with identical upper bars", () => {
    const svg = readFileSync(join(import.meta.dirname, "../../assets/skills/all-skills.svg"), "utf8");
    const bars = [...svg.matchAll(/<rect x="(?:6\.3|4\.2)"[^>]+>/g)].map(match => match[0]);
    assert.equal(bars.length, 2);
    for (const bar of bars) { assert.match(bar, /height="2\.4"/); assert.match(bar, /fill="#368cff"/); }
  });
});
