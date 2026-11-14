import { renderMarkdownTextAsync } from "../conversation/renderMarkdownText.js";
import { isMarkdownPathOrName } from "../conversation/cards/codeHighlight.js";
import { createLinedFileView } from "../conversation/cards/LinedFileView.js";
import { localFileMediaUrl } from "../../ui/localFileUrl.js";
import type { FileReaderOutlineEntry } from "./FileReaderView.js";
import { FileReaderView } from "./FileReaderView.js";

function requireBridge(): NonNullable<Window["jellybot"]> {
  const bridge = window.jellybot;
  if (!bridge) throw new Error("jellybot bridge unavailable");
  return bridge;
}

function fileExtension(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return "";
  return base.slice(dot + 1).toLowerCase();
}

function fileBaseName(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "avif",
  "ico",
]);

type ReaderKind = "markdown" | "code" | "pdf" | "image";

function readerKindForPath(path: string): ReaderKind {
  const ext = fileExtension(path);
  if (isMarkdownPathOrName(path)) return "markdown";
  if (ext === "pdf") return "pdf";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  return "code";
}

function splitLineCount(content: string): number {
  if (content.length === 0) return 0;
  return content.split(/\r\n|\r|\n/).length;
}

function formatKb(content: string): string {
  const bytes = new Blob([content]).size;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * File Reader window logic. Routes by kind:
 * - Markdown → rendered chat pipeline + heading outline + source toggle
 * - Code / text → line-numbered syntax-highlighted view (LinedFileView)
 * - PDF → embedded frame via the local file protocol
 * - Image → inline <img> via the local file protocol
 */
export class FileReaderController {
  private readonly view: FileReaderView;
  private documentPath = "";
  private kind: ReaderKind = "markdown";
  private content: string | null = null;
  private sourceBuilt = false;
  private loadGeneration = 0;
  private outlineEntries: FileReaderOutlineEntry[] = [];
  private outlineVisible = true;
  private spyFrame = 0;

  constructor() {
    const isMac = requireBridge().platform === "darwin";
    this.view = new FileReaderView({
      revealLabel: isMac ? "Reveal in Finder" : "Show in Folder",
    });
    this.wireActions();
  }

  mount(host: HTMLElement): void {
    host.replaceChildren(this.view.root);
    this.view.showPlaceholder("Loading…");
  }

  /** Windows-only: dog-head brand + caption buttons (native title bar hidden). */
  mountWindowsChrome(brand: HTMLElement, captionGroup: HTMLElement): void {
    this.view.mountWindowsChrome(brand, captionGroup);
  }

  setDocument(path: string): void {
    const trimmed = path.trim();
    if (!trimmed) return;
    this.documentPath = trimmed;
    this.kind = readerKindForPath(trimmed);
    this.content = null;
    this.sourceBuilt = false;
    const generation = ++this.loadGeneration;

    const name = fileBaseName(trimmed);
    this.view.setDocumentMeta(name, trimmed);
    this.view.setInfo(name);
    document.title = name || "File Reader";
    this.view.docPane.scrollTop = 0;
    this.view.codePane.scrollTop = 0;
    this.view.mediaPane.scrollTop = 0;

    // Markdown-only chrome: Outline / Source buttons + sidebar.
    const isMarkdown = this.kind === "markdown";
    this.view.setMarkdownControlsVisible(isMarkdown);
    if (!isMarkdown && this.outlineVisible) {
      this.outlineVisible = false;
      this.view.setOutlineVisible(false);
    }
    if (isMarkdown && !this.outlineVisible) {
      // Keep the user's hide choice across markdown documents.
    }

    switch (this.kind) {
      case "pdf":
        this.loadPdf(trimmed, name);
        return;
      case "image":
        this.loadImage(trimmed, name);
        return;
      case "code":
        this.loadCode(trimmed, name, generation);
        return;
      case "markdown":
        this.loadMarkdown(trimmed, name, generation);
        return;
    }
  }

  // ------------------------------------------------------------- markdown

  private loadMarkdown(path: string, name: string, generation: number): void {
    this.view.setSourceMode(false);
    this.view.showPlaceholder("Loading…");
    this.view.setOutline([]);
    void requireBridge()
      .readTextFile(path)
      .then((result) => {
        if (generation !== this.loadGeneration) return;
        if (!result.ok) {
          this.view.showPlaceholder(`Could not load file — ${result.message}`);
          this.view.setInfo(`${name} · load failed`);
          return;
        }
        this.content = result.content;
        this.view.setInfo(
          `${name} · ${splitLineCount(result.content)} lines · ${formatKb(result.content)}`,
        );
        void this.renderDocument(generation);
      })
      .catch((err: unknown) => {
        if (generation !== this.loadGeneration) return;
        const message = err instanceof Error ? err.message : String(err);
        this.view.showPlaceholder(`Could not load file — ${message}`);
        this.view.setInfo(`${name} · load failed`);
      });
  }

  private async renderDocument(generation: number): Promise<void> {
    const content = this.content;
    if (content === null) return;
    const host = this.view.getDocHost();
    host.replaceChildren();
    try {
      // Same pipeline as chat: awaits Mermaid cards before outline scan.
      await renderMarkdownTextAsync(content, host);
    } catch (err) {
      console.error("[file-reader] render failed", err);
    }
    if (generation !== this.loadGeneration) return;
    this.buildOutline();
    this.syncOutlineSpy();
  }

  /** Assign stable ids to h1–h3 and mirror them into the outline nav. */
  private buildOutline(): void {
    const host = this.view.getDocHost();
    const headings = [...host.querySelectorAll<HTMLElement>("h1, h2, h3")];
    this.outlineEntries = headings.map((heading, index) => {
      const id = heading.id || `fr-h-${index}`;
      heading.id = id;
      const depth =
        heading.tagName === "H1" ? 1 : heading.tagName === "H2" ? 2 : 3;
      return { id, text: (heading.textContent ?? "").trim(), depth };
    });
    this.view.setOutline(this.outlineEntries);
  }

  /** Highlight the outline entry for the topmost heading above the fold. */
  private syncOutlineSpy(): void {
    if (this.kind !== "markdown") return;
    const links = [
      ...this.view.outlineNav.querySelectorAll<HTMLElement>(
        ".file-reader-outline-link",
      ),
    ];
    if (links.length === 0) return;
    let active = -1;
    this.outlineEntries.forEach((entry, index) => {
      const el = document.getElementById(entry.id);
      if (el && el.getBoundingClientRect().top < 120) active = index;
    });
    links.forEach((link, index) => {
      link.classList.toggle("active", index === active);
    });
  }

  private scheduleSpy(): void {
    if (this.spyFrame !== 0) return;
    this.spyFrame = requestAnimationFrame(() => {
      this.spyFrame = 0;
      this.syncOutlineSpy();
    });
  }

  private buildSourceView(): void {
    if (this.sourceBuilt || this.content === null) return;
    this.sourceBuilt = true;
    const host = this.view.getCodeHost();
    host.replaceChildren();
    host.append(
      createLinedFileView(this.content, { pathOrName: this.documentPath }),
    );
  }

  // ----------------------------------------------------------------- code

  private loadCode(path: string, name: string, generation: number): void {
    this.view.showPane("code");
    this.view.setStatus("code");
    this.view.getCodeHost().replaceChildren();
    const loading = document.createElement("p");
    loading.className = "file-reader-placeholder";
    loading.textContent = "Loading…";
    this.view.getCodeHost().append(loading);
    void requireBridge()
      .readTextFile(path)
      .then((result) => {
        if (generation !== this.loadGeneration) return;
        const host = this.view.getCodeHost();
        host.replaceChildren();
        if (!result.ok) {
          const err = document.createElement("p");
          err.className = "file-reader-placeholder";
          err.textContent = `Could not load file — ${result.message}`;
          host.append(err);
          this.view.setInfo(`${name} · load failed`);
          return;
        }
        this.content = result.content;
        this.view.setInfo(
          `${name} · ${splitLineCount(result.content)} lines · ${formatKb(result.content)}`,
        );
        host.append(
          createLinedFileView(result.content, { pathOrName: path }),
        );
      })
      .catch((err: unknown) => {
        if (generation !== this.loadGeneration) return;
        const message = err instanceof Error ? err.message : String(err);
        const host = this.view.getCodeHost();
        host.replaceChildren();
        const el = document.createElement("p");
        el.className = "file-reader-placeholder";
        el.textContent = `Could not load file — ${message}`;
        host.append(el);
        this.view.setInfo(`${name} · load failed`);
      });
  }

  // ----------------------------------------------------------------- media

  private loadPdf(path: string, name: string): void {
    const host = this.view.getMediaHost();
    host.replaceChildren();
    const frame = document.createElement("iframe");
    frame.className = "file-reader-media-frame";
    frame.title = name;
    frame.src = localFileMediaUrl(path);
    host.append(frame);
    this.view.showPane("media");
    this.view.setStatus("pdf");
    this.view.setInfo(name);
  }

  private loadImage(path: string, name: string): void {
    const host = this.view.getMediaHost();
    host.replaceChildren();
    const img = document.createElement("img");
    img.className = "file-reader-media-img";
    img.alt = name;
    img.src = localFileMediaUrl(path);
    host.append(img);
    this.view.showPane("media");
    this.view.setStatus("image");
    this.view.setInfo(name);
  }

  // -------------------------------------------------------------- actions

  private wireActions(): void {
    this.view.outlineButton.addEventListener("click", () => {
      this.outlineVisible = !this.outlineVisible;
      this.view.setOutlineVisible(this.outlineVisible);
    });

    this.view.sourceButton.addEventListener("click", () => {
      if (this.kind !== "markdown" || this.content === null) return;
      this.buildSourceView();
      const toSource = !this.view.sourceButton.classList.contains("is-on");
      this.view.setSourceMode(toSource);
    });

    this.view.revealButton.addEventListener("click", () => {
      if (!this.documentPath) return;
      void requireBridge().showItemInFolder(this.documentPath);
    });

    this.view.openButton.addEventListener("click", () => {
      if (!this.documentPath) return;
      void requireBridge().openPath(this.documentPath);
    });

    this.view.docPane.addEventListener("scroll", () => this.scheduleSpy(), {
      passive: true,
    });
  }
}
