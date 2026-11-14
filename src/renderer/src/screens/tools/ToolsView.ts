import {
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  Wrench,
} from "lucide";
import { createLucideIcon } from "../../ui/originalIcons.js";
import { AppDropdown } from "../../ui/appDropdown.js";
import { TOOL_CATEGORIES } from "../../../../tools/catalog.js";
import { getToolDisplayMeta } from "../conversation/cards/toolDisplay.js";
import { createToolsCategoryIcon } from "./toolsCategoryIcon.js";
import "./tools.css";

export type ToolsPermissionLevel = 0 | 1 | 2;

export type ToolsTableRow = {
  name: string;
  displayName: string;
  /** Human-facing UI copy, never ToolDefinition.description. */
  description: string;
  permissionLevel: ToolsPermissionLevel;
  defaultPermissionLevel: ToolsPermissionLevel;
  offered: boolean;
  offerLocked?: boolean;
  /** Whether this tool's card renders in the conversation flow. */
  visible: boolean;
  /** Always-visible tools (ask panels / plan progress) cannot be hidden. */
  displayLocked?: boolean;
  callCount?: number;
};

export type ToolsTableGroup = {
  categoryId: string;
  label: string;
  description: string;
  tools: ToolsTableRow[];
};

export type ToolsMcpToolRow = {
  name: string;
  /** Human-facing UI copy, never the MCP provider's model instructions. */
  description: string;
  registryName: string;
  permissionLevel: ToolsPermissionLevel;
  defaultPermissionLevel: ToolsPermissionLevel;
  offered: boolean;
  offerLocked?: boolean;
  callCount?: number;
};

export type ToolsMcpServerRow = {
  id: string;
  name: string;
  enabled: boolean;
  transportSummary: string;
  status: "disconnected" | "connecting" | "connected" | "error";
  errorMessage?: string;
  tools: ToolsMcpToolRow[];
};

const PERMISSION_OPTIONS: Array<{
  level: ToolsPermissionLevel;
  label: string;
}> = [
  { level: 0, label: "Allow" },
  { level: 1, label: "Bypass" },
  { level: 2, label: "Ask" },
];

/** Secondary-nav entry — MCP servers panel plus one panel per tool category. */
type CategoryPanelEntry = {
  tab: HTMLButtonElement;
  panel: HTMLElement;
  countEl: HTMLElement;
  /** Builtin panels only — title/description/table refresh on data loads. */
  titleEl?: HTMLHeadingElement;
  descEl?: HTMLParagraphElement;
  tableHost?: HTMLElement;
};

/**
 * Tools screen — Settings-style secondary navigation: MCP servers panel plus
 * one panel per built-in tool category. All panels stay mounted (Settings
 * pattern) so permission selects and drafts survive navigation; a non-empty
 * filter swaps the content column to a cross-category results view.
 */
export class ToolsView {
  readonly root: HTMLElement;
  /** Root elements of the per-row permission dropdowns (two tables render one each). */
  private readonly permissionDropdowns = new WeakMap<HTMLElement, AppDropdown>();
  private readonly searchInput: HTMLInputElement;
  private readonly statusEl: HTMLElement;
  private readonly layout: HTMLElement;
  private readonly nav: HTMLElement;
  private readonly content: HTMLElement;
  private readonly mcpList: HTMLElement;
  private readonly resultsPanel: HTMLElement;
  private readonly resultsMcpHost: HTMLElement;
  private readonly resultsGroupsHost: HTMLElement;
  private readonly resultsDescEl: HTMLElement;
  private readonly entries = new Map<string, CategoryPanelEntry>();
  private readonly tabs: HTMLButtonElement[] = [];
  private readonly panels: HTMLElement[] = [];
  private readonly scrollPositions = new Map<number, number>();
  private selectedIndex = 0;
  private query = "";
  private resultsHasMcp = false;
  private onPermissionChange:
    | ((name: string, level: ToolsPermissionLevel) => void)
    | null = null;
  private onOfferChange:
    | ((name: string, include: boolean) => void)
    | null = null;
  private onAutoOrganize: (() => void) | null = null;
  private onQueryChange: ((query: string) => void) | null = null;
  private onAddMcp: (() => void) | null = null;
  private onReloadMcp: (() => void) | null = null;
  private onEditMcp: ((id: string) => void) | null = null;
  private onRemoveMcp: ((id: string) => void) | null = null;
  private onReconnectMcp: ((id: string) => void) | null = null;
  private onToggleMcp: ((id: string, enabled: boolean) => void) | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen tools-screen tools-nav-screen";

