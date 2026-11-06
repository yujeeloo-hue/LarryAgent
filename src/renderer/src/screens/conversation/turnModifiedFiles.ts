/** Collect files created/edited and http(s) URLs cited in the assistant reply. */

import { fileUriToPath } from "../../ui/filePath.js";
import {
  RETRY_CONTINUATION_PART_ID,
  STEER_CONTINUATION_PART_ID,
} from "../../../../session/types.js";
import { isWireOverlayTranscriptMessage } from "../../../../session/wireOverlay.js";

const FILE_CHANGE_TOOLS = new Set([
  "write_file",
  "write_plan_doc",
  "patch",
  // Retired names — historical turns keep their modified-file rows.
  "append_file",
  "edit_file",
  "convert_to_pdf",
  "capture_app_window",
]);

/** Markdown `[label](https://…)` — capture group 1 is the href. */
const MARKDOWN_LINK_RE = /\[(?:[^\]]*)\]\(\s*(<(https?:\/\/[^>\s]+)>|(https?:\/\/[^)\s]+))\s*(?:["'][^"']*["'])?\s*\)/gi;
/** Bare http(s) URLs in prose / tool text. A URL must start with an explicit
 *  http:// or https:// protocol, and terminates at ASCII *and* CJK
 *  punctuation — otherwise `https://a.com/foo，详见下文` swallows the rest of
 *  the sentence into the "URL". Round / square brackets are allowed so
 *  Wikipedia-style titles (`/wiki/Punctuation_(linguistics)`) survive;
 *  unbalanced trailing ones are trimmed later in stripTrailingUrlPunctuation. */
const BARE_URL_RE =
  /https?:\/\/[^\s<>"'`{}，。、；：！？…“”‘’（）【】「」『』《》〈〉｡､｢｣—・〜～]+/gi;
/** Plausible host: localhost, IPv4, IPv6 literal, or dotted DNS labels. */
const HOSTNAME_RE =
  /^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:.]+\]|[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+)$/i;
/** Skip huge write/edit payloads that would flood the link list. */
const SKIP_TEXT_PART_IDS = new Set(["file_body", "file_diff"]);

/** ASCII + CJK punctuation that cannot appear inside a path we scrape from prose. */
const PATH_STOP_CHARS =
  "\\s`'\"<>|(){}\\[\\],;:*?（）【】「」『』，。；：！？、《》“”‘’…";
/** Bare absolute path with a file extension, e.g. /Users/me/out/app-1.0.dmg. */
const BARE_FILE_PATH_RE = new RegExp(
  `(?<![\\w:./-])/(?:[^${PATH_STOP_CHARS}/]+/)+[^${PATH_STOP_CHARS}/]+\\.[A-Za-z0-9]{1,12}`,
  "g",
);
/** Inline code span; the span delimits the path, so spaces are allowed inside. */
const INLINE_CODE_RE = /`([^`\n]+)`/g;
/** Opening / closing fence of a code block. */
const CODE_FENCE_RE = /^[ \t]*(`{3,}|~{3,})/;
/** Markdown link whose href is a local path (`/abs/path` or `file://…`). */
const MARKDOWN_FILE_LINK_RE = /\[[^\]]*\]\(\s*<?((?:file:\/\/|\/)[^)>\s]+)>?\s*\)/g;
/** Whole-string absolute path with an extension (spaces allowed). */
const WHOLE_FILE_PATH_RE = /^\/(?:[^/\n]+\/)+[^/\n]+\.[A-Za-z0-9]{1,12}$/;

export type TurnModifiedFile = {
  path: string;
  name: string;
  /**
   * write_file / convert_to_pdf / capture_app_window → created; edit/append →
   * edited; only named in the reply text (e.g. a shell build artifact) →
   * mentioned.
   */
  action: "created" | "edited" | "mentioned";
};

export type TurnUrl = {
  url: string;
};

export type MessageLikeForModifiedFiles = {
  id?: string;
  role: string;
  parts: Array<Record<string, unknown>>;
  /** Epoch ms when present (used for end-of-turn duration). */
  createdAt?: number;
};

