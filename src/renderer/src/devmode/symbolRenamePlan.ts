import {
  applyLspTextEdits,
  lspRangeText,
  type LspFileEdit,
  type LspTextEdit,
} from "../../../shared/lspEdits.js";
import { isUhtGeneratedPath } from "./goToDefinition.js";

export type RenameSourceFile = {
  text: string;
  open: boolean;
  dirty: boolean;
  version: number | null;
  hadBom: boolean;
  readOnly: boolean;
};

export type PlannedRenameFile = {
  path: string;
  base: string;
  newText: string;
  edits: LspTextEdit[];
  occurrences: number;
  open: boolean;
  dirty: boolean;
  version: number | null;
  hadBom: boolean;
};

export type RenamePlan =
  | { ok: true; files: PlannedRenameFile[]; occurrences: number }
  | { ok: false; message: string };

export function renameKey(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

export function isInsideWorkspace(path: string, root: string): boolean {
  const base = renameKey(root).replace(/\/+$/, "");
  return base.length > 0 && renameKey(path).startsWith(`${base}/`);
}

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

export type RenameTargets = {
  targets: LspFileEdit[];
  skippedGenerated: LspFileEdit[];
  outside: string | null;
};

export function renameTargets(root: string, files: readonly LspFileEdit[]): RenameTargets {
  const merged = new Map<string, LspFileEdit>();
  const skippedGenerated: LspFileEdit[] = [];
  for (const file of files) {
    if (!isInsideWorkspace(file.path, root)) {
      return { targets: [], skippedGenerated: [], outside: file.path };
    }
    if (isUhtGeneratedPath(file.path)) {
      skippedGenerated.push(file);
      continue;
    }
    const key = renameKey(file.path);
    const entry = merged.get(key) ?? { path: file.path, edits: [] };
    const seen = new Set(entry.edits.map((edit) => JSON.stringify(edit)));
    for (const edit of file.edits) {
      const serialized = JSON.stringify(edit);
      if (seen.has(serialized)) continue;
      seen.add(serialized);
      entry.edits.push(edit);
    }
    merged.set(key, entry);
  }
  return { targets: [...merged.values()], skippedGenerated, outside: null };
}

export function planSymbolRename(input: {
  oldName: string;
  targets: readonly LspFileEdit[];
  sources: ReadonlyMap<string, RenameSourceFile>;
}): RenamePlan {
  const files: PlannedRenameFile[] = [];
  let occurrences = 0;
  for (const target of input.targets) {
    const name = baseName(target.path);
    const source = input.sources.get(renameKey(target.path));
    if (!source) return { ok: false, message: `Could not read ${name}. Nothing was changed.` };
    if (source.readOnly) return { ok: false, message: `${name} is read-only. Nothing was changed.` };
    const stale = `The rename result no longer matches ${name}. Nothing was changed; try again.`;
    let newText: string;
    try {
      for (const edit of target.edits) {
        if (lspRangeText(source.text, edit) !== input.oldName) return { ok: false, message: stale };
      }
      newText = applyLspTextEdits(source.text, target.edits);
    } catch {
      return { ok: false, message: stale };
    }
    files.push({
      path: target.path,
      base: source.text,
      newText,
      edits: target.edits,
      occurrences: target.edits.length,
      open: source.open,
      dirty: source.dirty,
      version: source.version,
      hadBom: source.hadBom,
    });
    occurrences += target.edits.length;
  }
  return { ok: true, files, occurrences };
}
