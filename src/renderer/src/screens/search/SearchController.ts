import type { SearchView, SearchWorkspaceGroup } from "./SearchView.js";

export type SearchControllerOptions = {
  onSessionSelect: (sessionId: string) => void;
};

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) {
    throw new Error("jellybot bridge is unavailable");
  }
  return bridge;
}

function groupHitsByWorkspace(
  hits: Array<{
    sessionId: string;
    sessionTitle: string;
    workspaceId: string;
    workspaceName: string;
    workspacePath: string;
    updatedAt: number;
    matchKind: "title" | "message";
    preview: string;
  }>,
): SearchWorkspaceGroup[] {
  const groups = new Map<string, SearchWorkspaceGroup>();
  const order: string[] = [];

  for (const hit of hits) {
    const key = hit.workspaceId || "__none__";
    let group = groups.get(key);
    if (!group) {
      group = {
        workspaceId: hit.workspaceId,
        workspaceName: hit.workspaceName,
        workspacePath: hit.workspacePath,
        hits: [],
      };
      groups.set(key, group);
      order.push(key);
    }
    group.hits.push(hit);
  }

  return order.map((key) => groups.get(key)!);
}

/**
 * Search screen — queries session titles/content via main, groups by workspace.
 */
export class SearchController {
  private query = "";
  private searchTimer: ReturnType<typeof setTimeout> | null = null;
  private requestSerial = 0;

  constructor(
    private readonly view: SearchView,
    private readonly options: SearchControllerOptions,
  ) {
    this.view.setOnSelectSession((sessionId) => {
      this.options.onSessionSelect(sessionId);
    });
    this.view.input.addEventListener("input", () => {
      this.query = this.view.input.value;
      this.scheduleSearch();
    });
    this.view.input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        this.view.input.value = "";
        this.query = "";
        this.view.renderIdle();
      }
    });
  }

  mount(): HTMLElement {
    queueMicrotask(() => this.view.focusInput());
    return this.view.root;
  }

  destroy(): void {
    if (this.searchTimer != null) {
      clearTimeout(this.searchTimer);
      this.searchTimer = null;
    }
    this.view.setOnSelectSession(null);
    this.view.root.remove();
  }

  private scheduleSearch(): void {
    if (this.searchTimer != null) {
      clearTimeout(this.searchTimer);
    }
    const trimmed = this.query.trim();
    if (!trimmed) {
      this.view.renderIdle();
      return;
    }
    this.searchTimer = setTimeout(() => {
      this.searchTimer = null;
      void this.runSearch(trimmed);
    }, 180);
  }

  private async runSearch(query: string): Promise<void> {
    const serial = ++this.requestSerial;
    try {
      const bridge = requireBridge();
      if (typeof bridge.searchSessions !== "function") {
        this.view.renderError("Search is unavailable in this build.");
        return;
      }
      const hits = await bridge.searchSessions(query);
      if (serial !== this.requestSerial) return;
      if (this.view.input.value.trim() !== query) return;

      if (hits.length === 0) {
        this.view.renderEmpty(query);
        return;
      }
      this.view.renderGrouped(groupHitsByWorkspace(hits));
    } catch (err) {
      if (serial !== this.requestSerial) return;
      const message = err instanceof Error ? err.message : String(err);
      this.view.renderError(message);
    }
  }
}
