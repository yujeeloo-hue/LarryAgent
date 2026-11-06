/**
 * Files panel — remote mirror of the desktop Detail → Files tab.
 *
 * Lists files created/edited/mentioned by the open conversation using the
 * same shared derivation as the Mac app (turnModifiedFiles.collectTurnFiles),
 * then enriches/previews through the device's read-only actions:
 *   filterExistingFiles — mention existence gate
 *   getPathsDiffStats   — +N/−M badges
 *   readTextFile        — preview body (1 MB / binary caps live on the device)
 * Older device builds without these actions degrade gracefully: mentions fall
 * back to tool-modified files only, badges disappear, preview shows the
 * device's error text.
 */
import "./filesPanel.css";
import { el } from "./render.js";
import { icon } from "./icons.js";
import { createLinedFileView } from "./toolCards.js";
import { isMarkdownPathOrName } from "./codeHighlight.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";
import { collectTurnFiles } from "../../../src/renderer/src/screens/conversation/turnModifiedFiles.js";
import type { TurnModifiedFile } from "../../../src/renderer/src/screens/conversation/turnModifiedFiles.js";

type FilesAction = "filterExistingFiles" | "getPathsDiffStats" | "readTextFile";

interface DiffStatRow {
  path: string;
  hasDiff: boolean;
  insertions: number;
  deletions: number;
}

type TextPreviewResult =
  | { ok: true; content: string }
  | { ok: false; message: string };

/** Defensively typed session — only the shape collectTurnFiles needs. */
type SessionLike = { messages?: unknown };

function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function isPdfPath(path: string): boolean {
  const base = basename(path);
  const dot = base.lastIndexOf(".");
  return dot >= 0 && base.slice(dot + 1).toLowerCase() === "pdf";
}

function messagesOf(
  session: unknown,
): Array<{ role: string; parts: Array<Record<string, unknown>> }> {
  const messages = (session as SessionLike | null)?.messages;
  if (!Array.isArray(messages)) return [];
  const out: Array<{ role: string; parts: Array<Record<string, unknown>> }> = [];
  for (const message of messages) {
    if (!message || typeof message !== "object") continue;
    const role = (message as { role?: unknown }).role;
    const parts = (message as { parts?: unknown }).parts;
    out.push({
      role: typeof role === "string" ? role : "",
      parts: Array.isArray(parts)
        ? parts.filter(
            (part): part is Record<string, unknown> =>
              !!part && typeof part === "object",
          )
        : [],
    });
  }
  return out;
}

interface FileRow extends TurnModifiedFile {
  hasDiff?: boolean;
  insertions?: number;
  deletions?: number;
}

export interface FilesPanel {
  root: HTMLElement;
  open: (sessionId: string) => void;
  close: () => void;
}

