import { Copy, Plus, Trash2 } from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { createGraphTemplateIcon, createLibraryBadge } from "../../ui/libraryIcons.js";
import "../setting/setting.css";
import "./graphs.css";

export type GraphListRow = {
  id: string;
  name: string;
  updatedAt: number;
  origin: "user" | "llm";
  enabled: boolean;
  /** Identity color `#rrggbb` (absent → default violet). */
  color?: string;
};

export type BuiltinTemplateRow = {
  mode: "react" | "react_v2" | "ask" | "plan_execute" | "subagent";
  label: string;
  description: string;
};

const templateCategories: Record<BuiltinTemplateRow["mode"], string> = {
  react: "General purpose",
  react_v2: "Demo first",
  ask: "Read-only Q&A",
  plan_execute: "Plan before execution",
  subagent: "Child task execution",
};

export class GraphsView {
  readonly root: HTMLElement;
  private readonly templatesEl: HTMLElement;
  private readonly templateCountEl: HTMLElement;
  private readonly listEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private busy = false;
  private onOpen: ((id: string) => void) | null = null;
  private onCreate: (() => void) | null = null;
  private onFork: ((mode: BuiltinTemplateRow["mode"]) => void) | null = null;
  private onDelete: ((id: string) => void) | null = null;
  private onToggleEnabled:
    | ((id: string, enabled: boolean) => void)
    | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen graphs-screen";

    const header = document.createElement("div");
    header.className = "graphs-header";

    const titles = document.createElement("div");
    titles.className = "graphs-header-titles";
    const title = document.createElement("h1");
    title.className = "screen-title";
    title.textContent = "Graphs";
    titles.append(title);
    header.append(titles);

    this.statusEl = document.createElement("p");
    this.statusEl.className = "graphs-status";
    this.statusEl.hidden = true;
    this.statusEl.setAttribute("role", "status");

    const body = document.createElement("div");
    body.className = "graphs-body";

    const templatesSection = document.createElement("section");
    templatesSection.className = "graphs-section graphs-templates-section";
    const templatesHead = document.createElement("div");
    templatesHead.className = "graphs-section-head";
    const templatesTitle = document.createElement("h2");
    templatesTitle.className = "graphs-section-title";
    templatesTitle.textContent = "Built-in templates";
    this.templateCountEl = document.createElement("span");
    this.templateCountEl.className = "graphs-count";
    templatesHead.append(templatesTitle, this.templateCountEl);
    const templatesHelp = document.createElement("p");
    templatesHelp.className = "graphs-section-help";
    templatesHelp.textContent =
      "Start from a built-in workflow. Fork a template to make it your own.";
    this.templatesEl = document.createElement("div");
    this.templatesEl.className = "graphs-templates";
    templatesSection.append(templatesHead, templatesHelp, this.templatesEl);

    const listSection = document.createElement("section");
    listSection.className = "graphs-section";
    const listHead = document.createElement("div");
    listHead.className = "graphs-section-head";
    const listTitles = document.createElement("div");
    const listTitle = document.createElement("h2");
    listTitle.className = "graphs-section-title";
    listTitle.textContent = "Your graphs";
    listTitles.className = "graphs-list-titles";
    this.countEl = document.createElement("span");
    this.countEl.className = "graphs-count";
    listTitles.append(listTitle, this.countEl);
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "setting-btn action-primary";
    addBtn.append(
      createLucideIcon(Plus, { size: 14 }),
      document.createTextNode("New graph"),
    );
    addBtn.addEventListener("click", () => this.onCreate?.());
    header.append(addBtn);
    listHead.append(listTitles);
    this.listEl = document.createElement("div");
    this.listEl.className = "graphs-list";
    listSection.append(listHead, this.listEl);

