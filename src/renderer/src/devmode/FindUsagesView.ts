import {
  BrushCleaning,
  CodeXml,
  FileText,
  createLucideIcon,
} from "../ui/originalIcons.js";
import { Workflow } from "lucide";
import { paneHeadIcon } from "./paneHeadIcons.js";
import type {
  UnrealBlueprintReference,
  UnrealBlueprintReferenceKind,
} from "../../../shared/unrealBlueprintReferences.js";

export type FindUsageRow = {
  path: string;
  line: number;
  column: number;
  lineText: string;
  kind: "call" | "read" | "write" | "address";
};

function basename(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut === -1 ? "" : normalized.slice(0, cut + 1);
}

const CODE_EXT = /\.(h|hpp|hxx|c|cc|cpp|cxx|inl|ipp|tpp|cs|inc|ts|tsx|js|mjs)$/i;

function fileIconFor(path: string): SVGElement {
  return createLucideIcon(CODE_EXT.test(path) ? CodeXml : FileText, {
    size: 12,
    strokeWidth: 2,
  });
}

function appendLineText(
  code: HTMLElement,
  lineText: string,
  column: number,
  word: string,
): void {
  const text = lineText || "(empty line)";
  const byColumn = column - 1;
  const hit =
    byColumn >= 0 && text.slice(byColumn, byColumn + word.length) === word
      ? byColumn
      : text.indexOf(word);
  if (hit < 0) {
    code.textContent = text;
    return;
  }
  const mark = document.createElement("span");
  mark.className = "devmode-references-hit";
  mark.textContent = text.slice(hit, hit + word.length);
  code.append(
    document.createTextNode(text.slice(0, hit)),
    mark,
    document.createTextNode(text.slice(hit + word.length)),
  );
}

export type BlueprintUsageRow = UnrealBlueprintReference;

const BLUEPRINT_KIND_LABELS: Record<UnrealBlueprintReferenceKind, string> = {
  call: "call",
  event_override: "event",
  parent_class: "subclass",
  cast: "cast",
  variable_type: "variable",
  class_pin: "class pin",
};

function assetName(assetPath: string): string {
  const tail = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  const dot = tail.indexOf(".");
  return dot === -1 ? tail : tail.slice(0, dot);
}

function assetDir(assetPath: string): string {
  const cut = assetPath.lastIndexOf("/");
  return cut === -1 ? "" : assetPath.slice(0, cut + 1);
}

function blueprintRowText(row: BlueprintUsageRow): string {
  if (row.nodeTitle && row.graph) return `${row.graph} · ${row.nodeTitle}`;
  return row.nodeTitle ?? row.graph ?? assetName(row.assetPath);
}

export type FindUsageRowKind = FindUsageRow["kind"];
type UsageFilter = "all" | FindUsageRowKind | "blueprint";

const FILTER_KINDS: FindUsageRowKind[] = ["read", "write", "call", "address"];