function basename(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

/**
 * Normalized comparison key for dedup: collapse duplicate slashes, resolve
 * `.`/`..` segments lexically, treat `\` as a separator (Windows tool paths
 * vs file:// URIs mix spellings), lowercase (macOS default filesystems are
 * case-insensitive). Display keeps the first-seen spelling; only equality
 * checks use this key. Exported for the remote bridge, which scopes its
 * read-only file actions to the same normalized session file set.
 */
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
  // Conversion/capture tools write to `output`; file tools use `path`.
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

/**
 * Split session messages into turns. A turn starts at each user message
 * and includes following assistant/tool messages until the next user message.
 */
export function splitMessagesIntoTurns<T extends MessageLikeForModifiedFiles>(
  messages: T[],
  /** First messages of prompt-less turns (CoCo automatic / hand-over replies). */
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
      // Compaction markers / turn errors: attach to the open turn, or alone.
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
      // Orphan assistant/tool before any user — treat as its own turn.
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

  // Preserve first-seen order; later ops on the same path update the entry.
  // Dedup uses pathKey (case/slash-insensitive) so spelling drift across
  // tools (file:// variants, casing typos) cannot produce duplicate rows.
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

/** Drop fenced code blocks: they carry commands, not the turn's deliverables. */
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

/**
 * Collect absolute file paths the assistant names in its reply text. Catches
 * artifacts produced outside the file tools (shell builds, generated bundles)
 * that `collectModifiedFilesFromMessages` cannot see. Paths are candidates
 * only — the caller must verify they exist before showing them.
 */
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

/**
 * Files to show for a turn / conversation: tool-modified files first, then
 * paths only named in the reply text. Mentions are dropped unless
 * `filterExistingFiles` confirms they are real files on disk.
 */
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
    // Final defense: never let a mention duplicate a tool entry (or another
    // mention) after the existence check — compare on the normalized key.
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
    // Reject dotless / placeholder-looking hosts (`http://intranet`,
    // `http://{x}.example.com`) even when `new URL` parses them.
    return HOSTNAME_RE.test(parsed.hostname);
  } catch {
    return false;
  }
}

/** Trim common trailing punctuation glued onto bare URLs in prose (ASCII + CJK,
 *  plus `*` from markdown emphasis such as `**bold**`). */
function stripTrailingUrlPunctuation(url: string): string {
  let out = url;
  while (/[.,;:!?！？。，、；：…*]+$/.test(out)) {
    const trimmed = out.replace(/[.,;:!?！？。，、；：…*]+$/, "");
    if (!isHttpUrl(trimmed)) break;
    out = trimmed;
  }
  // A trailing `)` / `]` is usually prose punctuation (`(see https://…)`,
  // `[1]` citations) — but the same characters may be part of the URL itself
  // (Wikipedia titles). Trim only when the brackets are unbalanced.
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

/**
 * Scan one text part for markdown + bare http(s) URLs. Fenced code blocks
 * (``` / ~~~) are skipped entirely — URLs inside them are code, not citations
 * (e.g. `xmlns="http://www.w3.org/2000/svg"` in an SVG diagram, `git clone
 * https://…` examples). Inline code spans are still scanned: a URL the reply
 * explicitly cites in backticks is a real link.
 */
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

/**
 * Collect unique http(s) URLs cited in the assistant's reply body,
 * first-seen order. Reasoning parts, tool calls / tool results, and user /
 * system messages are never scanned — the card mirrors only what the reply
 * itself links to.
 */
export function collectUrlsFromMessages(
  messages: MessageLikeForModifiedFiles[],
): TurnUrl[] {
  const order: string[] = [];
  const seen = new Set<string>();

  for (const message of messages) {
    if (message.role !== "assistant") continue;
    for (const part of message.parts) {
      // `reasoning` parts are a distinct type, so chain-of-thought URLs
      // cannot leak in; only visible reply text is scanned.
      if (part.type !== "text" || typeof part.text !== "string") continue;
      if (typeof part.id === "string" && SKIP_TEXT_PART_IDS.has(part.id)) {
        continue;
      }
      collectUrlsFromText(part.text, order, seen);
    }
  }

  return order.map((url) => ({ url }));
}
