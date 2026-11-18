import type { AgentFlashRange } from "../../../devmode/agentFlash.js";

export type PartialWriteFileArgs = {
  path?: string;
  title?: string;
  content?: string;
  patchText?: string;
  oldString?: string;
  newString?: string;
};

export function patchHeaderPathFromText(patchText: string): string | undefined {
  const lines = patchText.split(/\r?\n/);
  if (lines.length > 0 && !/[\r\n]$/.test(patchText)) lines.pop();
  for (const line of lines) {
    const v4a = /^\*\*\*\s*(?:Update|Add|Delete)\s+File:\s*(.+)$/.exec(line);
    if (v4a?.[1]) {
      const rest = v4a[1].trim();
      if (rest) return rest;
    }
    const move = /^\*\*\*\s*Move\s+File:\s*(.+?)\s*->\s*/.exec(line);
    if (move?.[1]) {
      const rest = move[1].trim();
      if (rest) return rest;
    }
    if (line.startsWith("--- ")) {
      const rest = line.slice(4).split("\t")[0]?.trim() ?? "";
      if (rest && rest !== "/dev/null") {
        return stripPatchPrefix(rest);
      }
    }
    if (line.startsWith("+++ ")) {
      const rest = line.slice(4).split("\t")[0]?.trim() ?? "";
      if (rest && rest !== "/dev/null") {
        return stripPatchPrefix(rest);
      }
    }
  }
  return undefined;
}

export function patchHeaderPathsFromText(patchText: string): string[] {
  const paths: string[] = [];
  for (const line of patchText.split(/\r?\n/)) {
    const v4a = /^\*\*\*\s*(?:Update|Add)\s+File:\s*(.+)$/.exec(line);
    const rest = v4a?.[1]?.trim();
    if (rest && !paths.includes(rest)) paths.push(rest);
  }
  return paths;
}

export function patchChangedRangesFromText(
  patchText: string,
): Array<{ path: string; ranges: AgentFlashRange[] }> {
  const files: Array<{ path: string; ranges: AgentFlashRange[] }> = [];
  let current: { path: string; ranges: AgentFlashRange[] } | null = null;
  let newLine = 0;
  let addRun: { first: number; last: number } | null = null;
  let delAnchor: number | null = null;

  const flushRun = (): void => {
    if (!current) return;
    if (addRun) {
      current.ranges.push({ start: addRun.first, end: addRun.last, kind: "add" });
      addRun = null;
    }
    if (delAnchor !== null) {
      current.ranges.push({ start: delAnchor, end: delAnchor, kind: "del" });
      delAnchor = null;
    }
  };
  const flushFile = (): void => {
    flushRun();
    if (current) files.push(current);
    current = null;
  };

  for (const line of patchText.split(/\r?\n/)) {
    const header = /^\*\*\*\s*(Update|Add)\s+File:\s*(.+)$/.exec(line);
    if (header?.[2]) {
      flushFile();
      current = { path: header[2].trim(), ranges: [] };
      newLine = 1;
      continue;
    }
    if (/^\*\*\*\s*(Delete|Move)\s+File:/.test(line) || /^\*\*\*\s*End\s+Patch/.test(line)) {
      flushFile();
      continue;
    }
    const hunk = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s*@@/.exec(line);
    if (hunk) {
      flushRun();
      newLine = Number(hunk[3]);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("+")) {
      if (addRun) addRun.last = newLine;
      else addRun = { first: newLine, last: newLine };
      newLine += 1;
      continue;
    }
    if (line.startsWith("-")) {
      const anchor = Math.max(1, newLine);
      if (delAnchor === null) delAnchor = anchor;
      continue;
    }
    flushRun();
    newLine += 1;
  }
  flushFile();
  return files.filter((file) => file.path.length > 0);
}

function stripPatchPrefix(path: string): string {
  if (path.startsWith("a/") || path.startsWith("b/")) return path.slice(2);
  return path;
}

