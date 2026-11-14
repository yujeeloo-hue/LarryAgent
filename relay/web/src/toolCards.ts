import { createAskUserPanel, createAskUserAnswerView } from "../../../src/shared/askUserPanel.js";
export { createAskUserPanel } from "../../../src/shared/askUserPanel.js";
import { demoCardStateFor } from "../../../src/session/demoCardState.js";
import type { DemoCardState, DemoSettled, DemoSubmitReceipt } from "../../../src/session/demoCardState.js";
/**
 * Rich tool invocation cards — Mac-parity port of ToolInvocationCardView +
 * AskUserPanelView + Lined/DiffLinedFileView + toolInvocationOutputBody.
 * DOM skeleton and class names match the desktop app (content-cards family).
 * Code renders with highlight.js tokens via codeHighlight.ts (Mac parity).
 */
import { diffLines } from "diff";
import {
  highlightCodeHtml,
  isMarkdownPathOrName,
  resolveHighlightLanguage,
} from "./codeHighlight.js";
import { icon } from "./icons.js";
import { toolMeta } from "./toolDisplay.js";
import { el } from "./render.js";
import { parseMarkdownBlocks, renderMarkdownBlocks } from "./markdown.js";
import {
  parseUploadFinished,
  seedUploadLive,
  uploadInfoFromTool,
} from "./uploadCard.js";
import {
  createUploadFinishedSection,
  createUploadLiveZone,
  uploadCardHint,
} from "./uploadCardView.js";
import {
  createDemoCardPanel,
  demoArgsInfo,
  demoCardHint,
  demoHtmlFromResult,
} from "./demoCard.js";
import type { MessagePart, ToolResultPart } from "./types.js";

export type ToolCallPart = Extract<MessagePart, { type: "tool_call" }>;

export type PendingAskSnapshot = {
  requestId: string;
  toolCallId: string;
  question: string;
  options: string[];
  optionDetails?: import("../../../src/shared/askUser.js").UserAskOption[];
  allowCustom: boolean;
  allowMultiple: boolean;
};

export type AskUserAnswer = import("../../../src/shared/askUser.js").UserAskAnswer;

// ── helpers (toolInvocationHelpers subset) ─────────────────────
export function pathFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const path = (args as Record<string, unknown>).path;
  return typeof path === "string" ? path : undefined;
}

function contentFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const content = (args as Record<string, unknown>).content;
  return typeof content === "string" ? content : undefined;
}

function planDocTitleFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const title = (args as Record<string, unknown>).title;
  return typeof title === "string" && title.trim() ? title.trim() : undefined;
}

function planDocPathHintFromTitle(title: string | undefined): string {
  const slug = (title ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `docs/plans/${slug || "plan"}.md`;
}

function patchTextFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const rec = args as Record<string, unknown>;
  if (typeof rec.patch === "string") return rec.patch;
  if (typeof rec.patch_text === "string") return rec.patch_text;
  return undefined;
}

function patchPathHintFromResultText(resultText: string): string | undefined {
  const match = resultText.match(
    /^(?:Patching|Creating|Deleting|Moving) file (.+?)(?:\s+->\s+.+)?$/m,
  );
  const path = match?.[1]?.trim();
  return path && path.length > 0 ? path : undefined;
}

function questionFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const q = (args as Record<string, unknown>).question;
  return typeof q === "string" && q.trim() ? q.trim() : undefined;
}

export function editStringsFromArgs(args: unknown): {
  path?: string;
  oldString: string;
  newString: string;
} | null {
  if (!args || typeof args !== "object") return null;
  const raw = args as Record<string, unknown>;
  if (typeof raw.old_string !== "string" || typeof raw.new_string !== "string") {
    return null;
  }
  return {
    ...(typeof raw.path === "string" ? { path: raw.path } : {}),
    oldString: raw.old_string,
    newString: raw.new_string,
  };
}

function isWriteFileTool(name: string): boolean {
  return name === "write_file" || name === "append_file";
}
function isEditFileTool(name: string): boolean {
  return name === "edit_file";
}
function isPatchTool(name: string): boolean {
  return name === "patch";
}
function isPlanDocTool(name: string): boolean {
  return name === "write_plan_doc";
}
function isAskUserTool(name: string): boolean {
  return name === "ask_user" || name === "request_full_permissions";
}

// ── image tool cards (DisplayImageCardView port) ───────────────
// display_image / generate_image / capture_app_window render as image cards
// driven by the inline base64 preview embedded in the result attachment
// (thumbnailBase64 / thumbnailMimeType). The relay is a pure WS forwarder
// with no binary fetch channel, so the preview rides the session snapshot.
// Mac keeps loading the original file via media:// and ignores the fields.
const IMAGE_TOOL_TITLES: Record<string, string> = {
  display_image: "Image",
  generate_image: "Generate Image",
  capture_app_window: "Capture App Window",
};

function isImageDisplayTool(name: string): boolean {
  return name in IMAGE_TOOL_TITLES;
}

/** Aspect ratio from "1024x1024" / "1024×1024" or "16:9" size args. */
function aspectRatioFromArgs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const size = (args as Record<string, unknown>).size;
  if (typeof size !== "string") return null;
  const text = size.trim();
  const pixels = text.match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (pixels?.[1] && pixels?.[2]) {
    const ratio = parseFloat(pixels[1]) / parseFloat(pixels[2]);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  const ratioText = text.match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (ratioText?.[1] && ratioText?.[2]) {
    const ratio = parseFloat(ratioText[1]) / parseFloat(ratioText[2]);
    return Number.isFinite(ratio) && ratio > 0 ? ratio : null;
  }
  return null;
}

