import {
  Archive, ArchiveRestore, Check, ChevronDown, ChevronLeft, ChevronRight,
  Download, FilePenLine, FileText, GitMerge, History, PackagePlus, Pencil, Plus, Search, Sparkles, Trash2,
} from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import "../../ui/library.css";
import allSkillsArtwork from "../../assets/skills/all-skills.svg";
import universalArtwork from "../../assets/skills/universal.svg";
import { createToolsCategoryIcon } from "../tools/toolsCategoryIcon.js";
import type { DiffLine } from "../conversation/cards/diffTypes.js";
import { createDiffLinedFileView } from "../conversation/cards/DiffLinedFileView.js";
import "../conversation/cards/content-cards.css";
import "../tools/tools.css";
import "./skills.css";

export type SkillsRow = {
  id: string;
  name: string;
  enabled: boolean;
  description: string;
  /** Markdown body after frontmatter. */
  body: string;
  /** Supporting file count (excludes SKILL.md). */
  fileCount: number;
  originLabel: string;
  projectLabel: string;
  /** Owning project slug; empty for universal skills. */
  project: string;
  usage: string;
  /** Reads recorded in the ledger; absent when the skill has no ledger entry. */
  uses?: number;
  /** Clean-use percentage across finalized reads; null when no read is finalized yet. */
  successRate?: number | null;
  deprecated: boolean;
  supersededByName?: string;
};

export type SkillSuggestionRow = {
  id: string;
  kind?: "patch" | "update" | "merge" | "deprecate";
  title: string;
  reason: string;
  meta: string;
  stale: boolean;
  changes: { name: string; diff: DiffLine[] }[];
};

export type SkillCurationRow = {
  text: string;
  running: boolean;
  kind?: "idle" | "success" | "error";
};

type LibraryTab = "installed" | "suggestions";
let nextViewId = 0;

/** Project navigation and a flat library list; all mutations use the controller. */
export class SkillsView {
  readonly root: HTMLElement;
  private readonly viewId = `skills-${++nextViewId}`;
  private readonly searchInput: HTMLInputElement;
  private readonly nav: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly installedTab: HTMLButtonElement;
  private readonly suggestionsTab: HTMLButtonElement;
  private readonly installedSection: HTMLElement;
  private readonly suggestionsSection: HTMLElement;
  private readonly suggestionsList: HTMLElement;
  private readonly suggestionsCount: HTMLElement;
  private readonly deprecatedSection: HTMLElement;
  private readonly deprecatedToggle: HTMLButtonElement;
  private readonly deprecatedList: HTMLElement;
  private readonly deprecatedCount: HTMLElement;
  private readonly curationText: HTMLElement;
  private readonly curationState: HTMLElement;
  private readonly curateBtn: HTMLButtonElement;
  private readonly scopeTitle: HTMLElement;
  private readonly scopeDescription: HTMLElement;
  private skills: SkillsRow[] = [];
  private catalog: SkillsRow[] = [];
  private deprecatedSkills: SkillsRow[] = [];
  private scope = "*";
  private tab: LibraryTab = "installed";
  private emptyMessage = "No skills installed";
  private curationRunning = false;
  private deprecatedOpen = false;
  private busy = false;
  private readonly expandedIds = new Set<string>();
  private readonly expandedSuggestionIds = new Set<string>();
  private onQueryChange: ((query: string) => void) | null = null;
  private onAdd: (() => void) | null = null;
  private onInstallZip: (() => void) | null = null;
  private onEdit: ((id: string) => void) | null = null;
  private onRemove: ((id: string) => void) | null = null;
  private onToggle: ((id: string, enabled: boolean) => void) | null = null;
  private onHistory: ((id: string) => void) | null = null;
  private onDeprecate: ((id: string, deprecated: boolean) => void) | null = null;
  private onResolveSuggestion: ((id: string, decision: "accept" | "reject") => void) | null = null;
  private onCurateNow: (() => void) | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen tools-screen tools-nav-screen skills-screen";
    const header = document.createElement("header");
    header.className = "screen-header tools-header";
    const titles = document.createElement("div");
    titles.className = "tools-header-titles";
    titles.innerHTML = `<h1 class="screen-title">Skills</h1><p class="screen-subtitle">Manage your agent’s skills.</p>`;
    const actions = document.createElement("div");
    actions.className = "skills-header-actions";
    const install = textButton("Install ZIP", PackagePlus, "tools-mcp-add-btn skills-install-btn", () => this.onInstallZip?.());
    const add = textButton("Add skill", Plus, "tools-mcp-add-btn action-primary", () => this.onAdd?.());
    actions.append(install, add);
    header.append(titles, actions);

