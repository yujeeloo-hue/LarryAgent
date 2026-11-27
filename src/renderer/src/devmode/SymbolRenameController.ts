import {
  lspRangeText,
  type LspFileEdit,
  type LspRange,
  type LspTextEdit,
} from "../../../shared/lspEdits.js";
import {
  planSymbolRename,
  renameKey,
  renameTargets,
  type PlannedRenameFile,
  type RenameSourceFile,
} from "./symbolRenamePlan.js";

export type SymbolRenameRequest = {
  path: string;
  line: number;
  column: number;
  text: string;
};

export type SymbolRenameBackend = {
  prepare(
    root: string,
    request: SymbolRenameRequest,
  ): Promise<{ ok: true; range: LspRange | null } | { ok: false; message: string }>;
  rename(
    root: string,
    request: SymbolRenameRequest,
    newName: string,
  ): Promise<{ ok: true; files: LspFileEdit[] } | { ok: false; message: string }>;
};

export type OpenDocument = {
  version: number;
  text: string;
  dirty: boolean;
  readOnly: boolean;
  hadBom: boolean;
};

export type SymbolRenameTarget = {
  languageId: string;
  path: string;
  line: number;
  column: number;
  text: string;
  word: string | null;
};

export type SymbolRenameDeps = {
  workspaceRoot: () => string | null;
  backendFor: (languageId: string) => SymbolRenameBackend | null;
  openDocument: (path: string) => OpenDocument | null;
  openVersions: () => ReadonlyMap<string, number>;
  applyOpenEdits: (path: string, edits: readonly LspTextEdit[]) => boolean;
  saveOpenDocument: (path: string) => Promise<{ ok: true } | { ok: false; message: string }>;
  readFile: (path: string) => Promise<{ ok: true; text: string; hadBom: boolean } | { ok: false; message: string }>;
  writeFile: (path: string, text: string, hadBom: boolean) => Promise<{ ok: true } | { ok: false; message: string }>;
  promptName: (oldName: string) => Promise<string | null>;
  confirm: (message: string, detail: string) => Promise<boolean>;
  notice: (message: string, ttlMs?: number) => void;
};

const PROGRESS_TTL_MS = 60_000;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

function summarize(files: readonly PlannedRenameFile[]): string {
  const names = files.slice(0, 5).map((file) => baseName(file.path));
  const more = files.length > names.length ? ` and ${files.length - names.length} more` : "";
  return names.join(", ") + more;
}

export class SymbolRenameController {
  constructor(private readonly deps: SymbolRenameDeps) {}