    body.append(templatesSection, listSection);
    this.root.append(header, this.statusEl, body);
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    this.root.classList.toggle("is-busy", busy);
    this.root.setAttribute("aria-busy", String(busy));
    this.root.querySelectorAll<HTMLButtonElement | HTMLInputElement>("button, input").forEach(control => { control.disabled = busy; });
    this.root
      .querySelectorAll<HTMLButtonElement>("button.action-primary, button.action-danger")
      .forEach((button) => button.setAttribute("aria-busy", String(busy)));
  }

  setStatus(message: string | null, kind: "error" | "info" = "info"): void {
    if (!message) {
      this.statusEl.hidden = true;
      this.statusEl.textContent = "";
      return;
    }
    this.statusEl.hidden = false;
    this.statusEl.textContent = message;
    this.statusEl.dataset.kind = kind;
  }

  setTemplates(templates: BuiltinTemplateRow[]): void {
    this.templatesEl.replaceChildren();
    this.templateCountEl.textContent = String(templates.length);
    for (const template of templates) {
      const card = document.createElement("article");
      card.className = "graphs-template-card";

      const identity = document.createElement("div");
      identity.className = "graphs-template-identity";

      const icon = document.createElement("span");
      icon.className = "graphs-template-icon";
      icon.dataset.mode = template.mode;
      icon.append(createGraphTemplateIcon(template.mode));

      const text = document.createElement("div");
      text.className = "graphs-template-text";
      const title = document.createElement("h3");
      title.className = "graphs-template-label";
      title.textContent = template.label;
      const category = document.createElement("span");
      category.className = "graphs-template-category";
      category.textContent = templateCategories[template.mode];
      text.append(title, category);
      identity.append(icon, text);

      const description = document.createElement("p");
      description.className = "graphs-template-description";
      description.textContent = template.description;

      const fork = document.createElement("button");
      fork.type = "button";
      fork.className = "graphs-template-fork";
      fork.setAttribute("aria-label", `Fork ${template.label}`);
      fork.disabled = this.busy;
      fork.append(
        document.createTextNode("Fork"),
        createLucideIcon(Copy, { size: 13 }),
      );
      fork.addEventListener("click", () => this.onFork?.(template.mode));

      card.append(identity, description, fork);
      this.templatesEl.append(card);
    }
  }

  setGraphs(
    rows: GraphListRow[],
    options?: { emptyMessage?: string },
  ): void {
    this.listEl.replaceChildren();
    this.countEl.textContent = String(rows.length);
    if (rows.length === 0) {
      const empty = document.createElement("p");
      empty.className = "graphs-empty";
      empty.textContent =
        options?.emptyMessage ??
        "No custom graphs yet. Fork a template or create a new graph.";
      this.listEl.append(empty);
      return;
    }

    for (const row of rows) {
      const item = document.createElement("article");
      item.className = row.enabled ? "graphs-row" : "graphs-row is-disabled";

      const main = document.createElement("button");
      main.type = "button";
      main.className = "graphs-row-main";
      main.addEventListener("click", () => this.onOpen?.(row.id));

      const icon = createLibraryBadge("graph");

      const text = document.createElement("span");
      text.className = "graphs-row-text";
      const title = document.createElement("span");
      title.className = "graphs-row-title";
      title.textContent = row.name;
      const meta = document.createElement("span");
      meta.className = "graphs-row-meta";
      meta.append(document.createTextNode(formatRelative(row.updatedAt)));
      if (row.origin === "llm") {
        const origin = document.createElement("span");
        origin.className = "graphs-row-origin";
        origin.textContent = "LLM";
        meta.append(origin);
      }
      if (!row.enabled) {
        const state = document.createElement("span");
        state.className = "graphs-row-state";
        state.textContent = "Disabled";
        meta.append(state);
      }
      text.append(title, meta);

      main.append(icon, text);

      const actions = document.createElement("div");
      actions.className = "graphs-row-actions";
      const toggle = document.createElement("input");
      toggle.type = "checkbox";
      toggle.className = "library-switch";
      toggle.checked = row.enabled;
      toggle.setAttribute("role", "switch");
      toggle.setAttribute("aria-label", `Enable ${row.name}`);
      toggle.title = row.enabled ? "Disable graph" : "Enable graph";
      toggle.addEventListener("change", () => {
        const enabled = toggle.checked;
        toggle.checked = row.enabled;
        this.onToggleEnabled?.(row.id, enabled);
      });

      const del = document.createElement("button");
      del.type = "button";
      del.className = "graphs-row-delete";
      del.title = "Delete graph";
      del.setAttribute("aria-label", `Delete ${row.name}`);
      del.append(createLucideIcon(Trash2, { size: 14 }));
      del.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this.onDelete?.(row.id);
      });

      actions.append(toggle, del);
      item.append(main, actions);
      this.listEl.append(item);
    }
    this.setBusy(this.busy);
  }

  setOnOpen(handler: ((id: string) => void) | null): void {
    this.onOpen = handler;
  }

  setOnCreate(handler: (() => void) | null): void {
    this.onCreate = handler;
  }

  setOnFork(handler: ((mode: BuiltinTemplateRow["mode"]) => void) | null): void {
    this.onFork = handler;
  }

  setOnDelete(handler: ((id: string) => void) | null): void {
    this.onDelete = handler;
  }

  setOnToggleEnabled(
    handler: ((id: string, enabled: boolean) => void) | null,
  ): void {
    this.onToggleEnabled = handler;
  }
}

function formatRelative(ms: number): string {
  const delta = Date.now() - ms;
  if (delta < 60_000) return "Just now";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m ago`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}
