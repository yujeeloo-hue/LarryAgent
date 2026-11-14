import type {
  CppUsageCandidate,
  CppUsageSearchResult,
} from "../../../main/cppSymbols/types.js";
import { resolveCppLocalBinding } from "./cppLocalBindings.js";
import type { CppLocalBinding } from "./cppLocalBindings.js";
import {
  cppLocalBindingKey,
  filterCppUsageCandidates,
  usageKind,
  type CppUsageTarget,
} from "./cppFindUsages.js";
import type { CppSymbolEntry } from "./cppSymbolIndex.js";
import type { FindUsageRow } from "./FindUsagesView.js";
import { FindUsagesView } from "./FindUsagesView.js";

export type FindUsagesControllerDeps = {
  getTarget: () => Promise<CppUsageTarget | null>;
  getWorkspaceRoot: () => string | null;
  getActiveDocument: () => { path: string; text: string } | null;
  getLiveText: (path: string) => string | null;
  readText: (path: string) => Promise<string | null>;
  lookupSymbols: (word: string) => Promise<CppSymbolEntry[]>;
  revealFileLine: (path: string, line: number, column: number) => void;
  revealPanel: () => void;
  /**
   * clangd semantic references at the caret (compiler-accurate). null =
   * unavailable for this workspace; [] = server answered with nothing and
   * the text search still gets its turn.
   */
  getSemanticReferences?: () => Promise<{
    word: string;
    references: { path: string; line: number; column: number }[];
  } | null>;
};

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