function decodeJsonStringBody(body: string): string {
  let out = "";
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch !== "\\") {
      out += ch;
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) {
      break;
    }
    i += 1;
    switch (next) {
      case '"':
      case "\\":
      case "/":
        out += next;
        break;
      case "b":
        out += "\b";
        break;
      case "f":
        out += "\f";
        break;
      case "n":
        out += "\n";
        break;
      case "r":
        out += "\r";
        break;
      case "t":
        out += "\t";
        break;
      case "u": {
        const hex = body.slice(i + 1, i + 5);
        if (/^[0-9a-fA-F]{4}$/.test(hex)) {
          out += String.fromCharCode(parseInt(hex, 16));
          i += 4;
        } else {
          break;
        }
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

function readJsonStringAt(
  raw: string,
  openQuoteIndex: number,
): { value: string; closed: boolean; end: number } | null {
  if (raw[openQuoteIndex] !== '"') return null;
  let i = openQuoteIndex + 1;
  let body = "";
  while (i < raw.length) {
    const ch = raw[i]!;
    if (ch === '"') {
      return {
        value: decodeJsonStringBody(body),
        closed: true,
        end: i + 1,
      };
    }
    if (ch === "\\") {
      body += ch;
      if (i + 1 < raw.length) {
        body += raw[i + 1]!;
        i += 2;
        continue;
      }
      return {
        value: decodeJsonStringBody(body.slice(0, -1)),
        closed: false,
        end: raw.length,
      };
    }
    body += ch;
    i += 1;
  }
  return {
    value: decodeJsonStringBody(body),
    closed: false,
    end: raw.length,
  };
}

function extractStringField(raw: string, field: string): string | undefined {
  const key = `"${field}"`;
  let searchFrom = 0;
  while (searchFrom < raw.length) {
    const keyAt = raw.indexOf(key, searchFrom);
    if (keyAt < 0) return undefined;
    let i = keyAt + key.length;
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    if (raw[i] !== ":") {
      searchFrom = keyAt + 1;
      continue;
    }
    i += 1;
    while (i < raw.length && /\s/.test(raw[i]!)) i += 1;
    if (raw[i] !== '"') {
      searchFrom = keyAt + 1;
      continue;
    }
    const read = readJsonStringAt(raw, i);
    if (!read) return undefined;
    return read.value;
  }
  return undefined;
}

export function parsePartialWriteFileArgs(raw: string): PartialWriteFileArgs {
  const trimmed = raw.trim();
  if (!trimmed) return {};

  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const out: PartialWriteFileArgs = {};
      if (typeof parsed.path === "string") out.path = parsed.path;
      if (typeof parsed.title === "string") out.title = parsed.title;
      if (typeof parsed.content === "string") out.content = parsed.content;
      if (typeof parsed.patch === "string") out.patchText = parsed.patch;
      else if (typeof parsed.patch_text === "string") out.patchText = parsed.patch_text;
      if (typeof parsed.old_string === "string") out.oldString = parsed.old_string;
      if (typeof parsed.new_string === "string") out.newString = parsed.new_string;
      return out;
    }
  } catch {
  }

  const out: PartialWriteFileArgs = {};
  const path = extractStringField(trimmed, "path");
  if (path !== undefined) out.path = path;
  const title = extractStringField(trimmed, "title");
  if (title !== undefined) out.title = title;
  const content = extractStringField(trimmed, "content");
  if (content !== undefined) out.content = content;
  const patch =
    extractStringField(trimmed, "patch") ?? extractStringField(trimmed, "patch_text");
  if (patch !== undefined) out.patchText = patch;
  const oldString = extractStringField(trimmed, "old_string");
  if (oldString !== undefined) out.oldString = oldString;
  const newString = extractStringField(trimmed, "new_string");
  if (newString !== undefined) out.newString = newString;
  return out;
}