export class FindUsagesView {
  readonly root: HTMLElement;
  private readonly status: HTMLDivElement;
  private readonly filters: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly loading: HTMLDivElement;
  private readonly loadingText: HTMLSpanElement;
  private readonly notice: HTMLDivElement;
  onOpen: ((row: FindUsageRow) => void) | null = null;
  onSelectBlueprint: ((row: BlueprintUsageRow) => void) | null = null;
  onOpenBlueprint: ((row: BlueprintUsageRow) => void) | null = null;
  onClear: (() => void) | null = null;
  private currentWord = "";
  private currentRows: readonly FindUsageRow[] = [];
  private currentBlueprints: readonly BlueprintUsageRow[] = [];
  private currentMeta: { truncated?: boolean; scannedFiles?: number } = {};
  private filter: UsageFilter = "all";

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-references";
    this.status = document.createElement("div");
    this.status.className = "devmode-references-status";
    this.filters = document.createElement("div");
    this.filters.className = "devmode-references-filters";
    this.notice = document.createElement("div");
    this.notice.className = "devmode-references-notice";
    this.notice.hidden = true;
    this.list = document.createElement("div");
    this.list.className = "devmode-references-list";
    this.loading = document.createElement("div");
    this.loading.className = "devmode-references-loading";
    const spinner = document.createElement("span");
    spinner.className = "devmode-references-spinner";
    spinner.setAttribute("aria-hidden", "true");
    this.loadingText = document.createElement("span");
    this.loading.append(spinner, this.loadingText);
    const head = document.createElement("div");
    head.className = "devmode-references-head";
    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "devmode-references-clear";
    clear.title = "Clear results";
    clear.setAttribute("aria-label", "Clear results");
    clear.append(paneHeadIcon(BrushCleaning));
    clear.addEventListener("click", () => this.onClear?.());
    head.append(this.status, clear);
    this.root.append(head, this.filters, this.notice, this.list, this.loading);
    this.renderEmpty("Find Usages from the editor or press Shift+F12.");
  }

  renderLoading(word?: string): void {
    this.currentWord = word ?? "";
    this.currentRows = [];
    this.currentBlueprints = [];
    this.renderNotice(null);
    this.filter = "all";
    this.filters.replaceChildren();
    if (word) {
      this.loadingText.replaceChildren(
        document.createTextNode("Searching for "),
      );
      const wordEl = document.createElement("b");
      wordEl.className = "devmode-references-word";
      wordEl.textContent = word;
      this.loadingText.append(wordEl, document.createTextNode("…"));
    } else {
      this.loadingText.replaceChildren(
        document.createTextNode("Searching…"),
      );
    }
    this.status.textContent = "";
    this.list.replaceChildren();
    this.status.hidden = true;
    this.list.hidden = true;
    this.loading.hidden = false;
  }

  renderEmpty(message = "No usages found.", notice: string | null = null): void {
    this.currentRows = [];
    this.currentBlueprints = [];
    this.renderNotice(notice);
    this.status.textContent = message;
    this.filters.replaceChildren();
    this.list.replaceChildren();
    this.loading.hidden = true;
    this.status.hidden = false;
    this.list.hidden = false;
  }

  renderResults(
    word: string,
    rows: readonly FindUsageRow[],
    options?: {
      truncated?: boolean;
      scannedFiles?: number;
      blueprints?: readonly BlueprintUsageRow[];
      notice?: string | null;
    },
  ): void {
    this.loading.hidden = true;
    this.status.hidden = false;
    this.list.hidden = false;
    this.currentWord = word;
    this.currentRows = rows;
    this.currentBlueprints = options?.blueprints ?? [];
    this.currentMeta = options ?? {};
    this.filter = "all";
    this.renderNotice(options?.notice ?? null);
    this.renderStatusLine();
    this.renderFilterChips();
    this.renderRows();
  }

  appendBlueprints(rows: readonly BlueprintUsageRow[], notice: string | null): void {
    this.currentBlueprints = rows;
    this.renderNotice(notice);
    this.renderStatusLine();
    this.renderFilterChips();
    this.renderRows();
  }

  renderNotice(message: string | null): void {
    this.notice.textContent = message ?? "";
    this.notice.hidden = !message;
  }

  private totalCount(): number {
    return this.currentRows.length + this.currentBlueprints.length;
  }

  private shownCount(): number {
    return this.filteredRows().length + this.filteredBlueprints().length;
  }

  private renderStatusLine(): void {
    const total = this.totalCount();
    const suffix = this.currentMeta.truncated ? " (first results shown)" : "";
    const wordEl = document.createElement("b");
    wordEl.className = "devmode-references-word";
    wordEl.textContent = this.currentWord;
    const scope =
      this.filter === "all"
        ? `${total} usage${total === 1 ? "" : "s"} of `
        : `${this.shownCount()} of ${total} usages of `;
    const files = this.currentMeta.scannedFiles ? ` in ${this.currentMeta.scannedFiles} files` : "";
    const assets = new Set(this.currentBlueprints.map((row) => row.assetPath)).size;
    const blueprints = assets ? `${files ? " and" : " in"} ${assets} Blueprint${assets === 1 ? "" : "s"}` : "";
    this.status.replaceChildren(
      document.createTextNode(scope),
      wordEl,
      document.createTextNode(`${files}${blueprints}${suffix}`),
    );
  }

  private filteredRows(): FindUsageRow[] {
    if (this.filter === "all") return [...this.currentRows];
    if (this.filter === "blueprint") return [];
    return this.currentRows.filter((row) => row.kind === this.filter);
  }

  private filteredBlueprints(): BlueprintUsageRow[] {
    return this.filter === "all" || this.filter === "blueprint" ? [...this.currentBlueprints] : [];
  }

  private renderFilterChips(): void {
    this.filters.replaceChildren();
    const counts = new Map<FindUsageRowKind, number>();
    for (const row of this.currentRows) {
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    const chips: Array<{ id: UsageFilter; label: string; count: number }> = [
      { id: "all", label: "all", count: this.totalCount() },
      ...FILTER_KINDS.filter((kind) => counts.has(kind)).map((kind) => ({
        id: kind as UsageFilter,
        label: kind,
        count: counts.get(kind)!,
      })),
      ...(this.currentBlueprints.length
        ? [{ id: "blueprint" as UsageFilter, label: "blueprint", count: this.currentBlueprints.length }]
        : []),
    ];
    if (chips.length <= 2) return;
    for (const chip of chips) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "devmode-references-chip";
      button.dataset.filter = chip.id;
      if (this.filter === chip.id) button.classList.add("is-active");
      button.textContent = `${chip.label} · ${chip.count}`;
      button.addEventListener("click", () => {
        if (this.filter === chip.id) return;
        this.filter = chip.id;
        this.renderFilterChips();
        this.renderStatusLine();
        this.renderRows();
      });
      this.filters.append(button);
    }
  }

  private renderRows(): void {
    const word = this.currentWord;
    const rows = this.filteredRows();
    const blueprints = this.filteredBlueprints();
    this.list.replaceChildren();
    if (rows.length === 0 && blueprints.length === 0) {
      const note = document.createElement("div");
      note.className = "devmode-references-empty";
      note.textContent = `No ${this.filter} usages.`;
      this.list.append(note);
      return;
    }
    const groups = new Map<string, FindUsageRow[]>();
    for (const row of rows) {
      const group = groups.get(row.path);
      if (group) group.push(row);
      else groups.set(row.path, [row]);
    }
    for (const [path, items] of groups) {
      const group = document.createElement("section");
      group.className = "devmode-references-group";
      const heading = document.createElement("div");
      heading.className = "devmode-references-file";
      heading.title = path;
      const name = document.createElement("span");
      name.className = "devmode-references-filename";
      name.textContent = basename(path);
      const dir = document.createElement("span");
      dir.className = "devmode-references-dir";
      dir.textContent = dirname(path);
      const count = document.createElement("span");
      count.className = "devmode-references-count";
      count.textContent = String(items.length);
      heading.append(fileIconFor(path), name, dir, count);
      group.append(heading);
      for (const row of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "devmode-references-row";
        button.title = `Line ${row.line}:${row.column} · ${row.kind}`;
        const location = document.createElement("span");
        location.className = "devmode-references-line";
        location.textContent = `Line ${row.line}`;
        const code = document.createElement("code");
        code.className = "devmode-references-code";
        appendLineText(code, row.lineText, row.column, word);
        button.append(location, code);
        if (row.kind !== "read") {
          const kind = document.createElement("span");
          kind.className = `devmode-references-kindbadge is-${row.kind}`;
          kind.textContent = row.kind;
          button.append(kind);
        }
        button.addEventListener("click", () => this.onOpen?.(row));
        group.append(button);
      }
      this.list.append(group);
    }
    this.renderBlueprintGroups(blueprints);
  }

  private renderBlueprintGroups(rows: readonly BlueprintUsageRow[]): void {
    const groups = new Map<string, BlueprintUsageRow[]>();
    for (const row of rows) {
      const group = groups.get(row.assetPath);
      if (group) group.push(row);
      else groups.set(row.assetPath, [row]);
    }
    for (const [assetPath, items] of groups) {
      const group = document.createElement("section");
      group.className = "devmode-references-group is-blueprint";
      const heading = document.createElement("div");
      heading.className = "devmode-references-file";
      heading.title = assetPath;
      const name = document.createElement("span");
      name.className = "devmode-references-filename";
      name.textContent = assetName(assetPath);
      const dir = document.createElement("span");
      dir.className = "devmode-references-dir";
      dir.textContent = assetDir(assetPath);
      const count = document.createElement("span");
      count.className = "devmode-references-count";
      count.textContent = String(items.length);
      heading.append(createLucideIcon(Workflow, { size: 12, strokeWidth: 2 }), name, dir, count);
      group.append(heading);
      for (const row of items) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "devmode-references-row is-blueprint";
        const label = BLUEPRINT_KIND_LABELS[row.kind];
        button.title = `Click to select in Unreal Editor · double-click to open · ${label}${row.nodeClass ? ` · ${row.nodeClass}` : ""}`;
        const location = document.createElement("span");
        location.className = "devmode-references-line";
        location.textContent = "Blueprint";
        const code = document.createElement("code");
        code.className = "devmode-references-code";
        code.textContent = blueprintRowText(row);
        const kind = document.createElement("span");
        kind.className = "devmode-references-kindbadge is-blueprint";
        kind.textContent = label;
        button.append(location, code, kind);
        button.addEventListener("click", () => this.onSelectBlueprint?.(row));
        button.addEventListener("dblclick", () => this.onOpenBlueprint?.(row));
        group.append(button);
      }
      this.list.append(group);
    }
  }
}
