import {
  ExternalLink,
  Eye,
  FilePlus,
  FilePenLine,
  FileText,
  FolderOpen,
  Link,
} from "lucide";
import { createLucideIcon } from "../../../ui/originalIcons.js";
import { localFileMediaUrl } from "../../../ui/localFileUrl.js";
import { renderMarkdownText } from "../renderMarkdownText.js";
import type { TurnModifiedFile, TurnUrl } from "../turnModifiedFiles.js";
import { isMarkdownPathOrName } from "./codeHighlight.js";
import { createLinedFileView } from "./LinedFileView.js";

export type TurnModifiedFilesViewInput = {
  files: TurnModifiedFile[];
  urls?: TurnUrl[];
  revealLabel: string;
  onOpen: (path: string) => void;
  onReveal: (path: string) => void;
  onOpenUrl?: (url: string) => void;
  onLoadPreview: (
    path: string,
  ) => Promise<{ ok: true; content: string } | { ok: false; message: string }>;
  onOpenReader?: ((path: string) => void) | undefined;
};

const ACTION_LABEL: Record<TurnModifiedFile["action"], string> = {
  created: "Created",
  edited: "Edited",
  mentioned: "Mentioned",
};

const ACTION_ICON: Record<TurnModifiedFile["action"], typeof FilePlus> = {
  created: FilePlus,
  edited: FilePenLine,
  mentioned: FileText,
};

function actionLabel(action: TurnModifiedFile["action"]): string {
  return ACTION_LABEL[action];
}

function filesHeading(files: TurnModifiedFile[]): string {
  const kinds = (["created", "edited", "mentioned"] as const).filter((kind) =>
    files.some((file) => file.action === kind),
  );
  if (kinds.length === 0) return "Files";
  if (kinds.length === 1) {
    const label = ACTION_LABEL[kinds[0]!];
    return files.length === 1 ? `${label} file` : `${label} files`;
  }
  const labels = kinds.map((kind) => ACTION_LABEL[kind]);
  const last = labels.pop()!;
  return `${labels.join(", ")} & ${last.toLowerCase()} files`;
}

function urlHostname(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function isPdfPath(path: string): boolean {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  return base.slice(dot + 1).toLowerCase() === "pdf";
}

function renderPreviewBody(
  host: HTMLElement,
  path: string,
  content: string,
): void {
  host.replaceChildren();
  if (isMarkdownPathOrName(path)) {
    const container = document.createElement("div");
    container.className = "md-blocks turn-modified-files-preview-markdown";
    renderMarkdownText(content, container);
    host.append(container);
    return;
  }
  host.append(createLinedFileView(content, { pathOrName: path }));
}

function renderPdfPreview(host: HTMLElement, path: string): void {
  host.replaceChildren();
  const frame = document.createElement("iframe");
  frame.className = "turn-modified-files-preview-pdf";
  frame.title = path.split(/[/\\]/).pop() ?? "PDF";
  frame.src = localFileMediaUrl(path);
  host.append(frame);
}

function iconAction(
  icon: typeof Eye,
  title: string,
  onClick: () => void,
): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "turn-modified-files-iconbtn";
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.append(createLucideIcon(icon, { size: 13 }));
  btn.addEventListener("click", onClick);
  return btn;
}

function buildFileItem(
  file: TurnModifiedFile,
  input: TurnModifiedFilesViewInput,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "turn-modified-files-item";

  const row = document.createElement("div");
  row.className = "turn-modified-files-row";

  const icon = createLucideIcon(ACTION_ICON[file.action], { size: 14 });
  icon.classList.add("turn-modified-files-icon");

  const meta = document.createElement("div");
  meta.className = "turn-modified-files-meta";

  const titleRow = document.createElement("div");
  titleRow.className = "turn-modified-files-title-row";

  const name = document.createElement("span");
  name.className = "turn-modified-files-name";
  name.textContent = file.name;
  name.title = file.path;

  const badge = document.createElement("span");
  badge.className = `turn-modified-files-badge is-${file.action}`;
  badge.textContent = actionLabel(file.action);

  titleRow.append(name, badge);

  const path = document.createElement("span");
  path.className = "turn-modified-files-path";
  path.textContent = file.path;
  path.title = file.path;

  meta.append(titleRow, path);

  const actions = document.createElement("div");
  actions.className = "turn-modified-files-actions";

  const useReader = typeof input.onOpenReader === "function";
  const pdf = isPdfPath(file.path);

  const previewBtn = iconAction(
    Eye,
    useReader ? "Open in File Reader" : "Preview",
    () => {
      if (useReader) {
        input.onOpenReader?.(file.path);
        return;
      }
      togglePreview();
    },
  );

  const openBtn = iconAction(ExternalLink, "Open", () =>
    input.onOpen(file.path),
  );
  const revealBtn = iconAction(FolderOpen, input.revealLabel, () =>
    input.onReveal(file.path),
  );

  actions.append(previewBtn, openBtn, revealBtn);
  row.append(icon, meta, actions);
  item.append(row);

  if (useReader) {
    return item;
  }

  const previewPanel = document.createElement("div");
  previewPanel.className = "turn-modified-files-preview";
  previewPanel.hidden = true;

  const previewBody = document.createElement("div");
  previewBody.className = "turn-modified-files-preview-body";
  previewPanel.append(previewBody);

  let open = false;
  let loaded = false;
  let loading = false;

  function togglePreview(): void {
    if (open) {
      open = false;
      previewPanel.hidden = true;
      previewBtn.classList.remove("is-open");
      previewBtn.setAttribute("aria-expanded", "false");
      item.classList.remove("is-preview-open");
      return;
    }
    open = true;
    previewPanel.hidden = false;
    previewBtn.classList.add("is-open");
    previewBtn.setAttribute("aria-expanded", "true");
    item.classList.add("is-preview-open");

    if (loaded || loading) return;

    if (pdf) {
      loaded = true;
      renderPdfPreview(previewBody, file.path);
      return;
    }

    loading = true;
    previewBody.replaceChildren();
    const pending = document.createElement("p");
    pending.className = "turn-modified-files-preview-status";
    pending.textContent = "Loading preview…";
    previewBody.append(pending);

    void input.onLoadPreview(file.path).then((result) => {
      loading = false;
      if (!open) return;
      if (!result.ok) {
        previewBody.replaceChildren();
        const err = document.createElement("p");
        err.className = "turn-modified-files-preview-status is-error";
        err.textContent = result.message;
        previewBody.append(err);
        return;
      }
      loaded = true;
      renderPreviewBody(previewBody, file.path, result.content);
    });
  }

  item.append(previewPanel);
  return item;
}

