import { ChevronLeft, ChevronRight, FileText, Folder, createLucideIcon } from "../../ui/icons.js";
import { renderMarkdownText } from "../conversation/renderMarkdownText.js";
import "./knowledgeSettings.css";

export type KnowledgeDocumentState = {
  summary: KnowledgeDocSummaryView;
  detail: KnowledgeDocDetailView | null;
  loading: boolean;
};

export type KnowledgeViewState = {
  snapshot: KnowledgeListSnapshotView | null;
  document: KnowledgeDocumentState | null;
  busy: boolean;
};

function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, className: string, text = ""): HTMLElementTagNameMap[Tag] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

const SOURCE_LABEL: Record<KnowledgeSourceView, string> = {
  builtin: "",
  user: "Custom",
  override: "Edited",
};

export class KnowledgeSettingsView {
  private readonly rows = new Map<string, HTMLButtonElement>();
  private readonly reader = element("section", "knowledge-document-view");
  private readonly title = element("h2", "knowledge-document-title");
  private readonly source = element("span", "knowledge-row-status");
  private readonly documentBody = element("div", "setting-card-body knowledge-document-body");
  private readonly documentText = element("div", "md-blocks knowledge-document-text");
  private readonly back = element("button", "setting-btn knowledge-document-back");
  private readonly revert = element("button", "setting-btn knowledge-document-revert", "Revert to built-in");
  private readonly documentStatus = element("p", "setting-card-status knowledge-document-feedback");
  private readonly actions = element("div", "setting-card-actions knowledge-document-actions");
  private snapshot: KnowledgeListSnapshotView | null | undefined;
  private readingId: string | null = null;
  private listScroll = 0;
  private markdown: string | undefined;
  private loading: boolean | undefined;
  private openHandler: (doc: KnowledgeDocSummaryView) => void = () => {};
  private backHandler: () => void = () => {};
  private revertHandler: (id: string) => void = () => {};

  constructor(private readonly parts: { card: HTMLElement; body: HTMLElement; status: HTMLElement }) {
    parts.card.classList.add("setting-knowledge-card");
    parts.body.classList.add("setting-knowledge-list-body");
    parts.status.setAttribute("role", "status");
    this.reader.id = "setting-knowledge-document";
    this.reader.hidden = true;
    this.title.id = "setting-knowledge-document-title";
    this.title.tabIndex = -1;
    this.reader.setAttribute("aria-labelledby", this.title.id);
    this.documentBody.tabIndex = 0;
    this.documentBody.setAttribute("role", "region");
    this.documentBody.setAttribute("aria-label", "Document content");
    this.documentBody.append(this.documentText);
    this.back.type = this.revert.type = "button";
    this.back.title = "Back to Knowledge";
    this.back.setAttribute("aria-label", this.back.title);
    this.back.append(createLucideIcon(ChevronLeft, { size: 16 }));
    this.back.addEventListener("click", () => this.backHandler());
    this.revert.addEventListener("click", () => {
      if (this.readingId) this.revertHandler(this.readingId);
    });
    this.actions.hidden = true;
    this.documentStatus.setAttribute("role", "status");
    this.documentStatus.hidden = true;
    this.actions.append(this.documentStatus, this.revert);

    const heading = element("div", "knowledge-document-heading");
    heading.append(this.title, this.source);
    const identity = element("div", "knowledge-document-identity");
    identity.append(this.back, heading);
    const header = element("header", "setting-card-header knowledge-document-toolbar");
    header.append(identity, this.actions);
    this.reader.append(header, this.documentBody);
    parts.card.append(this.reader);
  }

  onOpen(handler: (doc: KnowledgeDocSummaryView) => void): void {
    this.openHandler = handler;
  }

  onBack(handler: () => void): void {
    this.backHandler = handler;
  }

  onRevert(handler: (id: string) => void): void {
    this.revertHandler = handler;
  }

  render(state: KnowledgeViewState): void {
    if (state.snapshot !== this.snapshot) {
      this.snapshot = state.snapshot;
      this.renderList(state.snapshot);
    }
    if (!state.document) {
      this.showList();
      return;
    }
    this.showDocument(state.document, state.busy);
  }