/** Intrinsic pixel width from a "WxH" size arg (placeholder width). */
function displayWidthFromArgs(args: unknown): number | null {
  if (!args || typeof args !== "object") return null;
  const size = (args as Record<string, unknown>).size;
  if (typeof size !== "string") return null;
  const pixels = size.trim().match(/^(\d+(?:\.\d+)?)\s*[x×]\s*(\d+(?:\.\d+)?)$/i);
  if (!pixels?.[1] || !pixels?.[2]) return null;
  const width = parseFloat(pixels[1]);
  return Number.isFinite(width) && width > 0 ? width : null;
}

function fileBasename(pathOrUri: string): string {
  const raw = pathOrUri.split("?")[0] ?? pathOrUri;
  const path = raw.startsWith("file:") ? decodeURIComponent(raw.replace(/^file:\/\//, "")) : raw;
  return path.split(/[/\\]/).pop() || path;
}

type ImageAttachment = {
  name: string;
  dataUrl: string;
};

function imageAttachmentFromResult(result: ToolResultPart): ImageAttachment | null {
  if (result.returnCode !== 0) return null;
  for (const part of result.content as Array<Record<string, unknown>>) {
    if (part.type !== "attachment" || part.kind !== "image") continue;
    const base64 = part.thumbnailBase64;
    const mimeType = part.thumbnailMimeType;
    if (typeof base64 !== "string" || base64.length === 0) continue;
    if (typeof mimeType !== "string" || !/^image\//i.test(mimeType)) continue;
    const uri = typeof part.uri === "string" ? part.uri : "";
    const name =
      (typeof part.name === "string" && part.name.trim()) ||
      (uri ? fileBasename(uri) : "image");
    return { name, dataUrl: `data:${mimeType};base64,${base64}` };
  }
  return null;
}

function imageErrorTextFromResult(result: ToolResultPart): string | null {
  if (result.returnCode === 0) return null;
  for (const part of result.content as Array<Record<string, unknown>>) {
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) {
      return part.text.trim();
    }
  }
  return `Exit ${result.returnCode}`;
}

function appendImageFigure(parent: HTMLElement, image: ImageAttachment): void {
  const figure = el("figure", { class: "content-card-display-image-figure" },
    el("img", {
      class: "conversation-image content-card-display-image-preview",
      src: image.dataUrl,
      alt: image.name,
      loading: "lazy",
      decoding: "async",
    }),
  );
  // Native download straight from the data URL (no Open/Reveal — the file
  // lives on the Mac; Mac parity keeps those on the desktop card).
  const actions = el("div", { class: "content-card-display-image-actions" },
    el("a", {
      class: "content-card-display-image-action",
      href: image.dataUrl,
      download: image.name,
      title: `Download ${image.name}`,
    }, icon("download", 14), "Download"),
  );
  parent.append(figure, actions);
}

/** generate_image while running — sized placeholder (aspect from size arg). */
function createGeneratingImageCard(args: unknown): HTMLElement {
  const card = el("article", { class: "content-card content-card-display-image" });
  const box = el("div", { class: "content-card-display-image-generating" });
  const ratio = aspectRatioFromArgs(args);
  if (ratio) box.style.aspectRatio = String(ratio);
  const width = displayWidthFromArgs(args);
  box.style.width = width ? `min(100%, ${width}px, 720px)` : "min(100%, 480px)";
  box.style.maxWidth = "100%";
  box.append(
    el("span", {
      class: "content-card-display-image-generating-spinner",
      role: "status",
      "aria-label": "Generating image…",
    }),
    el("span", { class: "content-card-display-image-generating-label" }, "Generating image…"),
  );
  const size = args && typeof args === "object" && typeof (args as Record<string, unknown>).size === "string"
    ? ((args as Record<string, unknown>).size as string).trim()
    : "";
  if (size) {
    box.append(el("span", { class: "content-card-display-image-generating-size" }, size));
  }
  card.append(box);
  return card;
}

/**
 * Image card for the three image tools, or null to fall back to the generic
 * invocation card:
 * - running display_image / capture_app_window → null (keep the compact
 *   running row; the snapshot refresh after the turn swaps in the image),
 * - finished without an embedded preview (older device builds, oversize or
 *   undecodable source) → null (compact row is the graceful fallback),
 * - failed result → error card (always takes over, Mac parity).
 */
function tryCreateImageToolCard(
  name: string,
  part: ToolCallPart,
  result: ToolResultPart | undefined,
): HTMLElement | null {
  if (result && result.returnCode !== 0) {
    return el("article", { class: "content-card content-card-display-image" },
      el("p", { class: "content-card-display-image-error" },
        imageErrorTextFromResult(result) ?? "Failed to display image."));
  }
  if (!result) {
    return name === "generate_image" ? createGeneratingImageCard(part.arguments) : null;
  }
  const image = imageAttachmentFromResult(result);
  if (!image) return null;
  if (name === "capture_app_window") {
    // Collapsed preview until expanded (Mac startCollapsed parity).
    const card = el("details", {
      class: "content-card content-card-display-image content-card-display-image-collapsible",
    });
    card.open = false;
    const summary = el("summary", { class: "content-card-display-image-summary" },
      el("span", { class: "content-card-display-image-summary-left" },
        el("span", { class: "content-card-display-image-summary-icon" }, icon("camera", 15)),
        el("span", { class: "content-card-display-image-summary-title" },
          IMAGE_TOOL_TITLES[name]!),
        el("span", { class: "content-card-display-image-summary-file", title: image.name },
          image.name),
      ),
      el("span", { class: "content-card-display-image-summary-chevron" }, icon("chevronDown", 14)),
    );
    const body = el("div", { class: "content-card-display-image-body" });
    appendImageFigure(body, image);
    card.append(summary, body);
    return card;
  }
  const card = el("article", { class: "content-card content-card-display-image" });
  appendImageFigure(card, image);
  return card;
}
/**
 * Deferred `tool_call` bridge invocations carry the real tool name inside
 * arguments (`{ name, arguments }`) — the transcript part name stays
 * `tool_call`. Unwrap so cards render as the inner tool (e.g. upload_files
 * progress card). Direct invocations pass through. (Mac helpers parity.)
 */
export function unwrapToolCallBridge(
  name: string,
  args: unknown,
): { name: string; arguments: unknown } {
  if (name !== "tool_call") return { name, arguments: args };
  if (args !== null && typeof args === "object" && !Array.isArray(args)) {
    const record = args as Record<string, unknown>;
    const inner = record.name;
    const innerArgs = record.arguments;
    if (
      typeof inner === "string" &&
      inner.length > 0 &&
      innerArgs !== null &&
      typeof innerArgs === "object" &&
      !Array.isArray(innerArgs)
    ) {
      return { name: inner, arguments: innerArgs };
    }
  }
  return { name, arguments: args };
}
function isRichToolCard(name: string): boolean {
  return (
    isWriteFileTool(name) ||
    isEditFileTool(name) ||
    isPatchTool(name) ||
    isPlanDocTool(name) ||
    isAskUserTool(name) ||
    name === "present_demo"
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

/**
 * Shell tool names across platforms (Mac `run_shell`, Windows v1
 * `exec_command` — cmd.exe semantics). Mirrors the desktop
 * `isShellToolName` so console cards match client rendering for both.
 */
export function isShellToolName(name: string): boolean {
  return name === "run_shell" || name === "exec_command";
}

function toolCardHint(name: string, args: Record<string, unknown>, resultText: string): string {
  if (isShellToolName(name) && typeof args.command === "string") return truncate(args.command, 64);
  if ((name === "write_file" || name === "edit_file" || name === "append_file") && typeof args.path === "string") {
    return truncate(args.path, 64);
  }
  if (name === "search_tools" && typeof args.query === "string") return truncate(args.query, 48);
  if (name === "search_skills" && typeof args.query === "string") return truncate(args.query, 48);
  if (name === "web_search" && typeof args.query === "string") return truncate(args.query, 48);
  if ((name === "display_image" || name === "generate_image") && typeof args.path === "string") {
    return truncate(args.path, 64);
  }
  if (name === "capture_app_window" && typeof args.output === "string") {
    return truncate(args.output, 64);
  }
  if (name === "dispatch_subagent" || name === "await_subagent") {
    const m = resultText.match(/\((.+?)\)/);
    if (m) return truncate(m[1]!, 48);
  }
  return "";
}

// ── diff engine (lineDiff + buildHunkDiff + diffFold port) ─────
type DiffLine = {
  kind: "equal" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export function splitLines(text: string): string[] {
  if (text.length === 0) return [];
  return text.split(/\r?\n/);
}

function linesFromChangeValue(value: string): string[] {
  if (value.length === 0) return [];
  const normalized = value.endsWith("\n") ? value.slice(0, -1) : value;
  return normalized.split("\n");
}

const LINE_DIFF_BUDGET_CELLS = 1_000_000;
const MIN_LINE_DIFF_EDIT_LENGTH = 64;

function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lines += 1;
  }
  return lines;
}

function boundedDiffLines(before: string, after: string) {
  const widest = Math.max(1, countLines(before), countLines(after));
  const maxEditLength = Math.max(
    MIN_LINE_DIFF_EDIT_LENGTH,
    Math.floor(LINE_DIFF_BUDGET_CELLS / widest),
  );
  return diffLines(before, after, { maxEditLength }) ?? null;
}

export function buildHunkLineDiff(before: string, after: string): DiffLine[] {
  const parts = boundedDiffLines(before, after);
  const out: DiffLine[] = [];
  let oldLine = 1;
  let newLine = 1;

  if (!parts) {
    for (const text of linesFromChangeValue(before)) {
      out.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
    }
    for (const text of linesFromChangeValue(after)) {
      out.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
    }
    return out;
  }

  for (const part of parts) {
    const lines = linesFromChangeValue(part.value);
    if (part.added) {
      for (const text of lines) out.push({ kind: "add", text, oldLine: null, newLine: newLine++ });
    } else if (part.removed) {
      for (const text of lines) out.push({ kind: "del", text, oldLine: oldLine++, newLine: null });
    } else {
      for (const text of lines) {
        out.push({ kind: "equal", text, oldLine: oldLine++, newLine: newLine++ });
      }
    }
  }
  return out;
}

export function countHunkLineChanges(
  before: string,
  after: string,
): { added: number; removed: number } {
  const lines = buildHunkLineDiff(before, after);
  let added = 0;
  let removed = 0;
  for (const line of lines) {
    if (line.kind === "add") added += 1;
    else if (line.kind === "del") removed += 1;
  }
  return { added, removed };
}

export function parseDiffLinesJson(raw: string): DiffLine[] | null {
  try {
    const parsed = JSON.parse(raw) as { lines?: unknown };
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    const lines: DiffLine[] = [];
    for (const item of parsed.lines) {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const kind = row.kind;
      if (kind !== "equal" && kind !== "add" && kind !== "del") return null;
      if (typeof row.text !== "string") return null;
      lines.push({
        kind,
        text: row.text,
        oldLine: typeof row.oldLine === "number" ? row.oldLine : null,
        newLine: typeof row.newLine === "number" ? row.newLine : null,
      });
    }
    return lines;
  } catch {
    return null;
  }
}

type DiffFoldSegment =
  | { type: "lines"; lines: DiffLine[] }
  | { type: "fold"; lines: DiffLine[] };

const DIFF_FOLD_CONTEXT = 3;

function segmentDiffLines(
  lines: DiffLine[],
  context: number = DIFF_FOLD_CONTEXT,
): DiffFoldSegment[] {
  if (lines.length === 0) return [];
  const visible = new Array<boolean>(lines.length).fill(false);
  let hasChange = false;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.kind === "equal") continue;
    hasChange = true;
    const from = Math.max(0, i - context);
    const to = Math.min(lines.length - 1, i + context);
    for (let j = from; j <= to; j++) visible[j] = true;
  }
  if (!hasChange) return [{ type: "lines", lines }];
  const segments: DiffFoldSegment[] = [];
  let i = 0;
  while (i < lines.length) {
    const want = visible[i]!;
    const chunk: DiffLine[] = [];
    while (i < lines.length && visible[i] === want) {
      chunk.push(lines[i]!);
      i += 1;
    }
    segments.push(want ? { type: "lines", lines: chunk } : { type: "fold", lines: chunk });
  }
  return segments;
}

// ── lined file views (LinedFileView / DiffLinedFileView port) ──
export function createLinedFileView(
  text: string,
  options?: { pathOrName?: string },
): HTMLElement {
  const wrap = el("div", { class: "tool-file-lines" });
  const language = resolveHighlightLanguage({
    ...(options?.pathOrName !== undefined ? { pathOrName: options.pathOrName } : {}),
    content: text,
  });
  const lines = splitLines(text);
  if (lines.length === 0) {
    wrap.append(el("div", { class: "tool-file-line is-empty" }, "(empty)"));
    return wrap;
  }
  const width = String(lines.length).length;
  lines.forEach((line, index) => {
    const code = el("span", { class: "tool-file-code hljs" });
    code.innerHTML = highlightCodeHtml(line.length > 0 ? line : " ", language);
    wrap.append(el("div", { class: `tool-file-line ${index % 2 === 0 ? "is-odd" : "is-even"}` },
      el("span", { class: "tool-file-gutter" }, String(index + 1).padStart(width, " ")),
      code,
    ));
  });
  return wrap;
}

function createDiffLineRow(
  line: DiffLine,
  gutterWidth: number,
  language: string | undefined,
): HTMLElement {
  const classes = [`tool-file-line`, `is-${line.kind}`];
  if (line.kind === "equal") {
    const n = line.oldLine ?? line.newLine ?? 0;
    classes.push(n % 2 === 0 ? "is-even" : "is-odd");
  }
  const gutter = el("span", { class: "tool-file-gutter tool-file-gutter-diff" },
    el("span", { class: "tool-file-gutter-old" },
      line.oldLine !== null ? String(line.oldLine).padStart(gutterWidth, " ") : " ".repeat(gutterWidth)),
    el("span", { class: "tool-file-gutter-new" },
      line.newLine !== null ? String(line.newLine).padStart(gutterWidth, " ") : " ".repeat(gutterWidth)),
    el("span", { class: "tool-file-diff-mark" },
      line.kind === "add" ? "+" : line.kind === "del" ? "−" : " "),
  );
  const code = el("span", { class: "tool-file-code hljs" });
  code.innerHTML = highlightCodeHtml(line.text.length > 0 ? line.text : " ", language);
  return el("div", { class: classes.join(" ") }, gutter, code);
}

function foldLabel(count: number): string {
  return count === 1 ? "⋯ 1 unchanged line" : `⋯ ${count} unchanged lines`;
}

export function createDiffLinedFileView(
  lines: DiffLine[],
  options?: { pathOrName?: string; foldUnchanged?: boolean },
): HTMLElement {
  const wrap = el("div", { class: "tool-file-lines tool-file-diff" });
  if (lines.length === 0) {
    wrap.append(el("div", { class: "tool-file-line is-empty" }, "(empty)"));
    return wrap;
  }
  const gutterWidth = String(
    Math.max(1, ...lines.map((l) => l.oldLine ?? 0), ...lines.map((l) => l.newLine ?? 0)),
  ).length;
  const language = resolveHighlightLanguage({
    ...(options?.pathOrName !== undefined ? { pathOrName: options.pathOrName } : {}),
    content: lines.map((l) => l.text).join("\n"),
  });
  const foldUnchanged = options?.foldUnchanged !== false;
  const segments = foldUnchanged ? segmentDiffLines(lines) : [{ type: "lines" as const, lines }];

  for (const segment of segments) {
    if (segment.type === "lines") {
      for (const line of segment.lines) wrap.append(createDiffLineRow(line, gutterWidth, language));
      continue;
    }
    const foldRow = el("button", { class: "tool-file-line tool-file-fold", type: "button", title: "Show unchanged lines" },
      foldLabel(segment.lines.length));
    foldRow.addEventListener("click", () => {
      const frag = document.createDocumentFragment();
      for (const line of segment.lines) frag.append(createDiffLineRow(line, gutterWidth, language));
      foldRow.replaceWith(frag);
    });
    wrap.append(foldRow);
  }
  return wrap;
}

// ── ask user panel (AskUserPanelView port) ─────────────────────
// ── result parsing (parseResultContent port) ───────────────────
const TOOL_RESULT_BODY_PART_ID = "body";
const TOOL_RESULT_DIFF_PART_ID = "file_diff";

export function parseResultContent(content: Array<Record<string, unknown>>): {
  textParts: string[];
  bodyText: string | null;
  diffJson: string | null;
  diffJsons: string[];
} {
  const textParts: string[] = [];
  let bodyText: string | null = null;
  let diffJson: string | null = null;
  const diffJsons: string[] = [];
  for (const part of content) {
    if (part.type === "text" && typeof part.text === "string") {
      if (part.id === TOOL_RESULT_BODY_PART_ID) bodyText = part.text;
      else if (part.id === TOOL_RESULT_DIFF_PART_ID) {
        diffJson = part.text;
        diffJsons.push(part.text);
      } else textParts.push(part.text);
    }
  }
  return { textParts, bodyText, diffJson, diffJsons };
}

// ── output body (appendOutputBody port) ────────────────────────
export function appendWriteFileContent(
  body: HTMLElement,
  content: string,
  pathOrName: string | undefined,
): void {
  if (isMarkdownPathOrName(pathOrName)) {
    const container = el("div", { class: "md-blocks content-card-write-markdown" });
    renderMarkdownBlocks(parseMarkdownBlocks(content), container);
    body.append(container);
    return;
  }
  body.append(createLinedFileView(content, pathOrName !== undefined ? { pathOrName } : undefined));
}

export function appendOutputBody(
  body: HTMLElement,
  parsed: ReturnType<typeof parseResultContent>,
  returnCode: number,
  pathHint: string | undefined,
  options?: {
    foldUnchanged?: boolean;
    editArgs?: unknown;
    writeContent?: string;
    diffEntries?: { pathOrName?: string; diffJson: string }[];
  },
): void {
  const { textParts, bodyText, diffJson, diffJsons } = parsed;
  const headline = textParts[0] ?? "";
  const pathOrName = pathHint ?? headline.match(/`([^`]+)`/)?.[1] ?? undefined;
  let hasBody = false;

  if (typeof options?.writeContent === "string" && returnCode === 0) {
    appendWriteFileContent(body, options.writeContent, pathOrName);
    hasBody = true;
  }

  if (!hasBody && options?.diffEntries && options.diffEntries.length > 0) {
    for (const entry of options.diffEntries) {
      const lines = parseDiffLinesJson(entry.diffJson);
      if (!lines || lines.length === 0) continue;
      body.append(createDiffLinedFileView(lines, {
        ...(entry.pathOrName !== undefined ? { pathOrName: entry.pathOrName } : {}),
        ...(options.foldUnchanged !== undefined ? { foldUnchanged: options.foldUnchanged } : {}),
      }));
      hasBody = true;
    }
    if (hasBody && returnCode === 0) return;
  }

  let diffLinesOut = !hasBody && diffJson ? parseDiffLinesJson(diffJson) : null;
  if ((!diffLinesOut || diffLinesOut.length === 0) && returnCode === 0 && !hasBody) {
    const edit = editStringsFromArgs(options?.editArgs);
    if (edit) diffLinesOut = buildHunkLineDiff(edit.oldString, edit.newString);
  }

  if (!hasBody && diffLinesOut && diffLinesOut.length > 0) {
    body.append(createDiffLinedFileView(diffLinesOut, {
      ...(pathOrName !== undefined ? { pathOrName } : {}),
      ...(options?.foldUnchanged !== undefined ? { foldUnchanged: options.foldUnchanged } : {}),
    }));
    hasBody = true;
  } else if (!hasBody && bodyText !== null) {
    if (isMarkdownPathOrName(pathOrName)) {
      appendWriteFileContent(body, bodyText, pathOrName);
    } else {
      body.append(createLinedFileView(bodyText, pathOrName !== undefined ? { pathOrName } : {}));
    }
    hasBody = true;
  } else if (!hasBody && textParts.length > 0) {
    const uniqueParts: string[] = [];
    for (const part of textParts) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      if (uniqueParts.some((existing) => existing.trim() === trimmed)) continue;
      uniqueParts.push(part);
    }
    const md = el("div", { class: "md-blocks" });
    renderMarkdownBlocks(parseMarkdownBlocks(uniqueParts.join("\n\n")), md);
    body.append(md);
    hasBody = true;
  }

  if (!hasBody) {
    body.append(el("p", { class: "md-paragraph" }, returnCode === 0 ? "Success" : `Exit ${returnCode}`));
  }
}

/** Sum add/del rows across all file_diff parts of a patch result. */
function sumDiffLineChanges(diffJsons: string[]): { added: number; removed: number } | null {
  let added = 0;
  let removed = 0;
  let seen = false;
  for (const json of diffJsons) {
    const lines = parseDiffLinesJson(json);
    if (!lines) continue;
    for (const line of lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "del") removed += 1;
    }
    seen = true;
  }
  return seen ? { added, removed } : null;
}

function buildPatchDiffEntries(
  diffJsons: string[],
  resultText: string,
): { pathOrName?: string; diffJson: string }[] {
  const paths = [...resultText.matchAll(/^(?:Patching|Creating|Deleting) file (.+)$/gm)]
    .map((match) => match[1]?.trim())
    .filter((path): path is string => path !== undefined && path.length > 0);
  return diffJsons.map((diffJson, i) => ({
    ...(paths[i] !== undefined ? { pathOrName: paths[i] } : {}),
    diffJson,
  }));
}

// ── card meta ──────────────────────────────────────────────────
// Mirrors the desktop app's cards/toolDisplay.ts entry-for-entry (display
// name + lucide icon key) so console cards match Mac rendering 1:1.
function statusLabel(status: string): string {
  switch (status) {
    case "running": return "Running";
    case "done": return "Done";
    case "error": return "Error";
    case "cancelled": return "Cancelled";
    default: return "Pending";
  }
}

// ── the card (ToolInvocationCardView port) ─────────────────────
export type ToolCardCallbacks = {
  pendingAsk?: PendingAskSnapshot | null;
  onAnswerAsk?: (requestId: string, answer: AskUserAnswer) => void;
  /** present_demo: confirmed values per tool call id (queue ∪ transcript). */
  demoSettledByCallId?: Map<string, DemoSettled> | null;
  /** present_demo: the newest unsettled call — the one card that opens. */
  demoOpenCallId?: string | null;
  demoStates?: Map<string, DemoCardState>;
  onSubmitDemoParams?: (
    toolCallId: string,
    values: Record<string, string | number | boolean | null>,
    note?: string,
  ) => void | Promise<void | DemoSubmitReceipt>;
};

/** ≤768px phone layout: rich diff/write bodies default to collapsed. */
function isMobileLayout(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    && window.matchMedia("(max-width: 768px)").matches === true;
}

export function createToolInvocationCard(
  part: ToolCallPart,
  result: ToolResultPart | undefined,
  callbacks?: ToolCardCallbacks,
): HTMLElement {
  // Deferred `tool_call` bridge: render as the inner tool (upload_files
  // progress card, …) so live tool_live snapshots patch the right zone
  // shape (Mac createToolInvocationCard parity).
  const bridged = unwrapToolCallBridge(part.name, part.arguments);
  if (bridged.name !== part.name) {
    part = { ...part, name: bridged.name, arguments: bridged.arguments } as ToolCallPart;
  }
  const name = part.name;
  const meta = toolMeta(name);
  // Image tools: dedicated image card when a preview is available (Mac
  // DisplayImageCardView port); null → generic card below (running row or
  // finished-without-preview fallback).
  if (isImageDisplayTool(name)) {
    const imageCard = tryCreateImageToolCard(name, part, result);
    if (imageCard) return imageCard;
  }
  const args = part.arguments as Record<string, unknown> | undefined;
  const hasResult = result !== undefined;
  const ok = hasResult ? result.returnCode === 0 : false;
  // Upload-detected cards: running stays compact (progress zone), finished
  // becomes rich with the transfer summary (Mac parity).
  const uploadInfo = uploadInfoFromTool(name, part.arguments);
  const uploadFinished = Boolean(uploadInfo && hasResult);
  const pendingAsk = callbacks?.pendingAsk && callbacks.pendingAsk.toolCallId === part.id
    ? callbacks.pendingAsk
    : null;
  const askUser = isAskUserTool(name);
  const writeFile = isWriteFileTool(name);
  const planDoc = isPlanDocTool(name);
  const patchTool = isPatchTool(name);
  const editTool = isEditFileTool(name);
  const demoTool = name === "present_demo";
  const demoInfo = demoTool ? demoArgsInfo(part.arguments) : null;
  // Failed Patch stays visible, with diagnostics available in its collapsed body.
  const patchFailure = patchTool && hasResult && !ok;

  // Streaming/pending preview: write body from (partial) args.
  const previewContent =
    (writeFile || planDoc) && !hasResult
      ? contentFromArgs(part.arguments)
      : patchTool && !hasResult
        ? (patchTextFromArgs(part.arguments) ??
          (typeof args?.new_string === "string" ? (args.new_string as string) : undefined))
        : undefined;
  const hasPreview = typeof previewContent === "string" && !hasResult;

  const rich = isRichToolCard(name) || Boolean(pendingAsk) || hasPreview || uploadFinished;
  const compact = !rich;

  const askQuestion = pendingAsk?.question ?? questionFromArgs(part.arguments);
  // Phone: rich bodies (patch diffs, write previews) render collapsed — a
  // full-height diff card on a 390px viewport dwarfs everything else. Ask
  // panels stay open (they carry actionable controls). Upload cards stay
  // expanded once finished — the transfer summary is the point of the card.
  const mobile = isMobileLayout();
  const expand = !patchFailure && (Boolean(pendingAsk) || askUser
    || (hasPreview && !mobile)
    || uploadFinished
    || (demoTool
      ? callbacks?.demoOpenCallId === part.id
      : (hasResult && rich && !mobile)));

  const expandable = rich;
  const card = el(expandable ? "details" : "div", {
    class: [
      "content-card",
      "content-card-tool-invocation",
      compact ? "is-compact" : "is-rich",
      askUser ? "content-card-ask-user-tool" : "",
      uploadInfo ? "content-card-tool-upload" : "",
      demoTool ? "content-card-demo-tool" : "",
      hasResult && !askUser ? (ok ? "is-success" : "is-error") : "",
      pendingAsk ? "is-asking" : "",
      hasPreview ? "is-streaming-preview" : "",
      `content-card-tool-${part.status || "pending"}`,
    ].filter(Boolean).join(" "),
    "data-tool-call-id": part.id,
    "data-tool-name": name,
  });
  if (expandable && card instanceof HTMLDetailsElement) card.open = expand;

  const summary = el(rich ? "summary" : "div", { class: "content-card-tool-result-summary" });
  const left = el("div", { class: "content-card-tool-result-left" },
    el("span", { class: "content-card-tool-icon" }, icon(meta.icon, 15)),
  );
  const nameEl = el("span", { class: "content-card-tool-name" });
  if (name === "ask_user") {
    nameEl.textContent = meta.displayName;
  } else if (askUser && askQuestion) {
    nameEl.classList.add("content-card-ask-user-title");
    nameEl.textContent = askQuestion;
    nameEl.title = askQuestion;
  } else if (askUser && name === "request_full_permissions") {
    nameEl.classList.add("content-card-ask-user-title");
    nameEl.textContent = "Enable bypass permissions?";
  } else if (planDoc) {
    nameEl.classList.add("content-card-ask-user-title");
    nameEl.textContent = planDocTitleFromArgs(part.arguments) ?? meta.displayName;
  } else if (demoInfo) {
    nameEl.classList.add("content-card-demo-title");
    nameEl.textContent = demoInfo.title;
    nameEl.title = demoInfo.title;
  } else {
    nameEl.textContent = meta.displayName;
  }
  left.append(nameEl);

  const parsed = hasResult ? parseResultContent(result!.content as Array<Record<string, unknown>>) : {
    textParts: [] as string[], bodyText: null as string | null,
    diffJson: null as string | null, diffJsons: [] as string[],
  };
  const resultText = parsed.textParts.join("\n");
  const editArgs = (editTool || patchTool) && ok ? editStringsFromArgs(part.arguments) : null;
  const writeContent = (writeFile || planDoc) && ok
    ? (contentFromArgs(part.arguments) ?? (typeof parsed.bodyText === "string" ? parsed.bodyText : undefined))
    : undefined;
  const counts = writeFile
    ? null
    : patchTool
      ? (sumDiffLineChanges(parsed.diffJsons) ?? null)
      : planDoc
        ? null
        : editArgs
          ? countHunkLineChanges(editArgs.oldString, editArgs.newString)
          : null;

  const right = el("div", { class: "content-card-tool-result-right" });
  if (counts && rich && !askUser) {
    right.append(el("span", { class: "content-card-tool-result-changes" },
      el("span", { class: "is-add" }, `+${counts.added}`),
      el("span", { class: "is-del" }, `−${counts.removed}`),
    ));
  }
  if (hasResult) {
    if (patchFailure) {
      // Keep the failure summary concise; diagnostics live in the collapsible body.
      right.append(
        el("span", {
          class: "content-card-tool-outcome is-fail",
          title: "Patch failed. No changes applied.",
          "aria-hidden": "true",
        }, icon("warn", 14)),
        el("span", { class: "content-card-tool-failure-label" }, "Failed · No changes applied"),
      );
    } else {
      // Mac parity: icon-only outcome badge (green check / red warning), tip
      // on hover. Success starts dormant — armed (shown 3s, then faded) only
      // by the live finished-card swap; history renders keep it hidden.
      // Failure stays.
      const tip = ok ? "Success" : `Exit ${result!.returnCode}`;
      right.append(el("span", {
        class: `content-card-tool-outcome ${ok ? "is-ok is-dormant" : "is-fail"}`,
        title: tip,
        "aria-label": tip,
      }, icon(ok ? "check" : "warn", 14)));
    }
  } else if (pendingAsk) {
    right.append(el("span", { class: "content-card-tool-status" }, "Waiting for answer…"));
  } else if (part.status === "running") {
    // Spinner instead of a "RUNNING" label — matches the Mac run_shell
    // control (LoaderCircle, accent) and reads at a glance on phones.
    right.append(el("span", {
      class: "content-card-tool-run-spinner",
      role: "status",
      "aria-label": "Running",
      title: "Running",
    }, icon("loaderCircle", 15)));
  } else {
    right.append(el("span", { class: "content-card-tool-status" }, statusLabel(part.status)));
  }

  // Hint: path / command / query. Upload cards show src → dest.
  if (!askUser) {
    const hintText = demoInfo
      ? demoCardHint(demoInfo)
      : uploadInfo
        ? uploadCardHint(uploadInfo)
        : toolCardHint(name, args ?? {}, resultText);
    if (hintText) {
      const hint = el("span", { class: "content-card-tool-result-hint" },
        hintText);
      hint.title = uploadInfo ? hintText : (pathFromArgs(part.arguments) || hintText);
      left.append(hint);
    }
  }

  if (expandable) {
    right.append(el("span", { class: "content-card-tool-result-chevron" }, icon("chevronDown", 14)));
  }
  summary.append(left, right);
  card.append(summary);

  // Running upload: compact card + live progress zone below the summary row.
  if (!hasResult && uploadInfo) {
    card.append(createUploadLiveZone(seedUploadLive(uploadInfo)));
  }

  if (compact) {
    // Mac parity: compact cards are non-expandable single status rows (a div,
    // cursor default — no Arguments/terminal body).
    return card;
  }

  const body = el("div", { class: "content-card-tool-invocation-body" });
  const outputSection = el("section", { class: "content-card-tool-section content-card-tool-section-output" });

  if (demoInfo) {
    const panel = createDemoCardPanel({
      toolCallId: part.id,
      path: demoInfo.path,
      title: demoInfo.title,
      ...(demoInfo.prompt ? { prompt: demoInfo.prompt } : {}),
      params: demoInfo.params,
      hasResult,
      ok,
      htmlBase64: hasResult ? demoHtmlFromResult(result!) : null,
      settled: callbacks?.demoSettledByCallId?.get(part.id) ?? null,
      state: demoCardStateFor(callbacks?.demoStates, part.id, callbacks?.demoSettledByCallId?.get(part.id) ?? null),
      ...(callbacks?.onSubmitDemoParams
        ? {
            onSubmitDemoParams: (values, note) =>
              callbacks.onSubmitDemoParams?.(part.id, values, note),
          }
        : {}),
      initiallyOpen: expand,
    });
    outputSection.append(panel.root);
    if (card.tagName === "DETAILS") {
      const details = card as HTMLDetailsElement;
      // Deferred preview mount: only an open card pays for the srcdoc iframe
      // (Mac attachToolCardBody parity for the memory-heavy part). tagName
      // check, not instanceof — linkedom stubs break the latter in tests.
      details.addEventListener("toggle", () => {
        if (details.open) panel.mountPreview();
        else panel.unmountPreview();
      });
      // Direct .open writes (wasOpen preservation in refreshToolCards) never
      // fire toggle — mount when the card already starts open.
      if (details.open) panel.mountPreview();
    }
    body.append(outputSection);
    card.append(body);
    return card;
  }

  const askAnswerView = name === "ask_user" && ok ? createAskUserAnswerView(resultText, askQuestion) : null;
  if (askAnswerView) {
    outputSection.append(askAnswerView);
  } else if (hasResult) {
    // Upload-detected card: replace the generic output body with the
    // transfer summary section (stats + file snapshot + excludes / error).
    if (uploadFinished && uploadInfo) {
      outputSection.classList.add("content-card-tool-section-output-flush");
      outputSection.append(createUploadFinishedSection({
        ok,
        cancelled: part.status === "cancelled",
        info: uploadInfo,
        stats: parseUploadFinished(resultText),
      }));
      body.append(outputSection);
      card.append(body);
      return card;
    }
    const outputBody = el("div", { class: "content-card-tool-result-body" });
    const pathHint =
      pathFromArgs(part.arguments) ??
      (patchTool ? patchPathHintFromResultText(resultText) : undefined) ??
      (planDoc ? planDocPathHintFromTitle(planDocTitleFromArgs(part.arguments)) : undefined);
    if (pathHint) {
      outputBody.append(el("div", { class: "content-card-tool-result-path" }, pathHint));
    }
    appendOutputBody(outputBody, parsed, result!.returnCode, pathHint, {
      foldUnchanged: editTool || patchTool,
      ...((editTool || patchTool) ? { editArgs: part.arguments } : {}),
      ...((writeFile || planDoc) && writeContent !== undefined ? { writeContent } : {}),
      ...(patchTool && ok && parsed.diffJsons.length > 0
        ? { diffEntries: buildPatchDiffEntries(parsed.diffJsons, resultText) }
        : {}),
    });
    outputSection.append(outputBody);
  } else if (pendingAsk) {
    outputSection.append(createAskUserPanel({
      question: pendingAsk.question,
      options: pendingAsk.options,
      ...(pendingAsk.optionDetails ? { optionDetails: pendingAsk.optionDetails } : {}),
      allowCustom: pendingAsk.allowCustom,
      allowMultiple: pendingAsk.allowMultiple,
      hideQuestion: name !== "ask_user",
      draftKey: pendingAsk.requestId,
      onAnswer: (answer) => callbacks?.onAnswerAsk?.(pendingAsk.requestId, answer),
    }));
  } else if (hasPreview) {
    const outputBody = el("div", { class: "content-card-tool-result-body content-card-tool-preview-body" });
    const pathHint =
      pathFromArgs(part.arguments) ??
      (planDoc ? planDocPathHintFromTitle(planDocTitleFromArgs(part.arguments)) : undefined);
    if (pathHint) {
      outputBody.append(el("div", { class: "content-card-tool-result-path" }, pathHint));
    }
    appendWriteFileContent(outputBody, previewContent!, pathHint);
    outputSection.append(outputBody);
  } else {
    outputSection.append(el("p", { class: "md-paragraph content-card-tool-pending" },
      part.status === "running" ? "Executing tool…" : "Waiting for result…"));
  }

  body.append(outputSection);
  card.append(body);
  return card;
}

// ── transient success badge (Mac armLiveOutcomeFade) ─

/** How long a live success badge stays visible before fading out. */
const OUTCOME_HOLD_MS = 3000;
/** Pop-out tween length (was a 550ms CSS keyframes animation). */
const OUTCOME_POP_OUT_MS = 550;

/**
 * Arm the transient success badge inside a freshly finished tool card: it is
 * created dormant (hidden) and revealed here, held for OUTCOME_HOLD_MS, then
 * faded + collapsed. Failure badges are permanent — never dormant, untouched.
 */
export function armLiveOutcomeFade(scope: HTMLElement): void {
  const marks = scope.querySelectorAll<HTMLElement>(
    ".content-card-tool-outcome.is-ok.is-dormant",
  );
  for (const mark of Array.from(marks)) {
    mark.classList.remove("is-dormant");
    setTimeout(() => {
      playOutcomePopOut(mark);
    }, OUTCOME_HOLD_MS);
  }
}

function prefersReducedMotion(): boolean {
  return Boolean(
    typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches,
  );
}

/**
 * Pop the badge away with a Web Animations tween instead of a CSS animation
 * (Mac ToolOutcomeBadge parity): DOM re-parenting restarts CSS animations
 * from frame 0, which made an already-popped badge reappear and pop again
 * on the next sibling tool finish. Script animations survive the re-parent.
 *
 * Besides the transform/opacity pop, the tween collapses the badge's layout
 * slot (width → 0, margin-left → -10px cancelling the right-container gap)
 * so the row content left of it expands smoothly into the freed space.
 * `is-faded` carries only the terminal styles, applied when the tween
 * settles — or immediately without animate support (tests / reduced motion).
 */
function playOutcomePopOut(mark: HTMLElement): void {
  if (typeof mark.animate !== "function" || prefersReducedMotion()) {
    mark.classList.add("is-faded");
    return;
  }
  let settled = false;
  const settle = (): void => {
    if (settled) return;
    settled = true;
    mark.classList.add("is-faded");
  };
  // Slot geometry comes from the live computed style (14px wide, no
  // explicit margin). -10px cancels the trailing gap of
  // .content-card-tool-result-right — the badge is always its last child.
  const computed =
    typeof getComputedStyle === "function" ? getComputedStyle(mark) : null;
  const slotWidth = computed?.width || "14px";
  const slotMargin = computed?.marginLeft || "0px";
  try {
    const anim = mark.animate(
      [
        {
          transform: "scale(1)",
          opacity: "1",
          width: slotWidth,
          marginLeft: slotMargin,
        },
        {
          transform: "scale(1.3)",
          opacity: "1",
          width: slotWidth,
          marginLeft: slotMargin,
          offset: 0.3,
        },
        {
          transform: "scale(0)",
          opacity: "0",
          width: "0px",
          marginLeft: "-10px",
        },
      ],
      { duration: OUTCOME_POP_OUT_MS, easing: "ease" },
    );
    void anim.finished.then(settle, settle);
  } catch {
    settle();
  }
}
