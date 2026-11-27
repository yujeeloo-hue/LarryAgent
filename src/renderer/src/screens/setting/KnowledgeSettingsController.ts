import { showConfirm } from "../../ui/messageDialogs.js";
import type { KnowledgeDocumentState, KnowledgeSettingsView, KnowledgeViewState } from "./KnowledgeSettingsView.js";

type KnowledgeBridge = Pick<NonNullable<Window["jellybot"]>, "listKnowledge" | "readKnowledge" | "revertKnowledge">;

export class KnowledgeSettingsController {
  private readonly state: KnowledgeViewState = { snapshot: null, document: null, busy: false };
  private disposed = false;
  private snapshotRequest = 0;
  private documentRequest = 0;

  constructor(
    private readonly view: KnowledgeSettingsView,
    private readonly bridge: () => KnowledgeBridge | undefined = () => window.jellybot,
    private readonly confirm: (message: string) => Promise<boolean> = (message) =>
      showConfirm(message, { title: "Revert to built-in", confirmLabel: "Revert", destructive: true }),
  ) {
    view.onOpen((doc) => void this.open(doc));
    view.onBack(() => this.back());
    view.onRevert((id) => void this.revert(id));
    this.render();
  }

  async refresh(): Promise<void> {
    const bridge = this.bridge();
    if (this.disposed || !bridge || typeof bridge.listKnowledge !== "function") return;
    const request = ++this.snapshotRequest;
    try {
      const snapshot = await bridge.listKnowledge();
      if (this.disposed || request !== this.snapshotRequest) return;
      this.setSnapshot(snapshot);
      if (this.state.document) await this.loadDocument(this.state.document, bridge);
      else this.render();
    } catch (error) {
      if (!this.disposed && request === this.snapshotRequest) this.view.setStatus(this.message(error), "error");
    }
  }

  destroy(): void {
    this.disposed = true;
  }

  private render(): void {
    this.view.render(this.state);
  }

  private setSnapshot(snapshot: KnowledgeListSnapshotView): void {
    this.state.snapshot = snapshot;
    const selection = this.state.document;
    if (!selection) return;
    for (const category of snapshot.categories) {
      const summary = category.docs.find((doc) => doc.id === selection.summary.id);
      if (summary) {
        selection.summary = summary;
        break;
      }
    }
  }

  private async open(summary: KnowledgeDocSummaryView): Promise<void> {
    const bridge = this.bridge();
    if (this.disposed || !bridge) return;
    const selection = { summary, detail: null, loading: true };
    this.state.document = selection;
    this.view.setStatus(null);
    await this.loadDocument(selection, bridge);
  }

  private back(): void {
    this.state.document = null;
    this.view.setStatus(null);
    this.render();
  }

  private async loadDocument(selection: KnowledgeDocumentState, bridge: KnowledgeBridge): Promise<boolean> {
    const request = ++this.documentRequest;
    const isCurrent = () => !this.disposed && this.state.document === selection && request === this.documentRequest;
    selection.loading = true;
    this.render();
    try {
      const detail = await bridge.readKnowledge({ id: selection.summary.id });
      if (!isCurrent()) return false;
      selection.detail = detail;
      return detail !== null;
    } catch (error) {
      if (isCurrent()) this.view.setStatus(this.message(error), "error");
      return false;
    } finally {
      if (isCurrent()) {
        selection.loading = false;
        this.render();
      }
    }
  }

  private async revert(id: string): Promise<void> {
    const bridge = this.bridge();
    const selection = this.state.document;
    if (this.disposed || !bridge || this.state.busy || selection?.detail?.source !== "override" || selection.summary.id !== id || selection.loading) return;
    this.state.busy = true;
    this.render();
    try {
      const confirmed = await this.confirm(`Discard your edits to “${selection.detail.title}”?`);
      if (!confirmed || this.disposed || this.state.document !== selection) return;
      this.view.setStatus(null);
      const snapshot = await bridge.revertKnowledge({ id });
      if (this.disposed) return;
      this.snapshotRequest += 1;
      this.setSnapshot(snapshot);
      const current = this.state.document;
      if (current?.summary.id === id) {
        current.detail = null;
        if (await this.loadDocument(current, bridge)) this.view.setStatus("Restored to built-in.", "ok");
      }
    } catch (error) {
      if (!this.disposed) this.view.setStatus(this.message(error), "error");
    } finally {
      if (!this.disposed) {
        this.state.busy = false;
        this.render();
      }
    }
  }

  private message(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