    const layout = document.createElement("div");
    layout.className = "tools-layout";
    this.nav = document.createElement("nav");
    this.nav.className = "tools-categories skills-categories";
    this.nav.setAttribute("aria-label", "Skill scopes");
    this.nav.setAttribute("role", "tablist");
    this.nav.setAttribute("aria-orientation", "vertical");
    this.nav.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
      const tabs = [...this.nav.querySelectorAll<HTMLButtonElement>("button")];
      const index = tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || this.busy) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
        : (index + (event.key === "ArrowDown" ? 1 : -1) + tabs.length) % tabs.length;
      tabs[next]?.click();
      this.nav.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
    });
    this.body = document.createElement("div");
    this.body.className = "tools-content skills-content";
    this.body.id = `${this.viewId}-scope-panel`;
    this.body.setAttribute("role", "tabpanel");
    this.statusEl = document.createElement("p");
    this.statusEl.className = "tools-status";
    this.statusEl.hidden = true;
    this.statusEl.setAttribute("role", "status");

    const curation = document.createElement("section");
    curation.className = "skills-curation";
    curation.setAttribute("aria-label", "Library curation");
    const curationIcon = document.createElement("span");
    curationIcon.className = "skills-curation-icon";
    curationIcon.setAttribute("aria-hidden", "true");
    curationIcon.append(createLucideIcon(Sparkles, { size: 16 }));
    const curationInfo = document.createElement("div");
    curationInfo.className = "skills-curation-info";
    const curationHeading = document.createElement("div");
    curationHeading.className = "skills-curation-heading";
    const curationTitle = document.createElement("h2");
    curationTitle.textContent = "Library curation";
    this.curationState = document.createElement("span");
    this.curationState.className = "skills-curation-state";
    curationHeading.append(curationTitle, this.curationState);
    this.curationText = document.createElement("p");
    this.curationText.className = "skills-curation-text";
    this.curationText.setAttribute("role", "status");
    curationInfo.append(curationHeading, this.curationText);
    this.curateBtn = textButton("Curate now", Sparkles, "tools-mcp-add-btn skills-install-btn skills-curate-btn", () => this.onCurateNow?.());
    curation.append(curationIcon, curationInfo, this.curateBtn);

    const library = document.createElement("section");
    library.className = "skills-library";
    library.setAttribute("aria-label", "Skill library");
    const tabs = document.createElement("div");
    tabs.className = "skills-library-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Skill library views");
    this.countEl = document.createElement("span");
    this.countEl.className = "skills-count";
    this.suggestionsCount = document.createElement("span");
    this.suggestionsCount.className = "skills-count";
    this.installedTab = textButton("Installed", Download, "skills-library-tab", () => this.selectTab("installed"));
    this.installedTab.append(this.countEl);
    this.suggestionsTab = textButton("Suggestions", Sparkles, "skills-library-tab", () => this.selectTab("suggestions"));
    this.suggestionsTab.append(this.suggestionsCount);
    for (const [button, key] of [[this.installedTab, "installed"], [this.suggestionsTab, "suggestions"]] as const) {
      button.id = `${this.viewId}-${key}-tab`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", `${this.viewId}-${key}-panel`);
      button.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key) || this.busy) return;
        event.preventDefault();
        const next = event.key === "Home" ? "installed" : event.key === "End" ? "suggestions"
          : this.tab === "installed" ? "suggestions" : "installed";
        this.selectTab(next);
        (next === "installed" ? this.installedTab : this.suggestionsTab).focus();
      });
    }
    tabs.append(this.installedTab, this.suggestionsTab);
    this.installedSection = document.createElement("div");
    this.installedSection.className = "skills-installed-panel";
    this.suggestionsSection = document.createElement("div");
    this.suggestionsSection.className = "skills-suggestions-section";
    for (const [panel, key] of [[this.installedSection, "installed"], [this.suggestionsSection, "suggestions"]] as const) {
      panel.id = `${this.viewId}-${key}-panel`;
      panel.setAttribute("role", "tabpanel");
      panel.setAttribute("aria-labelledby", `${this.viewId}-${key}-tab`);
    }
    const toolbar = document.createElement("div");
    toolbar.className = "skills-library-toolbar";
    const scopeInfo = document.createElement("div");
    this.scopeTitle = document.createElement("h2");
    this.scopeTitle.className = "skills-scope-title";
    this.scopeDescription = document.createElement("p");
    this.scopeDescription.className = "skills-scope-description";
    scopeInfo.append(this.scopeTitle, this.scopeDescription);
    const searchField = document.createElement("label");
    searchField.className = "tools-search-field";
    const searchLabel = document.createElement("span");
    searchLabel.className = "sr-only";
    searchLabel.textContent = "Search skills";
    const searchWrap = document.createElement("div");
    searchWrap.className = "tools-search-wrap";
    const searchIcon = document.createElement("span");
    searchIcon.className = "tools-search-icon";
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.append(createLucideIcon(Search, { size: 14 }));
    this.searchInput = document.createElement("input");
    this.searchInput.className = "tools-search-input";
    this.searchInput.type = "search";
    this.searchInput.placeholder = "Search skills";
    this.searchInput.autocomplete = "off";
    this.searchInput.spellcheck = false;
    this.searchInput.addEventListener("input", () => {
      this.onQueryChange?.(this.searchInput.value);
    });
    searchWrap.append(searchIcon, this.searchInput);
    searchField.append(searchLabel, searchWrap);
    toolbar.append(scopeInfo, searchField);
    this.listEl = document.createElement("div");
    this.listEl.className = "tools-mcp-list skills-installed-list";
    this.installedSection.append(toolbar, this.listEl);
    this.suggestionsList = document.createElement("div");
    this.suggestionsList.className = "tools-mcp-list";
    this.suggestionsSection.append(this.suggestionsList);

    this.deprecatedSection = document.createElement("section");
    this.deprecatedSection.className = "skills-deprecated-section";
    this.deprecatedToggle = textButton("Deprecated", ChevronDown, "skills-section-toggle", () => {
      this.deprecatedOpen = !this.deprecatedOpen;
      this.deprecatedList.hidden = !this.deprecatedOpen;
      this.deprecatedToggle.setAttribute("aria-expanded", String(this.deprecatedOpen));
    });
    this.deprecatedToggle.setAttribute("aria-expanded", "false");
    this.deprecatedCount = document.createElement("span");
    this.deprecatedCount.className = "skills-count";
    this.deprecatedToggle.append(this.deprecatedCount);
    this.deprecatedList = document.createElement("div");
    this.deprecatedList.className = "tools-mcp-list";
    this.deprecatedList.hidden = true;
    this.deprecatedSection.append(this.deprecatedToggle, this.deprecatedList);
    this.installedSection.append(this.deprecatedSection);

    library.append(tabs, this.installedSection, this.suggestionsSection);
    this.body.append(curation, this.statusEl, library);
    layout.append(this.nav, this.body);
    this.root.append(header, layout);
    this.setCuration({ text: "Not reviewed yet", running: false, kind: "idle" });
    this.setSuggestions([]);
    this.setSkills([]);
    this.selectTab("installed");
  }

  setOnHistory(handler: ((id: string) => void) | null): void {
    this.onHistory = handler;
  }

  setOnDeprecate(handler: ((id: string, deprecated: boolean) => void) | null): void {
    this.onDeprecate = handler;
  }

  setOnResolveSuggestion(
    handler: ((id: string, decision: "accept" | "reject") => void) | null,
  ): void {
    this.onResolveSuggestion = handler;
  }

  setOnCurateNow(handler: (() => void) | null): void {
    this.onCurateNow = handler;
  }

  setCuration(row: SkillCurationRow): void {
    this.curationText.textContent = row.text;
    this.curationRunning = row.running;
    this.curationState.textContent = row.running ? "Reviewing…" : row.kind === "error" ? "Failed"
      : row.kind === "idle" ? "" : "Up to date";
    this.curationState.classList.toggle("is-error", row.kind === "error");
    this.curateBtn.replaceChildren(createLucideIcon(Sparkles, { size: 14 }), document.createTextNode(row.running ? "Curating…" : "Curate now"));
    this.setBusy(this.busy);
  }

  setDeprecated(skills: SkillsRow[]): void {
    this.deprecatedSkills = skills;
    this.renderNavigation();
    this.renderLibrary();
  }

  setSuggestions(rows: SkillSuggestionRow[]): void {
    this.suggestionsCount.textContent = String(rows.length);
    const ids = new Set(rows.map((row) => row.id));
    for (const id of this.expandedSuggestionIds) if (!ids.has(id)) this.expandedSuggestionIds.delete(id);
    this.suggestionsList.replaceChildren(...rows.map((row) => this.buildSuggestion(row)));
    if (!rows.length) {
      const empty = document.createElement("p");
      empty.className = "tools-mcp-empty";
      empty.textContent = "No suggestions.";
      this.suggestionsList.append(empty);
    }
    this.setBusy(this.busy);
  }

  setOnQueryChange(handler: ((query: string) => void) | null): void {
    this.onQueryChange = handler;
  }


  setOnAdd(handler: (() => void) | null): void {
    this.onAdd = handler;
  }

  setOnInstallZip(handler: (() => void) | null): void {
    this.onInstallZip = handler;
  }

  setOnEdit(handler: ((id: string) => void) | null): void {
    this.onEdit = handler;
  }

  setOnRemove(handler: ((id: string) => void) | null): void {
    this.onRemove = handler;
  }

  setOnToggle(handler: ((id: string, enabled: boolean) => void) | null): void {
    this.onToggle = handler;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle("is-busy", busy);
    this.root.setAttribute("aria-busy", String(busy));
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach((el) => {
      el.disabled = busy;
      if (el.matches(".skills-header-actions button")) {
        el.setAttribute("aria-busy", String(busy));
      }
    });
    this.curateBtn.disabled = busy || this.curationRunning;
    this.root.querySelectorAll<HTMLButtonElement>("[data-stale-accept]").forEach((el) => {
      el.disabled = true;
    });
  }

  setStatus(message: string | null, kind: "info" | "error" = "info"): void {
    if (!message) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = "";
      this.statusEl.classList.remove("is-error");
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = message;
    this.statusEl.classList.toggle("is-error", kind === "error");
  }

  setSkills(skills: SkillsRow[], options?: { emptyMessage?: string; allSkills?: SkillsRow[] }): void {
    this.skills = skills;
    this.catalog = options?.allSkills ?? skills;
    this.emptyMessage = options?.emptyMessage ?? "No skills installed";
    const ids = new Set(this.catalog.map((skill) => skill.id));
    for (const id of this.expandedIds) if (!ids.has(id)) this.expandedIds.delete(id);
    const scopes = new Set(this.catalog.map((skill) => skill.project));
    if (this.scope !== "*" && this.scope !== "" && !scopes.has(this.scope)) this.scope = "*";
    this.renderNavigation();
    this.renderLibrary();
  }

  private selectTab(tab: LibraryTab): void {
    this.tab = tab;
    this.installedSection.hidden = tab !== "installed";
    this.suggestionsSection.hidden = tab !== "suggestions";
    for (const [button, key] of [[this.installedTab, "installed"], [this.suggestionsTab, "suggestions"]] as const) {
      button.setAttribute("aria-selected", String(tab === key));
      button.tabIndex = tab === key ? 0 : -1;
    }
  }

  private renderNavigation(): void {
    const hadFocus = this.nav.contains(document.activeElement);
    this.nav.replaceChildren();
    const allRows = new Map([...this.catalog, ...this.deprecatedSkills].map((row) => [row.id, row]));
    const rows = [...allRows.values()];
    const projects = new Map<string, string>();
    for (const row of rows) if (row.project) projects.set(row.project, row.projectLabel);
    const group = (label: string) => {
      const heading = document.createElement("p");
      heading.className = "tools-category-group";
      heading.setAttribute("role", "presentation");
      heading.textContent = label;
      this.nav.append(heading);
    };
    const entry = (scope: string, label: string, artwork: HTMLElement) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "tools-category-tab";
      button.dataset.scope = scope;
      button.id = `${this.viewId}-scope-${scope === "*" ? "all" : encodeURIComponent(scope) || "universal"}`;
      button.title = label;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(scope === this.scope));
      button.setAttribute("aria-controls", `${this.viewId}-scope-panel`);
      button.tabIndex = scope === this.scope ? 0 : -1;
      const text = document.createElement("span");
      text.className = "tools-category-label";
      text.textContent = label;
      const count = document.createElement("span");
      count.className = "tools-category-count";
      count.textContent = String(rows.filter((row) => !row.deprecated && (scope === "*" || row.project === scope)).length);
      button.append(artwork, text, count);
      button.addEventListener("click", () => {
        this.scope = scope;
        this.selectTab("installed");
        this.renderNavigation();
        this.renderLibrary();
      });
      this.nav.append(button);
      if (scope === this.scope) this.body.setAttribute("aria-labelledby", button.id);
    };
    const artwork = (source: string) => {
      const image = document.createElement("img");
      image.className = "tools-category-artwork";
      image.src = source;
      image.alt = "";
      image.width = image.height = 16;
      image.draggable = false;
      image.setAttribute("aria-hidden", "true");
      return image;
    };
    group("Library");
    entry("*", "All skills", artwork(allSkillsArtwork));
    entry("", "Universal", artwork(universalArtwork));
    if (projects.size) {
      group("Projects");
      for (const [slug, label] of [...projects].sort((a, b) => a[1].localeCompare(b[1]))) {
        entry(slug, label, createToolsCategoryIcon("filesystem")!);
      }
    }
    if (hadFocus) this.nav.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus();
  }

  private renderLibrary(): void {
    const scopeMatches = (skill: SkillsRow) => this.scope === "*" || skill.project === this.scope;
    const visible = this.skills.filter(scopeMatches);
    this.countEl.textContent = String(this.catalog.filter((row) => !row.deprecated).length);
    this.scopeTitle.textContent = this.scope === "*" ? "All skills" : this.scope === "" ? "Universal"
      : this.catalog.find((row) => row.project === this.scope)?.projectLabel ?? this.scope;
    this.scopeDescription.textContent = this.scope === "*" ? "Across all your projects"
      : this.scope === "" ? "Available in every project" : "Available in this project only";
    this.listEl.replaceChildren(...visible.map((row) => this.buildCard(row)));
    if (!visible.length) {
      const empty = document.createElement("p");
      empty.className = "tools-mcp-empty";
      empty.textContent = this.searchInput.value.trim() ? this.emptyMessage
        : this.scope === "*" ? this.emptyMessage : "No skills in this scope.";
      this.listEl.append(empty);
    }
    const deprecated = this.deprecatedSkills.filter(scopeMatches);
    this.deprecatedSection.hidden = !deprecated.length;
    this.deprecatedCount.textContent = String(deprecated.length);
    this.deprecatedList.replaceChildren(...deprecated.map((row) => this.buildCard(row)));
    this.setBusy(this.busy);
  }

  /** Usage meta on the name row: reads plus the clean-use rate, nothing else. */
  private buildRateMeta(skill: SkillsRow): HTMLElement | null {
    if (!skill.uses) return null;
    const meta = document.createElement("span");
    meta.className = "skills-card-rate";
    meta.append(document.createTextNode(`Used ${skill.uses}×`));
    if (skill.successRate !== undefined && skill.successRate !== null) {
      const rate = skill.successRate;
      const value = document.createElement("span");
      value.className = `skills-card-rate-value ${rate >= 90 ? "is-good" : rate >= 70 ? "is-warn" : "is-bad"}`;
      value.textContent = `${rate}%`;
      meta.append(document.createTextNode(" · "), value);
    }
    return meta;
  }

  private buildCard(skill: SkillsRow): HTMLElement {
    const desc = skill.description.trim();
    const bodyText = skill.body.trim();

    const card = document.createElement("article");
    card.className = `tools-mcp-card skills-card${skill.enabled ? "" : " is-disabled"}${skill.deprecated ? " is-deprecated" : ""}`;
    card.dataset.skillId = skill.id;

    const top = document.createElement("div");
    top.className = "tools-mcp-card-top";

    const info = document.createElement("div");
    info.className = "tools-mcp-card-info skills-card-info";

    const nameRow = document.createElement("div");
    nameRow.className = "tools-mcp-name-row skills-card-name-row";

    const expandBtn = document.createElement("button");
    expandBtn.type = "button";
    expandBtn.className = "skills-card-expand-btn";
    expandBtn.title = "Show details";
    expandBtn.setAttribute("aria-label", `Show details for ${skill.name}`);
    expandBtn.setAttribute("aria-expanded", "false");
    expandBtn.append(createLucideIcon(ChevronDown, { size: 14 }));

    const name = document.createElement("h3");
    name.className = "tools-mcp-name skills-card-name";
    name.textContent = skill.name;

    const summary = document.createElement("p");
    summary.className = "skills-card-summary";
    if (desc) {
      summary.textContent = desc;
    }

    const origin = document.createElement("span");
    origin.className = "skills-origin-badge";
    origin.dataset.origin = skill.originLabel.toLowerCase();
    origin.textContent = skill.originLabel;
    nameRow.append(name, origin);
    if (skill.deprecated && skill.supersededByName) {
      const superseded = document.createElement("span");
      superseded.className = "skills-superseded";
      superseded.textContent = `→ ${skill.supersededByName}`;
      nameRow.append(superseded);
    }
    const rateMeta = this.buildRateMeta(skill);
    if (rateMeta) nameRow.append(rateMeta);
    info.append(nameRow);
    if (desc) info.append(summary);

    const actions = document.createElement("div");
    actions.className = "tools-mcp-actions";

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "tools-mcp-enabled";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.className = "library-switch";
    enabled.setAttribute("role", "switch");
    enabled.checked = skill.enabled;
    enabled.setAttribute("aria-label", `Enable ${skill.name}`);
    enabled.addEventListener("change", () => {
      const checked = enabled.checked;
      enabled.checked = skill.enabled;
      this.onToggle?.(skill.id, checked);
    });
    enabledLabel.append(enabled);

    const editBtn = iconButton(`Edit ${skill.name}`, Pencil, () => this.onEdit?.(skill.id));
    const historyBtn = iconButton(`History of ${skill.name}`, History, () =>
      this.onHistory?.(skill.id),
    );
    const deprecateBtn = skill.deprecated
      ? iconButton(`Reactivate ${skill.name}`, ArchiveRestore, () =>
          this.onDeprecate?.(skill.id, false),
        )
      : iconButton(`Deprecate ${skill.name}`, Archive, () =>
          this.onDeprecate?.(skill.id, true),
        );
    const removeBtn = iconButton(`Delete ${skill.name}`, Trash2, () =>
      this.onRemove?.(skill.id),
    );

    if (!skill.deprecated) actions.append(enabledLabel);
    actions.append(expandBtn);
    const scope = document.createElement("span");
    scope.className = "skills-card-scope";
    scope.textContent = skill.projectLabel;
    top.append(skillBadge(FileText), info, scope, actions);
    card.append(top);

    const details = document.createElement("div");
    details.className = "skills-card-details";
    details.hidden = true;
    const management = document.createElement("div");
    management.className = "skills-detail-actions";
    const editLabel = document.createElement("span");
    editLabel.textContent = "Edit skill";
    editBtn.append(editLabel);
    editBtn.classList.add("skills-edit-btn");
    management.append(editBtn, historyBtn, deprecateBtn, removeBtn);
    details.append(management);

    if (desc) {
      const descEl = document.createElement("p");
      descEl.className = "skills-card-description";
      descEl.textContent = desc;
      details.append(descEl);
    }
    const filesMeta = document.createElement("p");
    filesMeta.className = "skills-card-files-meta";
    filesMeta.textContent =
      skill.fileCount === 0
        ? "Supporting files: none"
        : `Supporting files: ${skill.fileCount}`;
    details.append(filesMeta);
    if (skill.usage) {
      const usage = document.createElement("p");
      usage.className = "skills-card-usage";
      usage.textContent = skill.usage;
      details.append(usage);
    }
    if (bodyText) {
      const bodyEl = document.createElement("pre");
      bodyEl.className = "skills-card-body";
      bodyEl.textContent = bodyText;
      details.append(bodyEl);
    }
    if (!desc && !bodyText) {
      const empty = document.createElement("p");
      empty.className = "skills-card-description is-empty";
      empty.textContent = "No description.";
      details.append(empty);
    }
    card.append(details);

    const setExpanded = (expanded: boolean): void => {
      card.classList.toggle("is-expanded", expanded);
      details.hidden = !expanded;
      expandBtn.setAttribute("aria-expanded", expanded ? "true" : "false");
      card.querySelector(".skills-card-name-button")?.setAttribute("aria-expanded", String(expanded));
      expandBtn.title = expanded ? "Hide details" : "Show details";
      expandBtn.setAttribute(
        "aria-label",
        expanded
          ? `Hide details for ${skill.name}`
          : `Show details for ${skill.name}`,
      );
      if (expanded) this.expandedIds.add(skill.id);
      else this.expandedIds.delete(skill.id);
    };

    const detailId = `${this.viewId}-detail-${encodeURIComponent(skill.id)}`;
    details.id = detailId;
    expandBtn.setAttribute("aria-controls", detailId);
    const nameButton = document.createElement("button");
    nameButton.type = "button";
    nameButton.className = "skills-card-name-button";
    nameButton.setAttribute("aria-controls", detailId);
    nameButton.setAttribute("aria-expanded", "false");
    name.textContent = "";
    nameButton.textContent = skill.name;
    name.append(nameButton);
    nameButton.addEventListener("click", () => expandBtn.click());
    expandBtn.addEventListener("click", () => {
      setExpanded(!card.classList.contains("is-expanded"));
    });

    if (this.expandedIds.has(skill.id)) {
      setExpanded(true);
    }

    return card;
  }

  private buildSuggestion(row: SkillSuggestionRow): HTMLElement {
    const card = document.createElement("article");
    card.className = `tools-mcp-card skills-card skills-suggestion${row.stale ? " is-stale" : ""}`;
    const top = document.createElement("div");
    top.className = "tools-mcp-card-top";
    const info = document.createElement("div");
    info.className = "tools-mcp-card-info skills-card-info";
    const nameRow = document.createElement("div");
    nameRow.className = "skills-card-name-row";
    const title = document.createElement("h3");
    title.className = "skills-card-name";
    title.textContent = row.title;
    nameRow.append(title);
    if (row.stale) {
      const stale = document.createElement("span");
      stale.className = "skills-origin-badge skills-stale-badge";
      stale.textContent = "Outdated";
      nameRow.append(stale);
    }
    const reason = document.createElement("p");
    reason.className = "skills-suggestion-reason";
    reason.textContent = row.reason;
    const meta = document.createElement("p");
    meta.className = "skills-card-usage";
    meta.textContent = row.meta;
    info.append(nameRow, reason, meta);
    if (row.stale) {
      const note = document.createElement("p");
      note.className = "skills-stale-note";
      note.textContent = "Skill changed since this suggestion. Run curation again.";
      info.append(note);
    }
    const actions = document.createElement("div");
    actions.className = "skills-suggestion-actions";
    const details = document.createElement("div");
    details.className = "skills-suggestion-diff";
    details.id = `${this.viewId}-suggestion-${encodeURIComponent(row.id)}`;
    const expanded = this.expandedSuggestionIds.has(row.id);
    details.hidden = !expanded;
    const expand = textButton(expanded ? "Hide changes" : "Review changes", expanded ? ChevronDown : ChevronRight, "skills-review-changes", () => {
      const open = details.hidden;
      details.hidden = !open;
      expand.setAttribute("aria-expanded", String(open));
      expand.replaceChildren(document.createTextNode(open ? "Hide changes" : "Review changes"), createLucideIcon(open ? ChevronDown : ChevronRight, { size: 13 }));
      if (open) this.expandedSuggestionIds.add(row.id);
      else this.expandedSuggestionIds.delete(row.id);
    });
    expand.setAttribute("aria-expanded", String(expanded));
    expand.setAttribute("aria-controls", details.id);
    const decisions = document.createElement("div");
    decisions.className = "skills-suggestion-decisions";
    const dismiss = document.createElement("button");
    dismiss.type = "button";
    dismiss.className = "skills-dismiss-btn";
    dismiss.textContent = "Dismiss";
    dismiss.setAttribute("aria-label", `Dismiss suggestion: ${row.title}`);
    dismiss.addEventListener("click", () => this.onResolveSuggestion?.(row.id, "reject"));
    const apply = textButton("Apply", Check, "tools-mcp-add-btn skills-install-btn", () => this.onResolveSuggestion?.(row.id, "accept"));
    apply.setAttribute("aria-label", `Apply suggestion: ${row.title}`);
    if (row.stale) {
      apply.dataset.staleAccept = "true";
      apply.setAttribute("aria-describedby", `${details.id}-stale`);
      info.querySelector(".skills-stale-note")!.id = `${details.id}-stale`;
    }
    decisions.append(dismiss, apply);
    actions.append(expand, decisions);
    for (const change of row.changes) {
      const label = document.createElement("p");
      label.className = "skills-card-files-meta";
      label.textContent = change.name;
      details.append(label);
      if (change.diff.length) {
        details.append(createDiffLinedFileView(change.diff, { pathOrName: "SKILL.md", foldUnchanged: true }));
      } else {
        const same = document.createElement("p");
        same.className = "skills-card-description";
        same.textContent = "No content change.";
        details.append(same);
      }
    }
    info.append(actions, details);
    top.append(skillBadge(row.kind === "merge" ? GitMerge : FilePenLine), info);
    card.append(top);
    return card;
  }
}

function skillBadge(icon: import("lucide").IconNode): HTMLElement {
  const badge = document.createElement("span");
  badge.className = "library-icon-badge skills-file-icon";
  badge.setAttribute("aria-hidden", "true");
  badge.append(createLucideIcon(icon, { size: 16 }));
  return badge;
}

function textButton(
  label: string,
  icon: import("lucide").IconNode,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.append(createLucideIcon(icon, { size: 14 }), document.createTextNode(label));
  button.addEventListener("click", onClick);
  return button;
}

function iconButton(
  label: string,
  icon: import("lucide").IconNode,
  onClick: () => void,
): HTMLButtonElement {
  const button = textButton("", icon, "tools-mcp-icon-btn", onClick);
  button.title = label;
  button.setAttribute("aria-label", label);
  return button;
}
