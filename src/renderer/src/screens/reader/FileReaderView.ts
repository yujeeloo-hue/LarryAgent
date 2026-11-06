import { Code2, ExternalLink, FolderOpen, List } from "lucide";
// Genuine Lucide outline artwork — the shared filled "functional" icons are
// for tool cards; this window's toolbar matches the file cards that open it
// (TurnModifiedFilesView / Display*CardView all import originalIcons.js).
import { createLucideIcon } from "../../ui/originalIcons.js";

export type FileReaderOutlineEntry = {
  id: string;
  text: string;
  depth: 1 | 2 | 3;
};

export type FileReaderViewMode = "rendered" | "source" | "code" | "pdf" | "image";

/**
 * File Reader window chrome: toolbar (doc id + actions), outline sidebar
 * (Markdown only) and content panes — rendered markdown / line-numbered
 * code / media (PDF frame or image). Loading and kind routing live in
 * FileReaderController.
 */
export class FileReaderView {
  readonly root: HTMLElement;
  readonly outlineButton: HTMLButtonElement;
  readonly sourceButton: HTMLButtonElement;
  readonly revealButton: HTMLButtonElement;
  readonly openButton: HTMLButtonElement;
  readonly outlineNav: HTMLElement;
  readonly docPane: HTMLElement;
  readonly codePane: HTMLElement;
  readonly mediaPane: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly pathEl: HTMLElement;
  private readonly docHost: HTMLElement;
  private readonly codeHost: HTMLElement;
  private readonly mediaHost: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly infoEl: HTMLElement;
  private readonly titlebarEl: HTMLElement;

  constructor(input: { revealLabel: string }) {
    this.root = document.createElement("div");
    this.root.className = "file-reader";
    this.root.setAttribute("role", "main");

    // ---- toolbar (drag region; mac leaves room for traffic lights) ----
    this.titlebarEl = document.createElement("div");
    this.titlebarEl.className = "file-reader-titlebar";

    const docId = document.createElement("div");
    docId.className = "file-reader-doc-id";
    this.nameEl = document.createElement("span");
    this.nameEl.className = "file-reader-name";
    this.pathEl = document.createElement("span");
    this.pathEl.className = "file-reader-path";
    docId.append(this.nameEl, this.pathEl);

    const actions = document.createElement("div");
    actions.className = "file-reader-actions";

    this.outlineButton = document.createElement("button");
    this.outlineButton.type = "button";
    this.outlineButton.className = "file-reader-btn is-on";
    this.outlineButton.title = "Outline";
    this.outlineButton.append(
      createLucideIcon(List, { size: 14 }),
      document.createTextNode("Outline"),
    );

    this.sourceButton = document.createElement("button");
    this.sourceButton.type = "button";
    this.sourceButton.className = "file-reader-btn";
    this.sourceButton.title = "Toggle rendered / source view";
    this.sourceButton.append(
      createLucideIcon(Code2, { size: 14 }),
      document.createTextNode("Source"),
    );

    this.revealButton = document.createElement("button");
    this.revealButton.type = "button";
    this.revealButton.className = "file-reader-btn";
    this.revealButton.title = input.revealLabel;
    this.revealButton.append(
      createLucideIcon(FolderOpen, { size: 14 }),
      document.createTextNode(input.revealLabel),
    );

    this.openButton = document.createElement("button");
    this.openButton.type = "button";
    this.openButton.className = "file-reader-btn";
    this.openButton.title = "Open with default app";
    this.openButton.append(
      createLucideIcon(ExternalLink, { size: 14 }),
      document.createTextNode("Open"),
    );

    actions.append(
      this.outlineButton,
      this.sourceButton,
      this.revealButton,
      this.openButton,
    );
    this.titlebarEl.append(docId, actions);

    // ---- body: outline + panes ----
    const body = document.createElement("div");
    body.className = "file-reader-body";

    const outline = document.createElement("nav");
    outline.className = "file-reader-outline";
    const outlineTitle = document.createElement("div");
    outlineTitle.className = "file-reader-outline-title";
    outlineTitle.textContent = "Outline";
    this.outlineNav = document.createElement("div");
    this.outlineNav.className = "file-reader-outline-nav";
    outline.append(outlineTitle, this.outlineNav);

    this.docPane = document.createElement("div");
    this.docPane.className = "file-reader-pane file-reader-pane-rendered";
    const page = document.createElement("article");
    page.className = "file-reader-doc";
    this.docHost = document.createElement("div");
    this.docHost.className = "md-blocks file-reader-doc-body";
    page.append(this.docHost);
    this.docPane.append(page);

    this.codePane = document.createElement("div");
    this.codePane.className = "file-reader-pane file-reader-pane-code";
    this.codePane.hidden = true;
    this.codeHost = document.createElement("div");
    this.codeHost.className = "file-reader-code";
    this.codePane.append(this.codeHost);

    this.mediaPane = document.createElement("div");
    this.mediaPane.className = "file-reader-pane file-reader-pane-media";
    this.mediaPane.hidden = true;
    this.mediaHost = document.createElement("div");
    this.mediaHost.className = "file-reader-media";
    this.mediaPane.append(this.mediaHost);

    body.append(outline, this.docPane, this.codePane, this.mediaPane);

    // ---- foot ----
    const foot = document.createElement("div");
    foot.className = "file-reader-foot";
    this.statusEl = document.createElement("span");
    this.statusEl.className = "file-reader-status";
    this.infoEl = document.createElement("span");
    this.infoEl.className = "file-reader-info";
    this.infoEl.textContent = "No document";
    foot.append(this.statusEl, this.infoEl);

    this.root.append(this.titlebarEl, body, foot);
    this.setStatus("rendered");
  }