function localCandidates(
  path: string,
  text: string,
  word: string,
): CppUsageCandidate[] {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\b${escaped}\\b`, "g");
  const out: CppUsageCandidate[] = [];
  for (const [index, lineText] of text.split(/\r?\n/).entries()) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(lineText)) !== null) {
      out.push({
        path: norm(path),
        line: index + 1,
        column: match.index + 1,
        lineText: lineText.trim(),
      });
    }
  }
  return out;
}

function receiverWords(
  candidates: readonly CppUsageCandidate[],
  word: string,
): string[] {
  const names = new Set<string>();
  for (const candidate of candidates) {
    const before = candidate.lineText.slice(
      0,
      Math.max(0, candidate.lineText.lastIndexOf(word)),
    );
    const receiver = /([A-Za-z_]\w*)\s*(?:->|\.)\s*$/.exec(before)?.[1];
    if (receiver && receiver !== "this") names.add(receiver);
    // `lineText` is trimmed, so a column-based slice may be offset. The
    // lastIndexOf path above is the stable fallback used for symbol lookup.
  }
  return [...names];
}

export async function inferAutoReturnTypes(
  candidates: readonly CppUsageCandidate[],
  texts: ReadonlyMap<string, string>,
  lookupSymbols: (word: string) => Promise<CppSymbolEntry[]>,
): Promise<Map<string, string>> {
  const pending = new Map<
    string,
    {
      binding: CppLocalBinding;
      text: string;
      path: string;
      name?: string;
      qualifier?: string;
      expression?: string;
      element: boolean;
    }
  >();
  for (const candidate of candidates) {
    const path = norm(candidate.path);
    const text = texts.get(path);
    if (!text) continue;
    const lineText = text.split(/\r?\n/)[candidate.line - 1] ?? "";
    const before = lineText.slice(0, Math.max(0, candidate.column - 1));
    const receiverMatch = /([A-Za-z_]\w*)\s*(?:->|\.)\s*$/.exec(before);
    if (!receiverMatch?.[1] || receiverMatch[1] === "this") continue;
    const receiver = receiverMatch[1];
    const column = before.lastIndexOf(receiver) + 1;
    const binding = resolveCppLocalBinding(
      text,
      candidate.line,
      column,
    );
    if (
      !binding ||
      binding.inferredType ||
      !/\bauto\b/.test(binding.type)
    ) {
      continue;
    }
    pending.set(cppLocalBindingKey(path, binding), {
      binding,
      text,
      path,
      ...(binding.initializerCall ?? {}),
      ...((binding.rangeExpression ?? binding.initializerExpression)
        ? {
            expression:
              binding.rangeExpression ?? binding.initializerExpression,
          }
        : {}),
      element:
        Boolean(binding.rangeExpression) ||
        /\[[^\]]*\]\s*$/.test(binding.initializerExpression ?? ""),
    });
  }

  const byName = new Map<string, CppSymbolEntry[]>();
  const lookupNames = new Set<string>();
  for (const item of pending.values()) {
    if (item.name) lookupNames.add(item.name);
    const sourceName = finalExpressionName(item.expression);
    if (sourceName) lookupNames.add(sourceName);
  }
  await Promise.all(
    [...lookupNames].map(async (name) => {
      byName.set(name, await lookupSymbols(name));
    }),
  );
  const inferred = new Map<string, string>();
  for (const [key, item] of pending) {
    let inferredType: string | null = null;
    if (item.name) {
      let entries = (byName.get(item.name) ?? []).filter(
        (entry) => entry.kind === "function" && entry.returnType,
      );
      if (item.qualifier) {
        const qualified = entries.filter(
          (entry) => entry.container === item.qualifier,
        );
        if (qualified.length > 0) entries = qualified;
      }
      const types = [
        ...new Set(entries.map((entry) => entry.returnType!).filter(Boolean)),
      ];
      if (types.length === 1) inferredType = types[0]!;
    }
    if (!inferredType && item.expression) {
      const sourceName = finalExpressionName(item.expression);
      if (sourceName) {
        const line =
          item.text.split(/\r?\n/)[item.binding.declarationLine - 1] ?? "";
        const searchFrom = Math.max(0, item.binding.declarationColumn);
        const sourceColumn = line.indexOf(sourceName, searchFrom) + 1;
        const sourceBinding =
          sourceColumn > 0
            ? resolveCppLocalBinding(
                item.text,
                item.binding.declarationLine,
                sourceColumn,
              )
            : null;
        inferredType = sourceBinding
          ? sourceBinding.inferredType ?? sourceBinding.type
          : uniqueVariableType(byName.get(sourceName) ?? []);
      }
    }
    if (inferredType && item.element) {
      inferredType = cppContainerElementType(inferredType);
    }
    if (inferredType && !/\bauto\b/.test(inferredType)) {
      inferred.set(key, inferredType);
    }
  }
  return inferred;
}

function finalExpressionName(expression: string | undefined): string | null {
  if (!expression) return null;
  const withoutIndex = expression.replace(/\[[^\]]*\]\s*$/, "");
  const match = /([A-Za-z_]\w*)\s*$/.exec(withoutIndex);
  return match?.[1] ?? null;
}

function uniqueVariableType(entries: readonly CppSymbolEntry[]): string | null {
  const types = [
    ...new Set(
      entries
        .filter((entry) => entry.kind === "variable" && entry.returnType)
        .map((entry) => entry.returnType!),
    ),
  ];
  return types.length === 1 ? types[0]! : null;
}

export function cppContainerElementType(type: string): string | null {
  const compact = type
    .replace(/\b(?:const|volatile)\b/g, " ")
    .replace(/[&*]\s*$/g, "")
    .trim();
  const sequence = /^(?:TArray|TSet)\s*<([\s\S]+)>$/.exec(compact);
  if (sequence?.[1]) return sequence[1].trim();
  const map = /^TMap\s*<([\s\S]+)>$/.exec(compact);
  if (!map?.[1]) return null;
  let depth = 0;
  for (let i = 0; i < map[1].length; i++) {
    const ch = map[1][i]!;
    if (ch === "<") depth += 1;
    else if (ch === ">") depth -= 1;
    else if (ch === "," && depth === 0) {
      return `TPair<${map[1].slice(0, i).trim()}, ${map[1].slice(i + 1).trim()}>`;
    }
  }
  return null;
}

export class FindUsagesController {
  private querySerial = 0;
  private activeQueryId: string | null = null;

  constructor(
    readonly view: FindUsagesView,
    private readonly deps: FindUsagesControllerDeps,
  ) {
    this.view.onOpen = (row) =>
      this.deps.revealFileLine(row.path, row.line, row.column);
  }

  async find(): Promise<void> {
    // Reveal + spinner before any await: clangd availability probes and
    // cold preamble builds can hold the first row back for seconds — the
    // panel must open with a live "Searching…" state the moment the user
    // asks for Find Usages (the word fills in once the target resolves).
    this.deps.revealPanel();
    this.view.renderLoading();
    // clangd first — compiler-accurate references incl. engine code. Falls
    // through to the text search on any miss.
    const semantic = await this.deps.getSemanticReferences?.();
    if (semantic) {
      await this.cancel();
      this.view.renderLoading(semantic.word);
      const rows = await this.rowsForReferences(semantic.word, semantic.references);
      if (rows.length === 0) {
        this.view.renderEmpty(
          semantic.references.length === 0
            ? `No usages found for ${semantic.word}.`
            : `References for ${semantic.word} could not be read.`,
        );
      } else {
        this.view.renderResults(semantic.word, rows, {
          scannedFiles: new Set(rows.map((row) => row.path)).size,
        });
      }
      return;
    }
    const target = await this.deps.getTarget();
    if (!target) {
      this.view.renderEmpty("No C++ symbol at the caret.");
      return;
    }
    const root = this.deps.getWorkspaceRoot();
    if (!root) return;
    await this.cancel();
    const queryId = `cpp-usage-${Date.now()}-${++this.querySerial}`;
    this.activeQueryId = queryId;
    this.view.renderLoading(target.word);

    let result: CppUsageSearchResult;
    if (target.kind === "local") {
      result = {
        queryId,
        matches: localCandidates(target.path, target.text, target.word),
        scannedFiles: 1,
        truncated: false,
      };
    } else {
      const active = this.deps.getActiveDocument();
      const bridge = window.jellybot;
      if (!bridge) {
        this.view.renderEmpty("Find Usages is unavailable.");
        return;
      }
      try {
        result = await bridge.findCppUsages(root, {
          queryId,
          word: target.word,
          ...(active
            ? { overlay: { path: norm(active.path), text: active.text } }
            : {}),
        });
      } catch {
        result = {
          queryId,
          matches: [],
          scannedFiles: 0,
          truncated: false,
        };
      }
    }
    if (this.activeQueryId !== queryId || result.cancelled) return;

    const texts = new Map<string, string>();
    if (target.kind === "local") {
      texts.set(norm(target.path), target.text);
    } else {
      const paths = [...new Set(result.matches.map((match) => norm(match.path)))];
      await Promise.all(
        paths.map(async (path) => {
          const live = this.deps.getLiveText(path);
          const text = live ?? (await this.deps.readText(path));
          if (text !== null) texts.set(path, text);
        }),
      );
    }
    if (this.activeQueryId !== queryId) return;

    let memberSymbols: CppSymbolEntry[] = [];
    let inferredLocalTypes = new Map<string, string>();
    if (target.kind === "symbol") {
      const receivers = receiverWords(result.matches, target.word);
      const lookedUp = await Promise.all(
        receivers.map((name) => this.deps.lookupSymbols(name)),
      );
      memberSymbols = lookedUp.flat();
      inferredLocalTypes = await inferAutoReturnTypes(
        result.matches,
        texts,
        this.deps.lookupSymbols,
      );
    }
    const rows = filterCppUsageCandidates(
      target,
      result.matches,
      texts,
      (text, line, column) => resolveCppLocalBinding(text, line, column),
      memberSymbols,
      inferredLocalTypes,
    );
    if (this.activeQueryId !== queryId) return;
    this.activeQueryId = null;
    if (rows.length === 0) {
      this.view.renderEmpty(`No usages found for ${target.word}.`);
      return;
    }
    this.view.renderResults(target.word, rows, {
      truncated: result.truncated,
      scannedFiles: result.scannedFiles,
    });
  }

  /**
   * Build view rows from clangd locations: fetch each hit's line text
   * (live buffer first, disk second) and classify read/write/call/address
   * with the same heuristic the text-index rows use.
   */
  private async rowsForReferences(
    word: string,
    references: readonly { path: string; line: number; column: number }[],
  ): Promise<FindUsageRow[]> {
    const paths = [...new Set(references.map((ref) => norm(ref.path)))];
    const texts = new Map<string, string>();
    await Promise.all(
      paths.map(async (path) => {
        const live = this.deps.getLiveText(path);
        const text = live ?? (await this.deps.readText(path));
        if (text !== null) texts.set(path, text);
      }),
    );
    const rows: FindUsageRow[] = [];
    for (const ref of references) {
      const path = norm(ref.path);
      const text = texts.get(path);
      if (!text) continue;
      const lineText = (text.split(/\r?\n/)[ref.line - 1] ?? "").trim();
      if (!lineText) continue;
      rows.push({
        path,
        line: ref.line,
        column: ref.column,
        lineText,
        kind: usageKind(text.split(/\r?\n/)[ref.line - 1] ?? "", ref.column, word),
      });
      if (rows.length >= 500) break;
    }
    return rows;
  }

  async cancel(): Promise<void> {
    const queryId = this.activeQueryId;
    this.activeQueryId = null;
    if (!queryId) return;
    const bridge = window.jellybot;
    if (!bridge) return;
    try {
      await bridge.cancelCppUsageSearch(queryId);
    } catch {
      // Search may already have completed.
    }
  }

  clear(): void {
    void this.cancel();
    this.view.renderEmpty();
  }

  destroy(): void {
    void this.cancel();
    this.view.onOpen = null;
  }
}