export function createFilesPanel(deps: {
  /** Fresh getSession pull — the panel re-reads on open and on Refresh. */
  loadSession: (sessionId: string) => Promise<unknown>;
  /** Viewer→device read-only action passthrough. */
  deviceRequest: <T>(
    action: FilesAction,
    payload: Record<string, unknown>,
  ) => Promise<T>;
}): FilesPanel {
  let sessionId = "";
  let files: FileRow[] = [];
  let selectedPath = "";
  let refreshSeq = 0;
  let previewSeq = 0;

  const countEl = el("span", { class: "files-panel-count" });
  const refreshBtn = el("button", {
    class: "files-panel-iconbtn", type: "button",
    title: "Refresh", "aria-label": "Refresh file list",
    onclick: () => void refresh(),
  }, icon("refresh", 15)) as HTMLButtonElement;
  const closeBtn = el("button", {
    class: "files-panel-iconbtn", type: "button",
    title: "Close", "aria-label": "Close Files panel",
    onclick: () => close(),
  }, icon("x", 15)) as HTMLButtonElement;

  const listEl = el("div", {
    class: "files-panel-list",
    role: "listbox",
    "aria-label": "Conversation files",
  });
  const previewTitleEl = el("span", { class: "files-panel-preview-title" }, "Preview");
  const previewBackBtn = el("button", {
    class: "files-panel-back", type: "button",
    title: "Back", "aria-label": "Back to file list",
    onclick: () => showList(),
  }, icon("back", 16)) as HTMLButtonElement;
  const previewBody = el("div", { class: "files-panel-preview-body" });

  const card = el("div", {
    class: "files-panel-card",
    role: "dialog",
    "aria-modal": "true",
    "aria-label": "Conversation files",
  },
    el("div", { class: "files-panel-head" },
      el("span", { class: "files-panel-title", "aria-hidden": "true" }, icon("files", 15)),
      el("span", { class: "files-panel-title-text" }, "Files"),
      countEl,
      el("span", { class: "spacer" }),
      refreshBtn,
      closeBtn,
    ),
    el("div", { class: "files-panel-body" },
      el("section", { class: "files-panel-section files-panel-section-list" }, listEl),
      el("section", { class: "files-panel-section files-panel-section-preview" },
        el("div", { class: "files-panel-preview-head" }, previewBackBtn, previewTitleEl),
        previewBody,
      ),
    ),
  );

  const root = el("div", { class: "files-panel", hidden: true },
    el("div", { class: "files-panel-backdrop", onclick: () => close() }),
    card,
  );

  const onKeydown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") close();
  };

  function open(nextSessionId: string): void {
    sessionId = nextSessionId;
    files = [];
    selectedPath = "";
    showList();
    setPreviewStatus("Select a file to preview.");
    root.hidden = false;
    document.addEventListener("keydown", onKeydown);
    void refresh();
  }

  function close(): void {
    document.removeEventListener("keydown", onKeydown);
    root.hidden = true;
  }

  function showList(): void {
    previewSeq++;
    card.classList.remove("is-previewing");
  }

  async function refresh(): Promise<void> {
    const seq = ++refreshSeq;
    const id = sessionId;
    if (!id) return;
    refreshBtn.classList.add("is-busy");
    try {
      const session = await deps.loadSession(id);
      if (seq !== refreshSeq) return;
      if (!session) {
        files = [];
        selectedPath = "";
        renderList("Conversation not found.", true);
        return;
      }
      const collected = await collectTurnFiles(messagesOf(session), async (paths) => {
        const existing = await deps.deviceRequest<string[]>("filterExistingFiles", {
          sessionId: id,
          paths,
        });
        return Array.isArray(existing) ? existing : [];
      });
      if (seq !== refreshSeq) return;
      files = await enrichDiff(collected, id);
      if (seq !== refreshSeq) return;
      if (selectedPath && !files.some((file) => file.path === selectedPath)) {
        selectedPath = "";
        setPreviewStatus("Select a file to preview.");
      }
      renderList(
        files.length === 0
          ? "No created or edited files in this conversation yet."
          : "",
      );
      // Desktop auto-previews the first row; phones stay on the list and
      // preview on row tap (narrow layout swaps panes via is-previewing).
      if (
        !selectedPath &&
        files.length > 0 &&
        window.matchMedia("(min-width: 769px)").matches
      ) {
        selectFile(files[0]!.path, false);
      }
    } catch (err) {
      if (seq !== refreshSeq) return;
      files = [];
      selectedPath = "";
      renderList(err instanceof Error ? err.message : "Failed to load files.", true);
    } finally {
      if (seq === refreshSeq) refreshBtn.classList.remove("is-busy");
    }
  }

  async function enrichDiff(
    rows: TurnModifiedFile[],
    id: string,
  ): Promise<FileRow[]> {
    if (rows.length === 0) return [];
    try {
      const stats = await deps.deviceRequest<DiffStatRow[]>("getPathsDiffStats", {
        sessionId: id,
        paths: rows.map((file) => file.path),
      });
      if (!Array.isArray(stats)) return rows.map((file) => ({ ...file }));
      const byPath = new Map<string, DiffStatRow>();
      for (const row of stats) {
        if (row && typeof row.path === "string") byPath.set(row.path, row);
      }
      return rows.map((file) => {
        const stat = byPath.get(file.path);
        if (!stat?.hasDiff) return { ...file };
        return {
          ...file,
          hasDiff: true,
          insertions: stat.insertions,
          deletions: stat.deletions,
        };
      });
    } catch {
      // Old device or non-repo workspace — badges are pure enrichment.
      return rows.map((file) => ({ ...file }));
    }
  }

  function renderList(statusText: string, isError = false): void {
    listEl.replaceChildren();
    countEl.textContent =
      files.length > 0 ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "";
    for (const file of files) listEl.append(buildRow(file));
    if (statusText) {
      listEl.append(
        el("div", { class: `files-panel-status${isError ? " is-error" : ""}` }, statusText),
      );
    }
  }

  function buildRow(file: FileRow): HTMLElement {
    const metaIcon =
      file.action === "created"
        ? "filePlus"
        : file.action === "edited"
          ? "filePenLine"
          : "fileText";
    const badgeLabel =
      file.action === "created" ? "Created" : file.action === "edited" ? "Edited" : "Mentioned";
    const titleRow = el("div", { class: "files-panel-row-title" },
      el("span", { class: "files-panel-row-name", title: file.name }, file.name),
      el("span", { class: `files-panel-badge is-${file.action}` }, badgeLabel),
    );
    if (file.hasDiff) {
      titleRow.append(
        el("span", { class: "files-panel-diff" },
          el("span", { class: "files-panel-diff-ins" }, `+${file.insertions ?? 0}`),
          el("span", { class: "files-panel-diff-del" }, `−${file.deletions ?? 0}`),
        ),
      );
    }
    const row = el("button", {
      class: "files-panel-row", type: "button", role: "option",
      "data-path": file.path,
      "aria-selected": file.path === selectedPath ? "true" : "false",
      title: file.path,
      onclick: () => selectFile(file.path, true),
    },
      el("span", { class: "files-panel-row-icon", "aria-hidden": "true" }, icon(metaIcon, 15)),
      el("span", { class: "files-panel-row-meta" },
        titleRow,
        el("span", { class: "files-panel-row-path" }, file.path),
      ),
      el("span", { class: "files-panel-row-chevron", "aria-hidden": "true" }, icon("chevronRight", 14)),
    );
    if (file.path === selectedPath) row.classList.add("is-selected");
    return row;
  }

  function selectFile(path: string, fromUser: boolean): void {
    selectedPath = path;
    for (const row of Array.from(listEl.querySelectorAll<HTMLElement>(".files-panel-row"))) {
      const selected = row.dataset.path === path;
      row.classList.toggle("is-selected", selected);
      row.setAttribute("aria-selected", selected ? "true" : "false");
    }
    // Phones push the preview pane; the wide two-column layout ignores this.
    if (fromUser) card.classList.add("is-previewing");
    void loadPreview(path);
  }

  async function loadPreview(path: string): Promise<void> {
    const seq = ++previewSeq;
    const file = files.find((entry) => entry.path === path);
    previewTitleEl.textContent = file?.name ?? basename(path);
    if (isPdfPath(path)) {
      setPreviewStatus("PDF preview is available in the Mac app.");
      return;
    }
    setPreviewStatus("Loading preview…");
    try {
      const result = await deps.deviceRequest<TextPreviewResult>("readTextFile", {
        sessionId,
        path,
      });
      if (seq !== previewSeq) return;
      if (!result || typeof result !== "object" || !("ok" in result)) {
        setPreviewStatus("Preview unavailable.", true);
        return;
      }
      if (result.ok !== true) {
        setPreviewStatus(
          String((result as { message?: unknown }).message ?? "Preview failed."),
          true,
        );
        return;
      }
      const content = String((result as { content?: unknown }).content ?? "");
      const host = setPreviewHost();
      if (isMarkdownPathOrName(path)) {
        const container = el("div", { class: "md-blocks files-panel-preview-markdown" });
        renderMarkdownBlocks(parseMarkdownBlocks(content), container);
        host.append(container);
        return;
      }
      host.append(createLinedFileView(content, { pathOrName: path }));
    } catch (err) {
      if (seq !== previewSeq) return;
      setPreviewStatus(err instanceof Error ? err.message : "Preview failed.", true);
    }
  }

  function setPreviewStatus(text: string, isError = false): void {
    previewBody.replaceChildren(
      el("div", { class: `files-panel-status${isError ? " is-error" : ""}` }, text),
    );
  }

  function setPreviewHost(): HTMLElement {
    const host = el("div", { class: "files-panel-preview-host" });
    previewBody.replaceChildren(host);
    return host;
  }

  return { root, open, close };
}
