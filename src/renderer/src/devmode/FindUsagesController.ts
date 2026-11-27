import { usageKind } from "./cppFindUsages.js";
import type { BlueprintUsageRow, FindUsageRow } from "./FindUsagesView.js";
import { FindUsagesView } from "./FindUsagesView.js";
import type {
  UnrealBlueprintOpenResult,
  UnrealBlueprintOpenTarget,
  UnrealBlueprintReferencesResult,
  UnrealBlueprintSelectResult,
} from "../../../shared/unrealBlueprintReferences.js";

export type SemanticReference = { path: string; line: number; column: number };

export type SemanticReferencesResult =
  | { status: "ok"; word: string; references: SemanticReference[] }
  | { status: "unsupported" }
  | { status: "no-symbol" }
  | { status: "unavailable"; server: string }
  | { status: "failed"; server: string; word: string; message: string };

export type FindUsagesControllerDeps = {
  getSemanticReferences: () => Promise<SemanticReferencesResult>;
  getBlueprintReferences?: () => Promise<UnrealBlueprintReferencesResult>;
  selectBlueprint?: (row: BlueprintUsageRow) => Promise<UnrealBlueprintSelectResult>;
  openBlueprint?: (target: UnrealBlueprintOpenTarget) => Promise<UnrealBlueprintOpenResult>;
  getLiveText: (path: string) => string | null;
  readText: (path: string) => Promise<string | null>;
  revealFileLine: (path: string, line: number, column: number) => void;
  revealPanel: () => void;
};

const MAX_ROWS = 500;
const CLICK_OPEN_GRACE_MS = 220;

const UNREAL_GENERATED_FILE = /\.(?:gen\.cpp|generated\.h)$/i;

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

function isUnrealGeneratedFile(path: string): boolean {
  return UNREAL_GENERATED_FILE.test(path);
}

function openTarget(row: BlueprintUsageRow): UnrealBlueprintOpenTarget {
  return {
    assetPath: row.assetPath,
    ...(row.graphGuid ? { graphGuid: row.graphGuid } : {}),
    ...(row.nodeGuid ? { nodeGuid: row.nodeGuid } : {}),
  };
}

function blueprintRows(result: UnrealBlueprintReferencesResult): BlueprintUsageRow[] {
  return result.status === "ok" ? result.references : [];
}

function blueprintNotice(result: UnrealBlueprintReferencesResult): string | null {
  switch (result.status) {
    case "not_ready":
      return "Unreal Editor is not ready yet, so Blueprints were not searched.";
    case "failed":
      return `Blueprints could not be searched: ${result.message}`;
    case "ok":
      return result.complete ? null : "Unreal Editor is still indexing Blueprints. This list may be incomplete.";
    default:
      return null;
  }
}

