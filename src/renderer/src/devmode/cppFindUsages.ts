import type { CppUsageCandidate } from "../../../main/cppSymbols/types.js";
import { resolveEnclosingContainer } from "./cppContainerContext.js";
import type { CppLocalBinding } from "./cppLocalBindings.js";
import type { CppSymbolEntry } from "./cppSymbolIndex.js";
import type { FindUsageRow } from "./FindUsagesView.js";

export type CppLocalBindingLike = CppLocalBinding;

export type CppUsageTarget =
  | {
      kind: "local";
      word: string;
      path: string;
      text: string;
      binding: CppLocalBindingLike;
    }
  | {
      kind: "symbol";
      word: string;
      entries: CppSymbolEntry[];
      primary: CppSymbolEntry;
    };

export type ResolveLocalBinding = (
  text: string,
  line: number,
  column: number,
  word: string,
) => CppLocalBindingLike | null;

function lineStartOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

function offsetAt(text: string, line: number, column: number): number {
  const starts = lineStartOffsets(text);
  return (starts[line - 1] ?? text.length) + Math.max(0, column - 1);
}

function isCodeOffset(text: string, offset: number): boolean {
  let state: "code" | "line" | "block" | "string" | "char" = "code";
  for (let i = 0; i < text.length && i <= offset; i++) {
    const ch = text[i]!;
    const next = text[i + 1];
    if (state === "line") {
      if (ch === "\n") state = "code";
      continue;
    }
    if (state === "block") {
      if (ch === "*" && next === "/") {
        state = "code";
        i += 1;
      }
      continue;
    }
    if (state === "string" || state === "char") {
      if (ch === "\\") {
        i += 1;
        continue;
      }
      if (
        (state === "string" && ch === '"') ||
        (state === "char" && ch === "'")
      ) {
        state = "code";
      }
      continue;
    }
    if (ch === "/" && next === "/") {
      state = "line";
      i += 1;
    } else if (ch === "/" && next === "*") {
      state = "block";
      i += 1;
    } else if (ch === '"') {
      state = "string";
    } else if (ch === "'") {
      state = "char";
    }
  }
  return state === "code";
}

export function baseCppTypeName(type: string): string | null {
  let value = type
    .replace(/\b(?:const|volatile|class|struct|typename)\b/g, " ")
    .replace(/[*&]/g, " ")
    .trim();
  for (let i = 0; i < 4; i++) {
    const wrapper =
      /^(?:TObjectPtr|TWeakObjectPtr|TSoftObjectPtr|TSharedPtr|TSharedRef|TUniquePtr)\s*<\s*([A-Za-z_]\w*(?:::\w+)*)\s*>$/.exec(
        value,
      );
    if (!wrapper) break;
    value = wrapper[1]!;
  }
  const names = value.match(/[A-Za-z_]\w*/g);
  return names?.[names.length - 1] ?? null;
}

function sameBinding(
  left: CppLocalBindingLike,
  right: CppLocalBindingLike,
): boolean {
  return (
    left.kind === right.kind &&
    left.name === right.name &&
    left.declarationLine === right.declarationLine &&
    left.declarationColumn === right.declarationColumn
  );
}

export function cppLocalBindingKey(
  path: string,
  binding: CppLocalBindingLike,
): string {
  return `${path.replace(/\\/g, "/")}:${binding.declarationLine}:${binding.declarationColumn}`;
}

/**
 * Heuristic read/write/call/address classification for one usage line —
 * exported for the clangd semantic path (FindUsagesController), which has
 * the same need as the text-index rows.
 */
export function usageKind(
  line: string,
  column: number,
  word: string,
): FindUsageRow["kind"] {
  const start = Math.max(0, column - 1);
  // Column may point at a stale/trimmed position — fall back to the word.
  const at = line.slice(start, start + word.length) === word
    ? start
    : line.indexOf(word);
  const begin = at < 0 ? start : at;
  const before = line.slice(0, begin);
  const after = line.slice(begin + word.length);
  if (/&\s*(?:[A-Za-z_]\w*\s*::\s*)?$/.test(before)) return "address";
  // `=(?!=)` keeps `==` comparisons classified as reads.
  if (/^\s*(?:=(?!=)|\+=|-=|\*=|\/=|%=|\+\+|--|<<=|>>=|&=|\|=|\^=)/.test(after)) return "write";
  if (/(?:\+\+|--)\s*$/.test(before)) return "write";
  if (/^\s*(?:<[^;()]*>)?\s*\(/.test(after)) return "call";
  return "read";
}

function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1] ?? "";
}