function buildUrlItem(
  entry: TurnUrl,
  onOpenUrl: ((url: string) => void) | undefined,
): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "turn-modified-files-item is-url";

  const row = document.createElement("div");
  row.className = "turn-modified-files-row";

  const icon = createLucideIcon(Link, { size: 14 });
  icon.classList.add("turn-modified-files-icon");

  const meta = document.createElement("div");
  meta.className = "turn-modified-files-meta";

  const titleRow = document.createElement("div");
  titleRow.className = "turn-modified-files-title-row";

  const link = document.createElement("a");
  link.className = "turn-modified-files-name turn-modified-files-url";
  link.href = entry.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = entry.url;
  link.title = entry.url;
  link.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenUrl?.(entry.url);
  });

  titleRow.append(link);

  const host = document.createElement("span");
  host.className = "turn-modified-files-path";
  host.textContent = urlHostname(entry.url);
  host.title = entry.url;

  meta.append(titleRow, host);

  const actions = document.createElement("div");
  actions.className = "turn-modified-files-actions";
  actions.append(iconAction(ExternalLink, "Open", () => onOpenUrl?.(entry.url)));

  row.append(icon, meta, actions);
  item.append(row);
  return item;
}

function countChip(
  icon: typeof Eye,
  kind: "files" | "links",
  count: number,
  singular: string,
  plural: string,
): HTMLElement {
  const chip = document.createElement("span");
  chip.className = `turn-modified-files-chip is-${kind}`;
  chip.append(
    createLucideIcon(icon, { size: 11 }),
    document.createTextNode(`${count} ${count === 1 ? singular : plural}`),
  );
  return chip;
}

function groupLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "turn-modified-files-group";
  label.textContent = text;
  return label;
}

export function createTurnModifiedFilesView(
  input: TurnModifiedFilesViewInput,
): HTMLElement {
  const urls = input.urls ?? [];
  const root = document.createElement("section");
  root.className = "turn-modified-files";
  root.setAttribute(
    "aria-label",
    input.files.length > 0 && urls.length > 0
      ? `${filesHeading(input.files)} and links`
      : urls.length > 0
        ? "Links"
        : filesHeading(input.files),
  );

  const head = document.createElement("div");
  head.className = "turn-modified-files-head";
  const headIcon = createLucideIcon(FolderOpen, { size: 13 });
  headIcon.classList.add("turn-modified-files-card-icon");
  const title = document.createElement("span");
  title.className = "turn-modified-files-title";
  title.textContent =
    input.files.length > 0 && urls.length > 0
      ? "Files & Links"
      : urls.length > 0
        ? "Links"
        : "Files";
  head.append(headIcon, title);

  const counts = document.createElement("div");
  counts.className = "turn-modified-files-counts";
  if (input.files.length > 0) {
    counts.append(
      countChip(FileText, "files", input.files.length, "file", "files"),
    );
  }
  if (urls.length > 0) {
    counts.append(countChip(Link, "links", urls.length, "link", "links"));
  }
  if (counts.childElementCount > 0) head.append(counts);

  const scroll = document.createElement("div");
  scroll.className = "turn-modified-files-scroll";
  const bothGroups = input.files.length > 0 && urls.length > 0;

  if (input.files.length > 0) {
    const list = document.createElement("ul");
    list.className = "turn-modified-files-list";
    for (const file of input.files) list.append(buildFileItem(file, input));
    if (bothGroups) scroll.append(groupLabel("Files"));
    scroll.append(list);
  }
  if (urls.length > 0) {
    const list = document.createElement("ul");
    list.className = "turn-modified-files-list";
    for (const entry of urls) list.append(buildUrlItem(entry, input.onOpenUrl));
    if (bothGroups) scroll.append(groupLabel("Links"));
    scroll.append(list);
  }

  const fade = document.createElement("div");
  fade.className = "turn-modified-files-fade";
  fade.setAttribute("aria-hidden", "true");
  const syncFade = () => {
    fade.classList.toggle(
      "is-visible",
      scroll.scrollTop + scroll.clientHeight < scroll.scrollHeight - 2,
    );
  };
  scroll.addEventListener("scroll", syncFade, { passive: true });
  requestAnimationFrame(syncFade);

  root.append(head, scroll, fade);
  return root;
}