export class FindUsagesController {
  private serial = 0;
  private selectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly view: FindUsagesView,
    private readonly deps: FindUsagesControllerDeps,
  ) {
    this.view.onOpen = (row) => this.deps.revealFileLine(row.path, row.line, row.column);
    this.view.onSelectBlueprint = (row) => this.scheduleSelect(row);
    this.view.onOpenBlueprint = (row) => void this.openBlueprint(row);
    this.view.onClear = () => this.clear();
  }

  async find(): Promise<void> {
    const serial = ++this.serial;
    this.deps.revealPanel();
    this.view.renderLoading();
    const blueprints = this.lookupBlueprints();
    const result = await this.deps.getSemanticReferences();
    if (serial !== this.serial) return;
    switch (result.status) {
      case "unsupported":
        this.view.renderEmpty("Find Usages works on C++, JavaScript and TypeScript symbols.");
        return;
      case "no-symbol":
        this.view.renderEmpty("No symbol at the caret.");
        return;
      case "unavailable":
        this.view.renderEmpty(`Find Usages needs ${result.server}, which is not available for this workspace.`);
        return;
      case "failed":
        this.view.renderEmpty(`${result.server} could not find usages of ${result.word}: ${result.message}`);
        return;
      case "ok":
        break;
    }
    this.view.renderLoading(result.word);
    const references = result.references.filter((ref) => !isUnrealGeneratedFile(ref.path));
    const rows = await this.rowsForReferences(result.word, references);
    if (serial !== this.serial) return;
    const meta = {
      truncated: references.length > MAX_ROWS,
      scannedFiles: new Set(rows.map((row) => row.path)).size,
    };
    if (rows.length > 0) {
      this.view.renderResults(result.word, rows, meta);
      const found = await blueprints;
      if (serial !== this.serial) return;
      if (found.status !== "unavailable") this.view.appendBlueprints(blueprintRows(found), blueprintNotice(found));
      return;
    }
    const found = await blueprints;
    if (serial !== this.serial) return;
    const bpRows = blueprintRows(found);
    if (bpRows.length > 0) {
      this.view.renderResults(result.word, [], { blueprints: bpRows, notice: blueprintNotice(found) });
      return;
    }
    this.view.renderEmpty(
      references.length === 0
        ? `No usages found for ${result.word}.`
        : `References for ${result.word} could not be read.`,
      blueprintNotice(found),
    );
  }

  private lookupBlueprints(): Promise<UnrealBlueprintReferencesResult> {
    const lookup = this.deps.getBlueprintReferences;
    if (!lookup) return Promise.resolve({ status: "unavailable" });
    return lookup().catch((err: unknown) => ({
      status: "failed" as const,
      message: err instanceof Error ? err.message : String(err),
    }));
  }

  private scheduleSelect(row: BlueprintUsageRow): void {
    this.cancelPendingSelect();
    const serial = this.serial;
    this.selectTimer = setTimeout(() => {
      this.selectTimer = null;
      void this.selectBlueprint(row, serial);
    }, CLICK_OPEN_GRACE_MS);
  }

  private cancelPendingSelect(): void {
    if (!this.selectTimer) return;
    clearTimeout(this.selectTimer);
    this.selectTimer = null;
  }

  private async selectBlueprint(row: BlueprintUsageRow, serial: number): Promise<void> {
    let result: UnrealBlueprintSelectResult;
    try {
      result = this.deps.selectBlueprint
        ? await this.deps.selectBlueprint(row)
        : { status: "unsupported" };
    } catch (err) {
      result = { status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (serial !== this.serial) return;
    if (result.status === "ok" || result.status === "unavailable") return;
    if (result.status === "unsupported") {
      await this.openTarget({ assetPath: row.assetPath }, serial);
      return;
    }
    this.view.renderNotice(`Could not select ${row.assetPath}: ${result.message}`);
  }

  private async openBlueprint(row: BlueprintUsageRow): Promise<void> {
    this.cancelPendingSelect();
    await this.openTarget(openTarget(row), this.serial);
  }

  private async openTarget(
    target: UnrealBlueprintOpenTarget,
    serial: number,
  ): Promise<void> {
    const open = this.deps.openBlueprint;
    if (!open) return;
    let result: UnrealBlueprintOpenResult;
    try {
      result = await open(target);
    } catch (err) {
      result = { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
    if (serial !== this.serial) return;
    this.view.renderNotice(
      result.ok ? null : `Could not open ${target.assetPath}: ${result.message}`,
    );
  }

  private async rowsForReferences(
    word: string,
    references: readonly SemanticReference[],
  ): Promise<FindUsageRow[]> {
    const paths = [...new Set(references.map((ref) => norm(ref.path)))];
    const texts = new Map<string, string[]>();
    await Promise.all(
      paths.map(async (path) => {
        const text = this.deps.getLiveText(path) ?? (await this.deps.readText(path));
        if (text !== null) texts.set(path, text.split(/\r?\n/));
      }),
    );
    const rows: FindUsageRow[] = [];
    for (const ref of references) {
      const path = norm(ref.path);
      const line = texts.get(path)?.[ref.line - 1];
      if (line === undefined || !line.trim()) continue;
      rows.push({
        path,
        line: ref.line,
        column: ref.column,
        lineText: line.trim(),
        kind: usageKind(line, ref.column, word),
      });
      if (rows.length >= MAX_ROWS) break;
    }
    return rows;
  }

  clear(): void {
    this.serial++;
    this.cancelPendingSelect();
    this.view.renderEmpty();
  }

  destroy(): void {
    this.serial++;
    this.cancelPendingSelect();
    this.view.onOpen = null;
    this.view.onSelectBlueprint = null;
    this.view.onOpenBlueprint = null;
  }
}
