import { Package, Search } from "lucide";
import { createLucideIcon } from "../../ui/icons.js";
import "./search.css";

export type SearchResultHit = {
  sessionId: string;
  sessionTitle: string;
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  updatedAt: number;
  matchKind: "title" | "message";
  preview: string;
};

export type SearchWorkspaceGroup = {
  workspaceId: string;
  workspaceName: string;
  workspacePath: string;
  hits: SearchResultHit[];
};

export class SearchView {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  readonly results: HTMLElement;
  private onSelectSession: ((sessionId: string) => void) | null = null;

  constructor() {
    this.root = document.createElement("section");
    this.root.className = "screen search-screen";

    const header = document.createElement("div");
    header.className = "screen-header";
    header.innerHTML = `
      <h1 class="screen-title">Search</h1>
      <p class="screen-subtitle">Find tasks by title or message content.</p>
    `;

    const body = document.createElement("div");
    body.className = "screen-body";

    const field = document.createElement("label");
    field.className = "search-field";
    const hidden = document.createElement("span");
    hidden.className = "visually-hidden";
    hidden.textContent = "Search";
    const icon = createLucideIcon(Search, { size: 15 });
    icon.classList.add("search-field-icon");
    this.input = document.createElement("input");
    this.input.type = "search";
    this.input.className = "search-input";
    this.input.placeholder = "Search tasks…";
    this.input.autocomplete = "off";
    this.input.spellcheck = false;
    field.append(hidden, icon, this.input);

    this.results = document.createElement("div");
    this.results.className = "search-results";
    this.results.setAttribute("role", "list");

    body.append(field, this.results);
    this.root.append(header, body);
    this.renderIdle();
  }

  setOnSelectSession(handler: ((sessionId: string) => void) | null): void {
    this.onSelectSession = handler;
  }

  focusInput(): void {
    this.input.focus();
  }

  renderIdle(): void {
    this.results.replaceChildren();
  }

  renderEmpty(query: string): void {
    this.results.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "screen-placeholder";
    empty.textContent = `No results for “${query}”.`;
    this.results.append(empty);
  }

  renderError(message: string): void {
    this.results.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "screen-placeholder search-error";
    empty.textContent = message;
    this.results.append(empty);
  }

  renderGrouped(groups: SearchWorkspaceGroup[]): void {
    this.results.replaceChildren();
    if (groups.length === 0) {
      this.renderIdle();
      return;
    }

    for (const group of groups) {
      const section = document.createElement("section");
      section.className = "search-workspace-group";
      section.setAttribute("role", "group");
      section.setAttribute("aria-label", group.workspaceName);

      const heading = document.createElement("div");
      heading.className = "search-workspace-heading";

      const icon = createLucideIcon(Package, { size: 14 });
      icon.classList.add("search-workspace-icon");

      const titleWrap = document.createElement("div");
      titleWrap.className = "search-workspace-title-wrap";

      const name = document.createElement("h2");
      name.className = "search-workspace-name";
      name.textContent = group.workspaceName;

      titleWrap.append(name);
      if (group.workspacePath.trim()) {
        const path = document.createElement("p");
        path.className = "search-workspace-path";
        path.textContent = group.workspacePath;
        path.title = group.workspacePath;
        titleWrap.append(path);
      }

      const count = document.createElement("span");
      count.className = "search-workspace-count";
      count.textContent = String(group.hits.length);

      heading.append(icon, titleWrap, count);

      const list = document.createElement("div");
      list.className = "search-hit-list";

      for (const hit of group.hits) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "search-hit-row";
        row.setAttribute("role", "listitem");

        const title = document.createElement("div");
        title.className = "search-hit-title";
        title.textContent = hit.sessionTitle;

        const preview = document.createElement("div");
        preview.className = "search-hit-preview";
        preview.textContent =
          hit.matchKind === "title"
            ? "Matched task title"
            : hit.preview || "Matched message content";

        const meta = document.createElement("div");
        meta.className = "search-hit-meta";
        meta.textContent =
          hit.matchKind === "title" ? "Title" : "Message";

        row.append(title, preview, meta);
        row.addEventListener("click", () => {
          this.onSelectSession?.(hit.sessionId);
        });
        list.append(row);
      }

      section.append(heading, list);
      this.results.append(section);
    }
  }
}
