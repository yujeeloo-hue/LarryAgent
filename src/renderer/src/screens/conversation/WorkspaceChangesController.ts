import { buildHunkLineDiff } from "./cards/buildHunkDiff.js";
import { createDiffLinedFileView } from "./cards/DiffLinedFileView.js";
import { createSideBySideFileView } from "./cards/SideBySideDiffView.js";
import {
  WorkspaceChangesView,
  type WorkspaceChangesFileRow,
} from "./WorkspaceChangesView.js";

function requireBridge() {
  const bridge = window.jellybot;
  if (!bridge) throw new Error("jellybot bridge unavailable");
  return bridge;
}

function fileName(path: string): string {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
}

type TextDiff = {
  path: string;
  before: string;
  after: string;
  truncated: boolean;
};

/**
 * Changes window logic — loads dirty file list + per-file diffs.
 */
export class WorkspaceChangesController {
  private readonly view = new WorkspaceChangesView();
  private workspacePath = "";
  private files: WorkspaceChangesFileRow[] = [];
  private selectedPath = "";
  private listSeq = 0;
  private diffSeq = 0;
  private wired = false;
  private compareMode = false;
  private lastTextDiff: TextDiff | null = null;

  private ensureWired(): void {
    if (this.wired) return;
    this.wired = true;
    this.view.onClose(() => {
      this.close();
    });
    this.view.onRefresh(() => {
      void this.refresh();
    });
    this.view.onCompareToggle(() => {
      this.compareMode = !this.compareMode;
      this.view.setCompareActive(this.compareMode);
      if (this.lastTextDiff) this.renderTextDiff(this.lastTextDiff);
    });
    this.view.onSelect((path) => {
      void this.selectFile(path);
    });
    this.view.setRevealLabel(revealLabelForPlatform());
    this.view.onReveal((path) => {
      void this.revealFile(path);
    });
  }

  mount(host: HTMLElement): void {
    this.ensureWired();
    this.view.mount(host);
  }

  /** Windows-only: brand + caption buttons (native title bar hidden). */
  mountWindowsChrome(brand: HTMLElement, captionGroup: HTMLElement): void {
    this.view.mountWindowsChrome(brand, captionGroup);
  }

  setWorkspacePath(workspacePath: string): void {
    this.ensureWired();
    this.workspacePath = workspacePath.trim();
    this.selectedPath = "";
    this.lastTextDiff = null;
    void this.refresh();
  }

  close(): void {
    this.listSeq += 1;
    this.diffSeq += 1;
    this.view.unmount();
    const bridge = window.jellybot;
    if (bridge?.closeWorkspaceChangesWindow) {
      void bridge.closeWorkspaceChangesWindow();
      return;
    }
    window.close();
  }

  async refresh(): Promise<void> {
    const seq = ++this.listSeq;
    const path = this.workspacePath;
    if (!path) {
      this.files = [];
      this.selectedPath = "";
      this.view.setFiles([], "");
      this.view.setPreviewTitle("Select a file");
      this.view.setPreviewMessage("No workspace path.");
      return;
    }

    this.view.setBusy(true);
    try {
      const result = await requireBridge().listWorkingTreeChanges(path);
      if (seq !== this.listSeq) return;
      this.files = (result.files ?? []).map((f) => ({
        path: f.path,
        name: fileName(f.path),
        status: f.status,
        insertions: f.insertions,
        deletions: f.deletions,
        binary: f.binary,
      }));

      if (
        this.selectedPath &&
        !this.files.some((f) => f.path === this.selectedPath)
      ) {
        this.selectedPath = "";
      }
      if (!this.selectedPath && this.files.length > 0) {
        this.selectedPath = this.files[0]!.path;
      }

      this.view.setFiles(this.files, this.selectedPath);

      if (this.files.length === 0) {
        this.lastTextDiff = null;
        this.view.setPreviewTitle("Select a file");
        this.view.setPreviewMessage("No changes.");
        return;
      }

      if (this.selectedPath) {
        await this.selectFile(this.selectedPath);
      }
    } catch (err) {
      if (seq !== this.listSeq) return;
      console.error("[changes] list failed", err);
      this.files = [];
      this.selectedPath = "";
      this.view.setFiles([], "");
      this.view.setPreviewTitle("Select a file");
      this.view.setPreviewMessage(
        err instanceof Error ? err.message : "Failed to load changes",
        true,
      );
    } finally {
      if (seq === this.listSeq) {
        this.view.setBusy(false);
      }
    }
  }

  private async selectFile(relativePath: string): Promise<void> {
    this.selectedPath = relativePath;
    this.view.setFiles(this.files, relativePath);
    this.view.setPreviewTitle(relativePath);
    this.view.setPreviewLoading();

    const seq = ++this.diffSeq;
    const workspacePath = this.workspacePath;
    const row = this.files.find((f) => f.path === relativePath);
    this.lastTextDiff = null;

    if (row?.binary) {
      this.view.setPreviewMessage("Binary file — diff preview unavailable.");
      return;
    }

    try {
      const diff = await requireBridge().getWorkingTreePathDiff(
        workspacePath,
        relativePath,
      );
      if (seq !== this.diffSeq) return;

      if (diff.binary) {
        this.view.setPreviewMessage("Binary file — diff preview unavailable.");
        return;
      }

      if (!diff.before && !diff.after) {
        this.view.setPreviewMessage("No text content to preview.");
        return;
      }

      this.lastTextDiff = {
        path: relativePath,
        before: diff.before,
        after: diff.after,
        truncated: diff.truncated,
      };
      this.renderTextDiff(this.lastTextDiff);
    } catch (err) {
      if (seq !== this.diffSeq) return;
      console.error("[changes] pathDiff failed", err);
      this.view.setPreviewMessage(
        err instanceof Error ? err.message : "Failed to load diff",
        true,
      );
    }
  }

  /** Render the cached text diff with the current preview mode. */
  private renderTextDiff(diff: TextDiff): void {
    const lines = buildHunkLineDiff(diff.before, diff.after);
    const el = this.compareMode
      ? createSideBySideFileView(lines, { pathOrName: diff.path })
      : createDiffLinedFileView(lines, { pathOrName: diff.path });
    const notice = diff.truncated
      ? "Diff truncated for preview (file is large)."
      : undefined;
    this.view.setPreviewDiff(el, notice);
  }

  /** Reveal one dirty file in the OS file manager (Finder/Explorer). */
  private async revealFile(relativePath: string): Promise<void> {
    const root = this.workspacePath;
    const rel = relativePath.trim().replace(/\\/g, "/");
    if (!root || !rel || rel.startsWith("/")) return;
    try {
      await requireBridge().showItemInFolder(
        joinWorkspaceFilePath(root, rel),
      );
    } catch (err) {
      console.error("[changes] showItemInFolder failed", err);
    }
  }
}

function revealLabelForPlatform(): string {
  const platform = window.jellybot?.platform ?? "";
  if (platform === "darwin") return "Reveal in Finder";
  if (platform === "win32") return "Show in Explorer";
  return "Show in Folder";
}

/**
 * Join a repo-relative changes path onto the workspace root. Git/SVN
 * statuses are "/"-separated; on a "\"-rooted (Windows) workspace the
 * result is normalized to "\" so shell.showItemInFolder resolves it.
 */
function joinWorkspaceFilePath(root: string, relativePath: string): string {
  const base = root.replace(/[\\/]+$/, "");
  const rel = relativePath.replace(/^\/+/, "");
  const win = base.includes("\\");
  return `${base}${win ? "\\" : "/"}${win ? rel.split("/").join("\\") : rel}`;
}