  setStatus(message: string | null, kind: "ok" | "error" | "info" = "info"): void {
    for (const status of [this.parts.status, this.documentStatus]) {
      status.textContent = message ?? "";
      status.hidden = !message;
      status.classList.toggle("is-ok", !!message && kind === "ok");
      status.classList.toggle("is-error", !!message && kind === "error");
    }
    this.actions.hidden = this.revert.hidden && this.documentStatus.hidden;
  }

  private renderList(snapshot: KnowledgeListSnapshotView | null): void {
    this.rows.clear();
    const groups = snapshot?.categories.filter((category) => category.docs.length > 0) ?? [];
    const contents = groups.map((category) => this.group(category));
    if (contents.length === 0) {
      const message = snapshot ? "No knowledge docs yet." : "Loading…";
      contents.push(element("div", "setting-provider-list-empty", message));
    }
    this.parts.body.replaceChildren(...contents);
  }

  private group(category: KnowledgeListSnapshotView["categories"][number]): HTMLElement {
    const section = element("section", "knowledge-group");
    const heading = element("h4", "knowledge-group-title");
    heading.id = `setting-knowledge-group-${category.id}`;
    const folder = createLucideIcon(Folder, { size: 15 });
    folder.classList.add("knowledge-group-icon");
    heading.append(folder, category.title);
    const list = element("ul", "knowledge-rows");
    list.setAttribute("aria-labelledby", heading.id);
    for (const doc of category.docs) list.append(this.row(doc));
    section.append(heading, list);
    return section;
  }

  private row(doc: KnowledgeDocSummaryView): HTMLLIElement {
    const item = element("li", "knowledge-item");
    const button = element("button", "setting-provider-row knowledge-row");
    button.type = "button";
    button.dataset.id = doc.id;
    button.setAttribute("aria-controls", this.reader.id);
    const status = element("span", "knowledge-row-status");
    this.renderSource(doc, status);
    const chevron = createLucideIcon(ChevronRight, { size: 14 });
    chevron.classList.add("knowledge-chevron");
    button.append(createLucideIcon(FileText, { size: 15 }), element("span", "setting-provider-row-title", doc.title), status, chevron);
    button.addEventListener("click", () => this.openHandler(doc));
    this.rows.set(doc.id, button);
    item.append(button);
    return item;
  }

  private renderSource(doc: Pick<KnowledgeDocSummaryView, "source" | "stale">, status: HTMLElement): void {
    status.textContent = doc.stale ? "Update available" : SOURCE_LABEL[doc.source];
    status.classList.toggle("is-stale", doc.stale);
    status.hidden = !status.textContent;
  }

  private showList(): void {
    if (this.readingId === null) return;
    const row = this.rows.get(this.readingId);
    this.readingId = null;
    this.reader.hidden = true;
    this.parts.card.classList.remove("is-reading");
    const viewport = this.parts.card.closest<HTMLElement>(".setting-content");
    if (viewport) viewport.scrollTop = this.listScroll;
    (row ?? this.rows.values().next().value)?.focus({ preventScroll: true });
  }

  private showDocument(selection: KnowledgeDocumentState, busy: boolean): void {
    const { summary, detail, loading } = selection;
    const entering = this.readingId !== summary.id;
    if (entering) {
      const viewport = this.parts.card.closest<HTMLElement>(".setting-content");
      if (viewport) {
        this.listScroll = viewport.scrollTop;
        viewport.scrollTop = 0;
      }
      this.readingId = summary.id;
      this.parts.card.classList.add("is-reading");
      this.reader.hidden = false;
    }

    const doc = detail ?? summary;
    this.title.textContent = doc.title;
    this.renderSource(doc, this.source);
    const focusBack = detail?.source !== "override" && document.activeElement === this.revert;
    this.revert.hidden = detail?.source !== "override";
    this.revert.disabled = busy || loading;
    this.actions.hidden = this.revert.hidden && this.documentStatus.hidden;
    const markdown = detail?.body;
    if (markdown !== this.markdown || (markdown === undefined && loading !== this.loading)) {
      this.markdown = markdown;
      this.loading = loading;
      if (markdown === undefined) {
        this.documentText.replaceChildren(element("p", "setting-field-hint", loading ? "Loading…" : "Document unavailable."));
      } else {
        renderMarkdownText(markdown, this.documentText);
      }
    }
    if (entering) {
      this.documentBody.scrollTop = 0;
      this.title.focus({ preventScroll: true });
    } else if (focusBack) {
      this.back.focus({ preventScroll: true });
    }
  }
}