  async rename(target: SymbolRenameTarget): Promise<void> {
    const { deps } = this;
    const root = deps.workspaceRoot();
    if (!root) {
      deps.notice("Open a workspace before renaming symbols.", 4000);
      return;
    }
    const backend = deps.backendFor(target.languageId);
    if (!backend) {
      deps.notice("Rename is available for C++ and Lua files.", 4000);
      return;
    }
    if (deps.openDocument(target.path)?.readOnly) {
      deps.notice(`${baseName(target.path)} is read-only.`, 4000);
      return;
    }
    const request: SymbolRenameRequest = {
      path: target.path,
      line: target.line,
      column: target.column,
      text: target.text,
    };
    const prepared = await backend.prepare(root, request);
    if (!prepared.ok) {
      deps.notice(prepared.message, 4000);
      return;
    }
    const oldName = this.nameAtRange(target.text, prepared.range) ?? target.word;
    if (!oldName) {
      deps.notice("Place the caret on a symbol to rename it.", 3000);
      return;
    }
    const newName = await deps.promptName(oldName);
    if (newName === null || newName === oldName) return;

    const versionsBefore = new Map(
      [...deps.openVersions()].map(([path, version]) => [renameKey(path), version] as const),
    );
    deps.notice(`Renaming ${oldName}…`, PROGRESS_TTL_MS);
    const result = await backend.rename(root, request, newName);
    if (!result.ok) {
      deps.notice(result.message, 5000);
      return;
    }
    if (result.files.length === 0) {
      deps.notice(`No occurrences of ${oldName} to rename.`, 3000);
      return;
    }

    const scope = renameTargets(root, result.files);
    if (scope.outside) {
      deps.notice(`Rename would change ${baseName(scope.outside)}, which is outside the workspace. Nothing was changed.`, 6000);
      return;
    }
    const loaded = await this.loadSources(scope.targets);
    if (!loaded.ok) {
      deps.notice(loaded.message, 5000);
      return;
    }
    const plan = planSymbolRename({ oldName, targets: scope.targets, sources: loaded.sources });
    if (!plan.ok) {
      deps.notice(plan.message, 6000);
      return;
    }
    const skipped = scope.skippedGenerated.length;
    if (plan.files.length === 0) {
      deps.notice(
        skipped > 0
          ? `Only generated files reference ${oldName}; they regenerate on the next Unreal build.`
          : `No occurrences of ${oldName} to rename.`,
        5000,
      );
      return;
    }
    if (!this.unchangedSinceRequest(plan.files, versionsBefore)) {
      deps.notice("The file changed while the rename was running. Nothing was changed; try again.", 6000);
      return;
    }

    const writesToDisk = plan.files.some((file) => !file.open || !file.dirty);
    if (plan.files.length > 1 || writesToDisk) {
      const detail =
        `${plan.occurrences} occurrence(s) in ${plan.files.length} file(s): ${summarize(plan.files)}.\n` +
        "Files not open in the editor, and open files without unsaved changes, are saved right away. " +
        "Open files with unsaved changes keep the rename unsaved until you save them.";
      const confirmed = await deps.confirm(`Rename ${oldName} to ${newName}?`, detail);
      if (!confirmed) return;
    }
    if (!(await this.stillCurrent(plan.files))) {
      deps.notice("The file changed before the rename could be applied. Nothing was changed; try again.", 6000);
      return;
    }

    const failures: string[] = [];
    let unsaved = 0;
    for (const file of plan.files) {
      const name = baseName(file.path);
      if (!file.open) {
        const written = await deps.writeFile(file.path, file.newText, file.hadBom);
        if (!written.ok) failures.push(`${name} (${written.message})`);
        continue;
      }
      if (!deps.applyOpenEdits(file.path, file.edits)) {
        failures.push(name);
        continue;
      }
      if (file.dirty) {
        unsaved += 1;
        continue;
      }
      const saved = await deps.saveOpenDocument(file.path);
      if (!saved.ok) failures.push(`${name} (${saved.message})`);
    }

    const summary =
      `Renamed ${oldName} to ${newName}: ${plan.occurrences} occurrence(s) in ${plan.files.length} file(s).`;
    const generated = skipped > 0
      ? ` Left ${skipped} generated file(s) alone; they regenerate on the next Unreal build.`
      : "";
    const pending = unsaved > 0
      ? ` ${unsaved} open file(s) with unsaved changes were edited but not saved.`
      : "";
    if (failures.length > 0) {
      deps.notice(`${summary}${generated}${pending} Could not update: ${failures.join(", ")}.`, 8000);
      return;
    }
    deps.notice(`${summary}${generated}${pending}`, 4000);
  }

  private nameAtRange(text: string, range: LspRange | null): string | null {
    if (!range) return null;
    try {
      const name = lspRangeText(text, range);
      return name.length > 0 ? name : null;
    } catch {
      return null;
    }
  }

  private async loadSources(
    targets: readonly LspFileEdit[],
  ): Promise<{ ok: true; sources: Map<string, RenameSourceFile> } | { ok: false; message: string }> {
    const sources = new Map<string, RenameSourceFile>();
    for (const target of targets) {
      const key = renameKey(target.path);
      const open = this.deps.openDocument(target.path);
      if (open) {
        sources.set(key, {
          text: open.text,
          open: true,
          dirty: open.dirty,
          version: open.version,
          hadBom: open.hadBom,
          readOnly: open.readOnly,
        });
        continue;
      }
      const disk = await this.deps.readFile(target.path);
      if (!disk.ok) return { ok: false, message: `${disk.message} Nothing was changed.` };
      sources.set(key, {
        text: disk.text,
        open: false,
        dirty: false,
        version: null,
        hadBom: disk.hadBom,
        readOnly: false,
      });
    }
    return { ok: true, sources };
  }

  private unchangedSinceRequest(
    files: readonly PlannedRenameFile[],
    versionsBefore: ReadonlyMap<string, number>,
  ): boolean {
    return files.every((file) => {
      if (!file.open) return true;
      return versionsBefore.get(renameKey(file.path)) === file.version;
    });
  }

  private async stillCurrent(files: readonly PlannedRenameFile[]): Promise<boolean> {
    for (const file of files) {
      if (file.open) {
        const doc = this.deps.openDocument(file.path);
        if (!doc || doc.version !== file.version || doc.text !== file.base) return false;
        continue;
      }
      const disk = await this.deps.readFile(file.path);
      if (!disk.ok || disk.text !== file.base) return false;
    }
    return true;
  }
}
