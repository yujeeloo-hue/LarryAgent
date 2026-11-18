
import { fileUriToPath } from "../../ui/filePath.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "../../../../session/types.js";
import { isWireOverlayTranscriptMessage } from "../../../../session/wireOverlay.js";

export function isNewTaskBoundaryMessage(message: {
  role: string;
  parts: Array<{ type?: unknown }>;
}): boolean {
  return (
    message.role === "system" &&
    message.parts.some((part) => part.type === "context_new_task")
  );
}

const FILE_CHANGE_TOOLS = new Set([
  "write_file",
  "write_plan_doc",
  "patch",
  "append_file",
  "edit_file",
  "convert_to_pdf",
  "capture_app_window",
]);

const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\(\s*(<(https?:\/\/[^>\s]+)>|(https?:\/\/[^)\s]+))\s*(?:["'][^"']*["'])?\s*\)/gi;
const BARE_URL_RE =
  /https?:\/\/[^\s<>"'`{}，。、；：！？…“”‘’（）【】「」『』《》〈〉｡､｢｣—・〜～]+/gi;
const HOSTNAME_RE =
  /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
const SKIP_TEXT_PART_IDS = new Set(["file_body", "file_diff"]);

const PATH_STOP_CHARS =
  "\\s`'\"<>|(){}\\[\\],;:*?（）【】「」『』，。；：！？、《》“”‘’…";
const BARE_FILE_PATH_RE = new RegExp(
  `(?<![\\w:./-])/(?:[^${PATH_STOP_CHARS}/]+/)+[^${PATH_STOP_CHARS}/]+\\.[A-Za-z0-9]{1,12}`,
  "g",
);
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const CODE_FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
const MARKDOWN_FILE_LINK_RE = /\[[^\]]*\]\(\s*<?((?:file:\/\/|\/)[^)>\s]+)>?\s*\)/g;
const WHOLE_FILE_PATH_RE = /^\/(?:[^/\n]+\/)+[^/\n]+\.[A-Za-z0-9]{1,12}$/;

export type TurnModifiedFile = {
  path: string;
  name: string;
  action: "created" | "edited" | "mentioned";
};

export type TurnUrl = {
  url: string;
};

export type MessageLikeForModifiedFiles = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  createdAt?: number;
};