    const header = document.createElement("div");
    header.className = "screen-header tools-header tools-header-split";

    const titles = document.createElement("div");
    titles.className = "tools-header-titles";
    titles.innerHTML = `<h1 class="screen-title">Tools</h1>`;

    const toolbar = document.createElement("div");
    toolbar.className = "tools-toolbar";

    const searchField = document.createElement("label");
    searchField.className = "tools-search-field";
    const searchLabel = document.createElement("span");
    searchLabel.className = "sr-only";
    searchLabel.textContent = "Filter tools";

    const searchWrap = document.createElement("div");
    searchWrap.className = "tools-search-wrap";
    const searchIcon = document.createElement("span");
    searchIcon.className = "tools-search-icon";
    searchIcon.setAttribute("aria-hidden", "true");
    searchIcon.append(createLucideIcon(Search, { size: 14 }));

    this.searchInput = document.createElement("input");
    this.searchInput.type = "search";
    this.searchInput.className = "tools-search-input";
    this.searchInput.placeholder = "Filter tools…";
    this.searchInput.autocomplete = "off";
    this.searchInput.spellcheck = false;
    this.searchInput.addEventListener("input", () => {
      this.query = this.searchInput.value;
      this.onQueryChange?.(this.query);
    });
    searchWrap.append(searchIcon, this.searchInput);
    searchField.append(searchLabel, searchWrap);

    const autoBtn = document.createElement("button");
    autoBtn.type = "button";
    autoBtn.className = "tools-auto-organize-btn";
    autoBtn.title =
      "Set always-offer tools from call counts (top 17), or defaults when unused";
    autoBtn.append(
      createLucideIcon(Sparkles, { size: 14 }),
      document.createTextNode("Auto-organize"),
    );
    autoBtn.addEventListener("click", () => this.onAutoOrganize?.());

    toolbar.append(searchField, autoBtn);
    header.append(titles, toolbar);

    this.statusEl = document.createElement("p");
    this.statusEl.className = "tools-status";
    this.statusEl.hidden = true;

    this.layout = document.createElement("div");
    this.layout.className = "tools-layout";
    this.nav = document.createElement("nav");
    this.nav.className = "tools-categories";
    this.nav.setAttribute("role", "tablist");
    this.nav.setAttribute("aria-label", "Tools categories");
    this.nav.setAttribute("aria-orientation", "vertical");
    this.content = document.createElement("div");
    this.content.className = "tools-content";

    this.appendNavHeading("Servers");
    const mcpEntry = this.appendCategoryTab("mcp-servers", "MCP Servers");
    mcpEntry.panel = this.buildMcpPanel();
    mcpEntry.panel.id = "tools-panel-mcp-servers";
    mcpEntry.panel.setAttribute("role", "tabpanel");
    mcpEntry.panel.setAttribute("aria-labelledby", mcpEntry.tab.id);
    mcpEntry.panel.tabIndex = 0;
    mcpEntry.panel.hidden = false;
    this.panels[0] = mcpEntry.panel;
    this.content.append(mcpEntry.panel);

    this.appendNavHeading("Built-in tools");
    for (const category of TOOL_CATEGORIES) {
      this.appendBuiltinPanel(category.id, category.label, category.description);
    }