function entryIsDefinition(
  candidate: CppUsageCandidate,
  entries: readonly CppSymbolEntry[],
): boolean {
  const path = candidate.path.replace(/\\/g, "/");
  return entries.some(
    (entry) =>
      entry.path.replace(/\\/g, "/") === path && entry.line === candidate.line,
  );
}

export function filterCppUsageCandidates(
  target: CppUsageTarget,
  candidates: readonly CppUsageCandidate[],
  texts: ReadonlyMap<string, string>,
  resolveLocal: ResolveLocalBinding,
  memberSymbols: readonly CppSymbolEntry[] = [],
  inferredLocalTypes: ReadonlyMap<string, string> = new Map(),
): FindUsageRow[] {
  const rows: FindUsageRow[] = [];
  for (const candidate of candidates) {
    const path = candidate.path.replace(/\\/g, "/");
    const text = texts.get(path);
    if (text == null) continue;
    const offset = offsetAt(text, candidate.line, candidate.column);
    const line = lineAt(text, candidate.line);
    if (!isCodeOffset(text, offset) || line.trimStart().startsWith("#")) continue;

    if (target.kind === "local") {
      if (path !== target.path.replace(/\\/g, "/")) continue;
      const binding = resolveLocal(
        text,
        candidate.line,
        candidate.column,
        target.word,
      );
      if (!binding || !sameBinding(binding, target.binding)) continue;
      if (
        binding.declarationLine === candidate.line &&
        binding.declarationColumn === candidate.column
      ) {
        continue;
      }
      rows.push({
        ...candidate,
        kind: usageKind(line, candidate.column, target.word),
      });
      continue;
    }

    if (entryIsDefinition(candidate, target.entries)) continue;
    const start = Math.max(0, candidate.column - 1);
    const before = line.slice(0, start);
    const after = line.slice(start + target.word.length);
    if (/^\s*</.test(after)) continue; // template invocation is out of scope
    const wantedContainer = target.primary.container ?? null;
    const qualified =
      /([A-Za-z_]\w*(?:::\s*[A-Za-z_]\w*)*)\s*::\s*$/.exec(before);
    if (qualified) {
      const owner = qualified[1]!.split("::").pop()!.trim();
      if (!wantedContainer || owner !== wantedContainer) continue;
    } else {
      const receiver = /([A-Za-z_]\w*)\s*(?:->|\.)\s*$/.exec(before)?.[1];
      const enclosing = resolveEnclosingContainer(text, candidate.line).container;
      if (receiver) {
        if (receiver === "this") {
          if (!wantedContainer || enclosing !== wantedContainer) continue;
        } else {
          const receiverColumn =
            before.lastIndexOf(receiver) + 1;
          const local = resolveLocal(
            text,
            candidate.line,
            receiverColumn,
            receiver,
          );
          const localType = local
            ? baseCppTypeName(
                local.inferredType ??
                  inferredLocalTypes.get(cppLocalBindingKey(path, local)) ??
                  local.type,
              )
            : null;
          const memberType =
            localType ??
            baseCppTypeName(
              memberSymbols.find(
                (entry) =>
                  entry.name === receiver &&
                  entry.kind === "variable" &&
                  entry.container === enclosing,
              )?.returnType ?? "",
            );
          if (!wantedContainer || memberType !== wantedContainer) continue;
        }
      } else if (wantedContainer) {
        if (enclosing !== wantedContainer) continue;
      }
    }
    rows.push({
      ...candidate,
      kind: usageKind(line, candidate.column, target.word),
    });
  }
  return rows.sort(
    (a, b) =>
      a.path.localeCompare(b.path) ||
      a.line - b.line ||
      a.column - b.column,
  );
}