function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function pathKey(path: string): string {
  const segments: string[] = [];
  for (const segment of path.trim().split(/[/\\]/)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

function pathFromToolCallArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["output", "path"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function pathFromResultContent(
  content: Array<Record<string, unknown>>,
): string | undefined {
  for (const part of content) {
    if (part.type === "attachment" && typeof part.uri === "string" && part.uri) {
      const path = fileUriToPath(part.uri);
      if (path) return path;
    }
  }
  return undefined;
}

function nameFromResultContent(
  content: Array<Record<string, unknown>>,
): string | undefined {
  for (const part of content) {
    if (part.type === "attachment" && typeof part.name === "string" && part.name) {
      return part.name;
    }
  }
  return undefined;
}

function pathFromResultHeadline(
  content: Array<Record<string, unknown>>,
): string | undefined {
  for (const part of content) {
    if (part.type !== "text" || typeof part.text !== "string") continue;
    if (part.id === "file_body" || part.id === "file_diff") continue;
    const match = part.text.match(/^(?:Wrote|Edited)\s+(.+?)(?:\s+\(|$)/);
    if (match?.[1]) return match[1].trim();
    const applied = part.text.match(/^PATCH APPLIED.*\bin (\S+?)(?:\.|$)/m);
    if (applied?.[1]) return applied[1].replace(/[.,;:]+$/, "").trim();
    const patchMatch = part.text.match(
      /^(?:Patching|Creating|Deleting|Moving) file (.+?)(?:\s+->\s+.+)?$/,
    );
    if (patchMatch?.[1]) return patchMatch[1].trim();
  }
  return undefined;
}

export function splitMessagesIntoTurns<T extends MessageLikeForModifiedFiles>(
  messages: T[],
  turnStartIds?: ReadonlySet<string>,
): T[][] {
  const turns: T[][] = [];
  let current: T[] = [];

  for (const message of messages) {
    if (isWireOverlayTranscriptMessage(message)) continue;
    if (
      turnStartIds?.size &&
      message.id !== undefined &&
      turnStartIds.has(message.id) &&
      message.role !== "user"
    ) {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (message.role === "system") {
      if (isNewTaskBoundaryMessage(message)) {
        if (current.length > 0) turns.push(current);
        current = [message];
        continue;
      }
      if (current.length === 0) {
        turns.push([message]);
      } else {
        current.push(message);
      }
      continue;
    }
    const continuesTurn =
      message.role === "user" &&
      message.parts.some(
        (part) =>
          part.type === "text" &&
          (part.id === STEER_CONTINUATION_PART_ID ||
            part.id === RETRY_CONTINUATION_PART_ID),
      );
    if (message.role === "user" && !continuesTurn) {
      if (current.length > 0) turns.push(current);
      current = [message];
      continue;
    }
    if (current.length === 0) {
      current = [message];
    } else {
      current.push(message);
    }
  }
  if (current.length > 0) turns.push(current);
  return turns;
}

export function collectModifiedFilesFromMessages(
  messages: MessageLikeForModifiedFiles[],
): TurnModifiedFile[] {
  const toolNamesByCallId = new Map<string, string>();
  const toolArgsByCallId = new Map<string, unknown>();
  const toolResultsByCallId = new Map<
    string,
    { returnCode: number; content: Array<Record<string, unknown>> }
  >();

  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type === "tool_call" &&
        typeof part.id === "string" &&
        typeof part.name === "string"
      ) {
        toolNamesByCallId.set(part.id, part.name);
        toolArgsByCallId.set(part.id, part.arguments);
      }
      if (part.type === "tool_result" && typeof part.toolCallId === "string") {
        toolResultsByCallId.set(part.toolCallId, {
          returnCode:
            typeof part.returnCode === "number" ? part.returnCode : 1,
          content: Array.isArray(part.content)
            ? (part.content as Array<Record<string, unknown>>)
            : [],
        });
      }
    }
  }

  const order: string[] = [];
  const byPath = new Map<string, TurnModifiedFile>();

  for (const [callId, toolName] of toolNamesByCallId) {
    if (!FILE_CHANGE_TOOLS.has(toolName)) continue;
    const result = toolResultsByCallId.get(callId);
    if (!result || result.returnCode !== 0) continue;

    const path =
      pathFromResultContent(result.content) ??
      pathFromToolCallArgs(toolArgsByCallId.get(callId)) ??
      pathFromResultHeadline(result.content);
    if (!path) continue;

    const name =
      nameFromResultContent(result.content) ?? basename(path);
    const action: TurnModifiedFile["action"] =
      toolName === "patch" ||
      toolName === "edit_file" ||
      toolName === "append_file"
        ? "edited"
        : "created";

    const key = pathKey(path);
    if (!byPath.has(key)) order.push(path);
    byPath.set(key, { path, name, action });
  }

  return order.map((path) => byPath.get(pathKey(path))!);
}

function pushMentionedPath(
  raw: string,
  order: string[],
  seen: Set<string>,
): void {
  const path = raw.trim();
  if (!path) return;
  const key = pathKey(path);
  if (seen.has(key)) return;
  seen.add(key);
  order.push(path);
}

function stripFencedCodeBlocks(text: string): string {
  if (!text.includes("```") && !text.includes("~~~")) return text;
  const kept: string[] = [];
  let fence: string | null = null;

  for (const line of text.split("\n")) {
    const marker = CODE_FENCE_RE.exec(line)?.[1];
    if (fence) {
      if (marker && marker.startsWith(fence[0]!) && marker.length >= fence.length) {
        fence = null;
      }
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    kept.push(line);
  }

  return kept.join("\n");
}

function collectMentionedPathsFromText(
  text: string,
  order: string[],
  seen: Set<string>,
): void {
  if (!text) return;
  const prose = stripFencedCodeBlocks(text);

  for (const match of prose.matchAll(INLINE_CODE_RE)) {
    const candidate = match[1]?.trim() ?? "";
    if (WHOLE_FILE_PATH_RE.test(candidate)) {
      pushMentionedPath(candidate, order, seen);
    }
  }

  for (const match of prose.matchAll(MARKDOWN_FILE_LINK_RE)) {
    const href = match[1] ?? "";
    const path = href.startsWith("file://") ? fileUriToPath(href) : href;
    if (path && WHOLE_FILE_PATH_RE.test(path)) {
      pushMentionedPath(path, order, seen);
    }
  }

  for (const match of prose.matchAll(BARE_FILE_PATH_RE)) {
    if (match[0]) pushMentionedPath(match[0], order, seen);
  }
}

export function collectMentionedFilesFromMessages(
  messages: MessageLikeForModifiedFiles[],
  excludePaths: Iterable<string> = [],
): TurnModifiedFile[] {
  const order: string[] = [];
  const seen = new Set<string>();
  for (const exclude of excludePaths) {
    const key = pathKey(exclude);
    if (key !== "/") seen.add(key);
  }

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      if (typeof part.id === "string" && SKIP_TEXT_PART_IDS.has(part.id)) {
        continue;
      }
      collectMentionedPathsFromText(part.text, order, seen);
    }
  }

  return order.map((path) => ({
    path,
    name: basename(path),
    action: "mentioned" as const,
  }));
}

export async function collectTurnFiles(
  messages: MessageLikeForModifiedFiles[],
  filterExistingFiles?: (paths: string[]) => Promise<string[]>,
): Promise<TurnModifiedFile[]> {
  const modified = collectModifiedFilesFromMessages(messages);
  if (!filterExistingFiles) return modified;

  const mentioned = collectMentionedFilesFromMessages(
    messages,
    modified.map((file) => file.path),
  );
  if (mentioned.length === 0) return modified;

  try {
    const existing = new Set(
      await filterExistingFiles(mentioned.map((file) => file.path)),
    );
    const seen = new Set(modified.map((file) => pathKey(file.path)));
    const uniqueMentioned = mentioned.filter((file) => {
      if (!existing.has(file.path)) return false;
      const key = pathKey(file.path);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return [...modified, ...uniqueMentioned];
  } catch (err) {
    console.error("[turn-files] mention existence check failed", err);
    return modified;
  }
}

function isHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return false;
    }
    return HOSTNAME_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

function stripTrailingUrlPunctuation(url: string): string {
  let out = url;
  while (/[.,;:!?！？。，、；：…*]+$/.test(out)) {
    const trimmed = out.replace(/[.,;:!?！？。，、；：…*]+$/, "");
    if (!isHttpUrl(trimmed)) break;
    out = trimmed;
  }
  while (true) {
    const tail = out[out.length - 1];
    const unbalanced =
      (tail === ")" && countChar(out, ")") > countChar(out, "(")) ||
      (tail === "]" && countChar(out, "]") > countChar(out, "[")) ||
      (tail === "(" && countChar(out, "(") > countChar(out, ")")) ||
      (tail === "[" && countChar(out, "[") > countChar(out, "]"));
    if (!unbalanced) break;
    const trimmed = out.slice(0, -1);
    if (!isHttpUrl(trimmed)) break;
    out = trimmed;
  }
  return out;
}

function countChar(text: string, ch: string): number {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch) n++;
  return n;
}

function pushUrl(order: string[], seen: Set<string>, raw: string): void {
  const url = stripTrailingUrlPunctuation(raw.trim());
  if (!url || !isHttpUrl(url) || seen.has(url)) return;
  seen.add(url);
  order.push(url);
}

function collectUrlsFromText(
  text: string,
  order: string[],
  seen: Set<string>,
): void {
  if (!text) return;

  type Hit = { index: number; url: string };
  const hits: Hit[] = [];

  let offset = 0;
  let inFence = false;
  for (const line of text.split("\n")) {
    if (CODE_FENCE_RE.test(line)) {
      inFence = !inFence;
      offset += line.length + 1;
      continue;
    }
    if (!inFence) {
      MARKDOWN_LINK_RE.lastIndex = 0;
      for (const match of line.matchAll(MARKDOWN_LINK_RE)) {
        const href = match[2] ?? match[3];
        if (href && match.index !== undefined) {
          hits.push({ index: offset + match.index, url: href });
        }
      }
      BARE_URL_RE.lastIndex = 0;
      for (const match of line.matchAll(BARE_URL_RE)) {
        if (match[0] && match.index !== undefined) {
          hits.push({ index: offset + match.index, url: match[0] });
        }
      }
    }
    offset += line.length + 1;
  }

  hits.sort((a, b) => a.index - b.index);
  for (const hit of hits) pushUrl(order, seen, hit.url);
}

export function collectUrlsFromMessages(
  messages: MessageLikeForModifiedFiles[],
): TurnUrl[] {
  const order: string[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      if (part.type !== "text" || typeof part.text !== "string") continue;
      if (typeof part.id === "string" && SKIP_TEXT_PART_IDS.has(part.id)) {
        continue;
      }
      collectUrlsFromText(part.text, order, seen);
    }
  }

  return order.map((url) => ({ url }));
}