    this.resultsPanel = document.createElement("section");
    this.resultsPanel.className = "tools-category-panel tools-results";
    this.resultsPanel.setAttribute("role", "region");
    this.resultsPanel.setAttribute("aria-label", "Search results");
    this.resultsPanel.hidden = true;
    const resultsHeader = document.createElement("div");
    resultsHeader.className = "tools-group-header";
    const resultsTitle = document.createElement("h2");
    resultsTitle.className = "tools-group-title";
    resultsTitle.textContent = "Search results";
    this.resultsDescEl = document.createElement("p");
    this.resultsDescEl.className = "tools-group-desc";
    resultsHeader.append(resultsTitle, this.resultsDescEl);
    this.resultsMcpHost = document.createElement("div");
    this.resultsMcpHost.className = "tools-results-mcp";
    this.resultsGroupsHost = document.createElement("div");
    this.resultsGroupsHost.className = "tools-results-groups";
    this.resultsPanel.append(
      resultsHeader,
      this.resultsMcpHost,
      this.resultsGroupsHost,
    );
    this.content.append(this.resultsPanel);

    this.nav.addEventListener("keydown", (event) => {
      const index = this.tabs.indexOf(event.target as HTMLButtonElement);
      if (index < 0) return;
      let next: number;
      switch (event.key) {
        case "ArrowDown": next = (index + 1) % this.tabs.length; break;
        case "ArrowUp": next = (index - 1 + this.tabs.length) % this.tabs.length; break;
        case "Home": next = 0; break;
        case "End": next = this.tabs.length - 1; break;
        default: return;
      }
      event.preventDefault();
      this.select(next);
      this.tabs[next]!.focus({ preventScroll: true });
    });

    this.layout.append(this.nav, this.content);
    this.root.append(header, this.statusEl, this.layout);

