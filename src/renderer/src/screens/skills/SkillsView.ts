import { ChevronDown, PackagePlus, Pencil, Plus, Search, Trash2 } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { createLibraryBadge } from "../../ui/libraryIcons.js";
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
};

/**
 * Skills screen — manage app-global agent skills.
 */
export class SkillsView {
  readonly root: HTMLElement;
  private readonly searchInput: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly body: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private busy = false;
  private readonly expandedIds = new Set<string>();
  private onQueryChange: ((query: string) => void) | null = null;
  private onAdd: (() => void) | null = null;
  private onInstallZip: (() => void) | null = null;
  private onEdit: ((id: string) => void) | null = null;
  private onRemove: ((id: string) => void) | null = null;
  private onToggle: ((id: string, enabled: boolean) => void) | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen tools-screen skills-screen";

    const header = document.createElement("div");
    header.className = "screen-header tools-header";

    const titles = document.createElement("div");
    titles.className = "tools-header-titles";
    titles.innerHTML = `<h1 class="screen-title">Skills</h1>`;
    header.append(titles);

    const toolbar = document.createElement("div");
    toolbar.className = "tools-toolbar";

    const searchField = document.createElement("label");
    searchField.className = "tools-search-field";
    const searchLabel = document.createElement("span");
    searchLabel.className = "sr-only";
    searchLabel.textContent = "Filter skills";

    const searchWrap = document.createElement("div");
    searchWrap.className = "tools-search-wrap";
    const searchIcon = document.createElement("span");
    searchIcon.className = "tools-search-icon";
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.append(createLucideIcon(Search, { size: 14 }));

    this.searchInput = document.createElement("input");
    this.searchInput.type = "search";
    this.searchInput.className = "tools-search-input";
    this.searchInput.placeholder = "Search skills";
    this.searchInput.autocomplete = "off";
    this.searchInput.spellcheck = false;
    this.searchInput.addEventListener("input", () => {
      this.onQueryChange?.(this.searchInput.value);
    });
    searchWrap.append(searchIcon, this.searchInput);
    searchField.append(searchLabel, searchWrap);
    toolbar.append(searchField);

    this.statusEl = document.createElement("p");
    this.statusEl.className = "tools-status";
    this.statusEl.hidden = true;
    this.statusEl.setAttribute("role", "status");

    this.body = document.createElement("div");
    this.body.className = "screen-body tools-body";
    this.body.append(toolbar);

    const section = document.createElement("section");
    section.className = "tools-skills-section";

    const sectionHeader = document.createElement("div");
    sectionHeader.className = "tools-mcp-header";

    const sectionTitles = document.createElement("div");
    sectionTitles.className = "tools-group-header";
    const sectionTitle = document.createElement("h2");
    sectionTitle.className = "tools-group-title";
    sectionTitle.textContent = "Installed";
    this.countEl = document.createElement("span");
    this.countEl.className = "skills-count";
    sectionTitles.append(sectionTitle, this.countEl);

    const actions = document.createElement("div");
    actions.className = "skills-header-actions";

    const installBtn = document.createElement("button");
    installBtn.type = "button";
    installBtn.className = "tools-mcp-add-btn skills-install-btn";
    installBtn.append(
      createLucideIcon(PackagePlus, { size: 14 }),
      document.createTextNode("Install ZIP"),
    );
    installBtn.addEventListener("click", () => this.onInstallZip?.());

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "tools-mcp-add-btn action-primary";
    addBtn.append(
      createLucideIcon(Plus, { size: 14 }),
      document.createTextNode("Add skill"),
    );
    addBtn.addEventListener("click", () => this.onAdd?.());

    actions.append(installBtn, addBtn);
    header.append(actions);
    sectionHeader.append(sectionTitles);
    this.listEl = document.createElement("div");
    this.listEl.className = "tools-mcp-list";
    section.append(sectionHeader, this.listEl);

    this.body.append(section);
    this.root.append(header, this.statusEl, this.body);
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

  setSkills(skills: SkillsRow[], options?: { emptyMessage?: string }): void {
    const visibleIds = new Set(skills.map((s) => s.id));
    for (const id of [...this.expandedIds]) {
      if (!visibleIds.has(id)) this.expandedIds.delete(id);
    }
    this.listEl.replaceChildren();
    this.countEl.textContent = String(skills.length);
    if (skills.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tools-mcp-empty";
      empty.textContent = options?.emptyMessage ?? "No skills installed";
      this.listEl.append(empty);
      return;
    }
    for (const skill of skills) {
      this.listEl.append(this.buildCard(skill));
    }
    this.setBusy(this.busy);
  }

  private buildCard(skill: SkillsRow): HTMLElement {
    const desc = skill.description.trim();
    const bodyText = skill.body.trim();

    const card = document.createElement("article");
    card.className = `tools-mcp-card skills-card${skill.enabled ? "" : " is-disabled"}`;
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

    nameRow.append(name);
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
    const removeBtn = iconButton(`Delete ${skill.name}`, Trash2, () =>
      this.onRemove?.(skill.id),
    );

    actions.append(enabledLabel, editBtn, removeBtn, expandBtn);
    top.append(createLibraryBadge("skill"), info, actions);
    card.append(top);

    const details = document.createElement("div");
    details.className = "skills-card-details";
    details.hidden = true;

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

    expandBtn.addEventListener("click", () => {
      setExpanded(!card.classList.contains("is-expanded"));
    });

    if (this.expandedIds.has(skill.id)) {
      setExpanded(true);
    }

    return card;
  }
}

function iconButton(
  label: string,
  icon: import("lucide").IconNode,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "tools-mcp-icon-btn";
  btn.title = label;
  btn.setAttribute("aria-label", label);
  btn.append(createLucideIcon(icon, { size: 14 }));
  btn.addEventListener("click", onClick);
  return btn;
}