  /**
   * Windows-only chrome: dog-head brand at the titlebar's leading edge,
   * caption buttons flush right after the actions. Called only on win32
   * (native title bar hidden); macOS keeps the traffic-light padding.
   */
  mountWindowsChrome(brand: HTMLElement, captionGroup: HTMLElement): void {
    brand.classList.add("file-reader-brand");
    this.titlebarEl.prepend(brand);
    this.titlebarEl.append(captionGroup);
  }

  setDocumentMeta(name: string, path: string): void {
    this.nameEl.textContent = name;
    this.pathEl.textContent = path;
    this.pathEl.title = path;
  }

  /** Host for rendered markdown blocks (replaced per document). */
  getDocHost(): HTMLElement {
    return this.docHost;
  }

  /** Host for the line-numbered code view (replaced per document). */
  getCodeHost(): HTMLElement {
    return this.codeHost;
  }

  /** Host for the media view — PDF iframe or image (replaced per document). */
  getMediaHost(): HTMLElement {
    return this.mediaHost;
  }

  /** Markdown-only controls (Outline / Source); hidden for other kinds. */
  setMarkdownControlsVisible(visible: boolean): void {
    this.outlineButton.hidden = !visible;
    this.sourceButton.hidden = !visible;
  }

  setStatus(mode: FileReaderViewMode): void {
    this.statusEl.replaceChildren();
    const label =
      mode === "rendered"
        ? "View · Rendered"
        : mode === "source"
          ? "View · Source"
          : mode === "code"
            ? "View · Code"
            : mode === "pdf"
              ? "View · PDF"
              : "View · Image";
    if (mode === "rendered" || mode === "code") {
      const dot = document.createElement("span");
      dot.className = "file-reader-status-dot";
      this.statusEl.append(dot);
    }
    this.statusEl.append(document.createTextNode(label));
  }

  setInfo(text: string): void {
    this.infoEl.textContent = text;
  }

  setOutline(entries: FileReaderOutlineEntry[]): void {
    this.outlineNav.replaceChildren();
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "file-reader-outline-empty";
      empty.textContent = "No headings";
      this.outlineNav.append(empty);
      return;
    }
    for (const entry of entries) {
      const link = document.createElement("a");
      link.className = `file-reader-outline-link l${entry.depth}`;
      link.href = `#${entry.id}`;
      link.textContent = entry.text;
      link.title = entry.text;
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const target = document.getElementById(entry.id);
        target?.scrollIntoView({ behavior: "smooth", block: "start" });
      });
      this.outlineNav.append(link);
    }
  }

  setOutlineVisible(visible: boolean): void {
    const outline = this.outlineNav.closest<HTMLElement>(".file-reader-outline");
    if (outline) outline.hidden = !visible;
    this.outlineButton.classList.toggle("is-on", visible);
  }

  /** Show exactly one pane; panes keep their own scroll position. */
  showPane(pane: "doc" | "code" | "media"): void {
    this.docPane.hidden = pane !== "doc";
    this.codePane.hidden = pane !== "code";
    this.mediaPane.hidden = pane !== "media";
    // A hidden pane keeps scrollTop; nothing to do — visibility only.
  }

  /** Rendered ↔ source flip for Markdown (both panes stay mounted). */
  setSourceMode(source: boolean): void {
    this.docPane.hidden = source;
    this.codePane.hidden = !source;
    this.mediaPane.hidden = true;
    this.sourceButton.classList.toggle("is-on", source);
    this.setStatus(source ? "source" : "rendered");
  }

  showPlaceholder(message: string): void {
    this.docHost.replaceChildren();
    const empty = document.createElement("p");
    empty.className = "file-reader-placeholder";
    empty.textContent = message;
    this.docHost.append(empty);
    this.docPane.hidden = false;
    this.codePane.hidden = true;
    this.mediaPane.hidden = true;
  }
}