    this.mcpList = mcpEntry.panel.querySelector<HTMLElement>(
      ".tools-mcp-list",
    )!;
  }

  private appendNavHeading(label: string): void {
    const heading = document.createElement("p");
    heading.className = "tools-category-group";
    heading.setAttribute("role", "presentation");
    heading.textContent = label;
    this.nav.append(heading);
  }

  private appendCategoryTab(categoryId: string, label: string): CategoryPanelEntry {
    const index = this.tabs.length;
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "tools-category-tab";
    tab.id = `tools-tab-${categoryId}`;
    tab.dataset.category = categoryId;
    tab.title = label;
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-controls", `tools-panel-${categoryId}`);
    tab.setAttribute("aria-selected", String(index === 0));
    tab.setAttribute("tabindex", index === 0 ? "0" : "-1");
    const labelEl = document.createElement("span");
    labelEl.className = "tools-category-label";
    labelEl.textContent = label;
    const countEl = document.createElement("span");
    countEl.className = "tools-category-count";
    countEl.textContent = "0";
    tab.append(
      createToolsCategoryIcon(categoryId) ?? createLucideIcon(Wrench, { size: 16 }),
      labelEl,
      countEl,
    );
    tab.addEventListener("click", () => this.select(index));
    this.tabs.push(tab);
    this.nav.append(tab);

    const entry: CategoryPanelEntry = { tab, panel: document.createElement("section"), countEl };
    this.entries.set(categoryId, entry);
    return entry;
  }

  private appendBuiltinPanel(
    categoryId: string,
    label: string,
    description: string,
  ): void {
    const entry = this.appendCategoryTab(categoryId, label);
    const panel = document.createElement("section");
    panel.className = "tools-category-panel tools-group";
    panel.id = `tools-panel-${categoryId}`;
    panel.dataset.category = categoryId;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", entry.tab.id);
    panel.tabIndex = 0;
    panel.hidden = true;

    const heading = document.createElement("div");
    heading.className = "tools-group-header";
    const title = document.createElement("h2");
    title.className = "tools-group-title";
    title.textContent = label;
    const desc = document.createElement("p");
    desc.className = "tools-group-desc";
    desc.textContent = description;
    heading.append(title, desc);

    const tableHost = document.createElement("div");
    tableHost.className = "tools-panel-table-host";
    panel.append(heading, tableHost);
    entry.panel = panel;
    entry.titleEl = title;
    entry.descEl = desc;
    entry.tableHost = tableHost;
    this.panels[this.tabs.indexOf(entry.tab)] = panel;
    this.content.append(panel);
  }

  private buildMcpPanel(): HTMLElement {
    const panel = document.createElement("section");
    panel.className = "tools-category-panel tools-mcp-section";
    panel.dataset.category = "mcp-servers";

    const mcpHeader = document.createElement("div");
    mcpHeader.className = "tools-mcp-header";

    const mcpTitles = document.createElement("div");
    mcpTitles.className = "tools-group-header";
    const mcpTitle = document.createElement("h2");
    mcpTitle.className = "tools-group-title";
    mcpTitle.textContent = "MCP servers";
    const mcpDesc = document.createElement("p");
    mcpDesc.className = "tools-group-desc";
    mcpDesc.textContent =
      "Connect external services and manage permissions for their tools.";
    mcpTitles.append(mcpTitle, mcpDesc);

    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "tools-mcp-add-btn action-primary";
    addBtn.append(createLucideIcon(Plus, { size: 14 }), document.createTextNode("Add MCP"));
    addBtn.addEventListener("click", () => this.onAddMcp?.());

    const reloadBtn = document.createElement("button");
    reloadBtn.type = "button";
    reloadBtn.className = "tools-mcp-reload-btn";
    reloadBtn.title = "Re-read tools.json and reconcile MCP servers";
    reloadBtn.append(createLucideIcon(RefreshCw, { size: 14 }), document.createTextNode("Reload"));
    reloadBtn.addEventListener("click", () => this.onReloadMcp?.());

    const mcpActions = document.createElement("div");
    mcpActions.className = "tools-mcp-actions";
    mcpActions.append(addBtn, reloadBtn);

    mcpHeader.append(mcpTitles, mcpActions);
    const mcpList = document.createElement("div");
    mcpList.className = "tools-mcp-list";
    panel.append(mcpHeader, mcpList);
    return panel;
  }

  private select(index: number): void {
    if (index === this.selectedIndex && !this.query) return;
    this.scrollPositions.set(this.selectedIndex, this.content.scrollTop);
    if (this.query) {
      // Picking a tab while filtering leaves the results view — clear the
      // query first so the controller repaints the panels with full data.
      this.searchInput.value = "";
      this.query = "";
      this.onQueryChange?.("");
    }
    this.selectedIndex = index;
    this.syncPanelVisibility();
    this.content.scrollTop = this.scrollPositions.get(index) ?? 0;
  }

  /** Show the selected panel (or the results view while filtering). */
  private syncPanelVisibility(): void {
    const searching = this.query.length > 0;
    this.root.classList.toggle("is-searching", searching);
    this.tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === this.selectedIndex));
      tab.setAttribute("tabindex", i === this.selectedIndex ? "0" : "-1");
    });
    this.panels.forEach((panel, i) => {
      panel.hidden = searching || i !== this.selectedIndex;
    });
    this.resultsPanel.hidden = !searching;
    if (searching) {
      this.resultsDescEl.textContent = `Matching “${this.query.trim()}” across all categories.`;
    }
  }

  setOnPermissionChange(
    handler: ((name: string, level: ToolsPermissionLevel) => void) | null,
  ): void {
    this.onPermissionChange = handler;
  }

  setOnOfferChange(
    handler: ((name: string, include: boolean) => void) | null,
  ): void {
    this.onOfferChange = handler;
  }

  setOnAutoOrganize(handler: (() => void) | null): void {
    this.onAutoOrganize = handler;
  }

  setOnQueryChange(handler: ((query: string) => void) | null): void {
    this.onQueryChange = handler;
  }

  setOnAddMcp(handler: (() => void) | null): void {
    this.onAddMcp = handler;
  }

  setOnReloadMcp(handler: (() => void) | null): void {
    this.onReloadMcp = handler;
  }

  setOnEditMcp(handler: ((id: string) => void) | null): void {
    this.onEditMcp = handler;
  }

  setOnRemoveMcp(handler: ((id: string) => void) | null): void {
    this.onRemoveMcp = handler;
  }

  setOnReconnectMcp(handler: ((id: string) => void) | null): void {
    this.onReconnectMcp = handler;
  }

  setOnToggleMcp(handler: ((id: string, enabled: boolean) => void) | null): void {
    this.onToggleMcp = handler;
  }

  getQuery(): string {
    return this.searchInput.value;
  }

  setBusy(busy: boolean): void {
    this.root.classList.toggle("is-busy", busy);
    this.searchInput.disabled = busy;
    this.root
      .querySelectorAll<HTMLElement>(".tools-permission-select")
      .forEach((host) => {
        const dropdown = this.permissionDropdowns.get(host);
        if (dropdown) dropdown.disabled = busy;
      });
    this.root.querySelectorAll<HTMLButtonElement>("button").forEach((el) => {
      el.disabled = busy;
      if (el.matches(".action-primary, .action-danger")) {
        el.setAttribute("aria-busy", String(busy));
      }
    });
    this.root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]').forEach(
      (el) => {
        // Forced Include tools (e.g. search_tools) stay disabled when not busy.
        if (el.classList.contains("tools-offer-toggle") && el.dataset.offerLocked === "1") {
          el.disabled = true;
          return;
        }
        el.disabled = busy;
      },
    );
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

  setMcpServers(servers: ToolsMcpServerRow[]): void {
    if (this.query) {
      this.resultsHasMcp = servers.length > 0;
      this.resultsMcpHost.replaceChildren();
      for (const server of servers) {
        this.resultsMcpHost.append(this.buildMcpCard(server));
      }
      this.syncPanelVisibility();
      return;
    }
    this.resultsHasMcp = false;
    this.resultsMcpHost.replaceChildren();
    this.syncPanelVisibility();
    const entry = this.entries.get("mcp-servers");
    if (entry) entry.countEl.textContent = String(servers.length);
    this.mcpList.replaceChildren();
    if (servers.length === 0) {
      const empty = document.createElement("p");
      empty.className = "tools-mcp-empty";
      empty.textContent = "No MCP servers configured.";
      this.mcpList.append(empty);
      return;
    }
    for (const server of servers) {
      this.mcpList.append(this.buildMcpCard(server));
    }
  }

  setGroups(
    groups: ToolsTableGroup[],
    options?: { emptyMessage?: string },
  ): void {
    if (this.query) {
      this.renderSearchResults(groups, options);
      return;
    }
    this.syncPanelVisibility();
    const seen = new Set<string>();
    for (const group of groups) {
      const entry = this.ensureGroupPanel(group.categoryId, group.label, group.description);
      seen.add(group.categoryId);
      if (entry.titleEl) entry.titleEl.textContent = group.label;
      if (entry.descEl) entry.descEl.textContent = group.description;
      entry.countEl.textContent = String(group.tools.length);
      if (entry.tableHost) {
        entry.tableHost.replaceChildren();
        if (group.tools.length === 0) {
          entry.tableHost.append(emptyNote("No tools in this category."));
        } else {
          entry.tableHost.append(this.buildGroupTable(group.tools));
        }
      }
    }
    for (const [categoryId, entry] of this.entries) {
      if (categoryId === "mcp-servers" || seen.has(categoryId)) continue;
      entry.countEl.textContent = "0";
      if (entry.tableHost) {
        entry.tableHost.replaceChildren(
          emptyNote(options?.emptyMessage ?? "No tools in this category."),
        );
      }
    }
  }

  /** Future category ids (not in TOOL_CATEGORIES) get a tab on first sight. */
  private ensureGroupPanel(
    categoryId: string,
    label: string,
    description: string,
  ): CategoryPanelEntry {
    const existing = this.entries.get(categoryId);
    if (existing) return existing;
    this.appendBuiltinPanel(categoryId, label, description);
    return this.entries.get(categoryId)!;
  }

  private renderSearchResults(
    groups: ToolsTableGroup[],
    options?: { emptyMessage?: string },
  ): void {
    this.syncPanelVisibility();
    this.resultsGroupsHost.replaceChildren();
    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "tools-group tools-results-group";
      const heading = document.createElement("div");
      heading.className = "tools-group-header";
      const title = document.createElement("h2");
      title.className = "tools-group-title";
      title.textContent = group.label;
      const desc = document.createElement("p");
      desc.className = "tools-group-desc";
      desc.textContent = group.description;
      heading.append(title, desc);
      section.append(heading, this.buildGroupTable(group.tools));
      this.resultsGroupsHost.append(section);
    }
    if (groups.length === 0 && !this.resultsHasMcp) {
      this.resultsGroupsHost.append(
        emptyNote(options?.emptyMessage ?? "No tools match."),
      );
    }
  }

  updateToolPermission(
    name: string,
    permissionLevel: ToolsPermissionLevel,
    defaultPermissionLevel: ToolsPermissionLevel,
  ): void {
    const host = this.root.querySelector<HTMLElement>(
      `.tools-permission-select[data-tool-name="${CSS.escape(name)}"]`,
    );
    if (!host) return;
    const dropdown = this.permissionDropdowns.get(host);
    if (!dropdown) return;
    dropdown.value = String(permissionLevel);
    host.dataset.defaultPermissionLevel = String(defaultPermissionLevel);
    this.syncRowOverrideClass(name);
  }

  updateToolOffer(name: string, offered: boolean, offerLocked?: boolean): void {
    const toggle = this.root.querySelector<HTMLInputElement>(
      `input.tools-offer-toggle[data-tool-name="${CSS.escape(name)}"]`,
    );
    if (!toggle) return;
    toggle.checked = offered;
    const locked = offerLocked === true;
    toggle.disabled = locked;
    if (locked) toggle.dataset.offerLocked = "1";
    else delete toggle.dataset.offerLocked;
    this.syncRowOverrideClass(name);
  }

  private syncRowOverrideClass(name: string): void {
    const rows = this.root.querySelectorAll<HTMLTableRowElement>(
      `tr[data-tool-name="${CSS.escape(name)}"]`,
    );
    for (const row of rows) {
      const host = row.querySelector<HTMLElement>(".tools-permission-select");
      const dropdown = host ? this.permissionDropdowns.get(host) : undefined;
      const permOverridden =
        !!host &&
        !!dropdown &&
        Number(dropdown.value) !==
          Number(host.dataset.defaultPermissionLevel ?? dropdown.value);
      row.classList.toggle("is-overridden", permOverridden);
    }
  }

  private buildMcpCard(server: ToolsMcpServerRow): HTMLElement {
    const card = document.createElement("article");
    card.className = "tools-mcp-card";
    card.dataset.serverId = server.id;

    const top = document.createElement("div");
    top.className = "tools-mcp-card-top";

    const info = document.createElement("div");
    info.className = "tools-mcp-card-info";

    const nameRow = document.createElement("div");
    nameRow.className = "tools-mcp-name-row";
    const name = document.createElement("h3");
    name.className = "tools-mcp-name";
    name.textContent = server.name;
    const status = document.createElement("span");
    status.className = `tools-mcp-status is-${server.status}`;
    status.textContent = statusLabel(server.status);
    nameRow.append(name, status);

    const summary = document.createElement("p");
    summary.className = "tools-mcp-transport";
    summary.textContent = server.transportSummary;

    info.append(nameRow, summary);
    if (server.errorMessage) {
      const err = document.createElement("p");
      err.className = "tools-mcp-error";
      err.textContent = server.errorMessage;
      info.append(err);
    }

    const actions = document.createElement("div");
    actions.className = "tools-mcp-actions";

    const enabledLabel = document.createElement("label");
    enabledLabel.className = "tools-mcp-enabled";
    const enabled = document.createElement("input");
    enabled.type = "checkbox";
    enabled.checked = server.enabled;
    enabled.setAttribute("aria-label", `Enable ${server.name}`);
    enabled.addEventListener("change", () => {
      this.onToggleMcp?.(server.id, enabled.checked);
    });
    const enabledText = document.createElement("span");
    enabledText.textContent = "Enabled";
    enabledLabel.append(enabled, enabledText);

    const editBtn = iconButton("Edit", Pencil, () =>
      this.onEditMcp?.(server.id),
    );
    const reconnectBtn = iconButton("Reconnect", RefreshCw, () =>
      this.onReconnectMcp?.(server.id),
    );
    const removeBtn = iconButton("Delete", Trash2, () =>
      this.onRemoveMcp?.(server.id),
    );

    actions.append(enabledLabel, editBtn, reconnectBtn, removeBtn);
    top.append(info, actions);
    card.append(top);

    const toolsBlock = document.createElement("div");
    toolsBlock.className = "tools-mcp-tools";
    if (server.status === "connected") {
      if (server.tools.length === 0) {
        const empty = document.createElement("p");
        empty.className = "tools-mcp-tools-empty";
        empty.textContent = "No tools advertised.";
        toolsBlock.append(empty);
      } else {
        toolsBlock.append(this.buildMcpToolsTable(server.tools));
      }
      card.append(toolsBlock);
    } else if (server.enabled && server.status === "connecting") {
      const pending = document.createElement("p");
      pending.className = "tools-mcp-tools-empty";
      pending.textContent = "Connecting…";
      toolsBlock.append(pending);
      card.append(toolsBlock);
    }

    return card;
  }

  private buildMcpToolsTable(tools: ToolsMcpToolRow[]): HTMLElement {
    const tableWrap = document.createElement("div");
    tableWrap.className = "tools-table-wrap tools-mcp-tools-table-wrap";

    const table = document.createElement("table");
    table.className = "tools-table tools-mcp-tools-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th class="tools-col-name" scope="col">Tool</th>
        <th class="tools-col-desc" scope="col">Description</th>
        <th class="tools-col-calls" scope="col">Calls</th>
        <th class="tools-col-perm" scope="col">Permission</th>
      </tr>
    `;

    const tbody = document.createElement("tbody");
    for (const tool of tools) {
      tbody.append(this.buildMcpToolRow(tool));
    }

    table.append(thead, tbody);
    tableWrap.append(table);
    return tableWrap;
  }

  private buildMcpToolRow(tool: ToolsMcpToolRow): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.dataset.toolName = tool.registryName;
    if (tool.permissionLevel !== tool.defaultPermissionLevel) {
      row.classList.add("is-overridden");
    }

    const nameTd = document.createElement("td");
    nameTd.className = "tools-col-name";
    const nameBlock = document.createElement("div");
    nameBlock.className = "tools-tool-name-block";
    const display = document.createElement("span");
    display.className = "tools-tool-display-name";
    display.textContent = tool.name;
    display.title = tool.name;
    nameBlock.append(display);
    nameTd.append(nameBlock);

    const descTd = document.createElement("td");
    descTd.className = "tools-col-desc";
    descTd.textContent = tool.description || "—";
    descTd.title = tool.description || "";

    const callsTd = document.createElement("td");
    callsTd.className = "tools-col-calls";
    callsTd.textContent = String(tool.callCount ?? 0);

    const permTd = document.createElement("td");
    permTd.className = "tools-col-perm";
    permTd.append(
      this.buildPermissionSelect(
        tool.registryName,
        tool.name,
        tool.permissionLevel,
        tool.defaultPermissionLevel,
      ).el,
    );

    row.append(nameTd, descTd, callsTd, permTd);
    return row;
  }

  private buildOfferToggle(
    toolName: string,
    displayName: string,
    offered: boolean,
    locked: boolean,
  ): HTMLLabelElement {
    const label = document.createElement("label");
    label.className = "tools-offer-label";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = "tools-offer-toggle";
    input.dataset.toolName = toolName;
    input.checked = offered;
    input.disabled = locked;
    if (locked) input.dataset.offerLocked = "1";
    else delete input.dataset.offerLocked;
    input.setAttribute(
      "aria-label",
      locked
        ? `${displayName} is always included`
        : `Include ${displayName} in model tools`,
    );
    if (locked) {
      label.title = "Required tool — always included (cannot defer)";
    }
    input.addEventListener("change", () => {
      if (input.dataset.offerLocked === "1") {
        input.checked = true;
        return;
      }
      this.onOfferChange?.(toolName, input.checked);
    });
    label.append(input);
    return label;
  }

  private buildPermissionSelect(
    toolName: string,
    displayName: string,
    permissionLevel: ToolsPermissionLevel,
    defaultPermissionLevel: ToolsPermissionLevel,
  ): AppDropdown {
    const dropdown = new AppDropdown(
      PERMISSION_OPTIONS.map((option) => ({
        value: String(option.level),
        label:
          option.level === defaultPermissionLevel
            ? `${option.label}*`
            : option.label,
      })),
      String(permissionLevel),
      { className: "tools-permission-select", ariaLabel: `Permission for ${displayName}` },
    );
    dropdown.el.dataset.toolName = toolName;
    dropdown.el.dataset.defaultPermissionLevel = String(defaultPermissionLevel);
    dropdown.addEventListener("change", () => {
      this.onPermissionChange?.(
        toolName,
        Number(dropdown.value) as ToolsPermissionLevel,
      );
    });
    this.permissionDropdowns.set(dropdown.el, dropdown);
    return dropdown;
  }

  private buildGroupTable(tools: ToolsTableRow[]): HTMLElement {
    const tableWrap = document.createElement("div");
    tableWrap.className = "tools-table-wrap";

    const table = document.createElement("table");
    table.className = "tools-table";

    const thead = document.createElement("thead");
    thead.innerHTML = `
      <tr>
        <th class="tools-col-icon" scope="col"><span class="sr-only">Icon</span></th>
        <th class="tools-col-name" scope="col">Name</th>
        <th class="tools-col-desc" scope="col">Description</th>
        <th class="tools-col-calls" scope="col">Calls</th>
        <th class="tools-col-offer" scope="col">Include</th>
        <th class="tools-col-perm" scope="col">Permission</th>
      </tr>
    `;

    const tbody = document.createElement("tbody");
    for (const tool of tools) {
      tbody.append(this.buildRow(tool));
    }

    table.append(thead, tbody);
    tableWrap.append(table);
    return tableWrap;
  }

  private buildRow(tool: ToolsTableRow): HTMLTableRowElement {
    const row = document.createElement("tr");
    row.dataset.toolName = tool.name;
    if (tool.permissionLevel !== tool.defaultPermissionLevel) {
      row.classList.add("is-overridden");
    }

    const meta = getToolDisplayMeta(tool.name);

    const iconTd = document.createElement("td");
    iconTd.className = "tools-col-icon";
    const iconWrap = document.createElement("div");
    iconWrap.className = "tools-tool-icon";
    iconWrap.append(createLucideIcon(meta.icon, { size: 16 }));
    iconTd.append(iconWrap);

    const nameTd = document.createElement("td");
    nameTd.className = "tools-col-name";
    const nameBlock = document.createElement("div");
    nameBlock.className = "tools-tool-name-block";
    const display = document.createElement("span");
    display.className = "tools-tool-display-name";
    display.textContent = tool.displayName;
    display.title = tool.displayName;
    const id = document.createElement("code");
    id.className = "tools-tool-id";
    id.textContent = tool.name;
    id.title = tool.name;
    nameBlock.append(display, id);
    nameTd.append(nameBlock);

    const descTd = document.createElement("td");
    descTd.className = "tools-col-desc";
    descTd.textContent = tool.description;

    const callsTd = document.createElement("td");
    callsTd.className = "tools-col-calls";
    callsTd.textContent = String(tool.callCount ?? 0);

    const offerTd = document.createElement("td");
    offerTd.className = "tools-col-offer";
    offerTd.append(
      this.buildOfferToggle(
        tool.name,
        tool.displayName,
        tool.offered,
        tool.offerLocked === true,
      ),
    );

    const permTd = document.createElement("td");
    permTd.className = "tools-col-perm";
    permTd.append(
      this.buildPermissionSelect(
        tool.name,
        tool.displayName,
        tool.permissionLevel,
        tool.defaultPermissionLevel,
      ).el,
    );

    row.append(iconTd, nameTd, descTd, callsTd, offerTd, permTd);
    return row;
  }
}

function emptyNote(text: string): HTMLElement {
  const el = document.createElement("p");
  el.className = "screen-placeholder";
  el.textContent = text;
  return el;
}

function statusLabel(
  status: ToolsMcpServerRow["status"],
): string {
  switch (status) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "error":
      return "Error";
    default:
      return "Disconnected";
  }
}

function iconButton(
  label: string,
  icon: Parameters<typeof createLucideIcon>[0],
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
