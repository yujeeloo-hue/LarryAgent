import { CodeXml, FileText, createLucideIcon } from "../ui/originalIcons.js";

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

/** Directory part with a trailing slash — "" when the path is bare. */
function dirname(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const cut = normalized.lastIndexOf("/");
  return cut === -1 ? "" : normalized.slice(0, cut + 1);
}

/** Code files get the code glyph; everything else the generic file one. */
const CODE_EXT = /\.(h|hpp|hxx|c|cc|cpp|cxx|inl|ipp|tpp|cs|inc|ts|tsx|js|mjs)$/i;

function fileIconFor(path: string): SVGElement {
  return createLucideIcon(CODE_EXT.test(path) ? CodeXml : FileText, {
    size: 12,
    strokeWidth: 2,
  });
}

/**
 * Line text with the matched token emphasized. The hit position comes from
 * the row's column; if the text moved (stale index), fall back to the first
 * occurrence, and if the word is gone entirely, plain text is fine.
 */
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

export type FindUsageRowKind = FindUsageRow["kind"];
type UsageFilter = "all" | FindUsageRowKind;

/** Chip order — read first (the common case), call/address last. */
const FILTER_KINDS: FindUsageRowKind[] = ["read", "write", "call", "address"];

export class FindUsagesView {
  readonly root: HTMLElement;
  private readonly status: HTMLDivElement;
  private readonly filters: HTMLDivElement;
  private readonly list: HTMLDivElement;
  private readonly loading: HTMLDivElement;
  private readonly loadingText: HTMLSpanElement;
  onOpen: ((row: FindUsageRow) => void) | null = null;
  /** Last rendered result set — filter chips re-render from these. */
  private currentWord = "";
  private currentRows: readonly FindUsageRow[] = [];
  private currentMeta: { truncated?: boolean; scannedFiles?: number } = {};
  private filter: UsageFilter = "all";

  constructor() {
    this.root = document.createElement("div");
    this.root.className = "devmode-references";
    this.status = document.createElement("div");
    this.status.className = "devmode-references-status";
    this.filters = document.createElement("div");
    this.filters.className = "devmode-references-filters";
    this.list = document.createElement("div");
    this.list.className = "devmode-references-list";
    this.loading = document.createElement("div");
    this.loading.className = "devmode-references-loading";
    const spinner = document.createElement("span");
    spinner.className = "devmode-references-spinner";
    spinner.setAttribute("aria-hidden", "true");
    this.loadingText = document.createElement("span");
    this.loading.append(spinner, this.loadingText);
    this.root.append(this.status, this.filters, this.list, this.loading);
    this.renderEmpty("Find Usages from the editor or press Shift+F12.");
  }

  /** Loading state; the word is optional until the target resolves. */
  renderLoading(word?: string): void {
    this.currentWord = word ?? "";
    this.currentRows = [];
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

  renderEmpty(message = "No usages found."): void {
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
    options?: { truncated?: boolean; scannedFiles?: number },
  ): void {
    this.loading.hidden = true;
    this.status.hidden = false;
    this.list.hidden = false;
    this.currentWord = word;
    this.currentRows = rows;
    this.currentMeta = options ?? {};
    this.filter = "all";
    this.renderStatusLine();
    this.renderFilterChips();
    this.renderRows();
  }

  private renderStatusLine(): void {
    const rows = this.currentRows;
    const shown = this.filteredRows();
    const suffix = this.currentMeta.truncated ? " (first results shown)" : "";
    const wordEl = document.createElement("b");
    wordEl.className = "devmode-references-word";
    wordEl.textContent = this.currentWord;
    const scope =
      this.filter === "all"
        ? `${rows.length} usage${rows.length === 1 ? "" : "s"} of `
        : `${shown.length} of ${rows.length} usages of `;
    this.status.replaceChildren(
      document.createTextNode(scope),
      wordEl,
      document.createTextNode(
        `${this.currentMeta.scannedFiles ? ` in ${this.currentMeta.scannedFiles} files` : ""}${suffix}`,
      ),
    );
  }

  private filteredRows(): FindUsageRow[] {
    return this.filter === "all"
      ? [...this.currentRows]
      : this.currentRows.filter((row) => row.kind === this.filter);
  }

  private renderFilterChips(): void {
    this.filters.replaceChildren();
    const counts = new Map<FindUsageRowKind, number>();
    for (const row of this.currentRows) {
      counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    }
    // Only kinds present in the result get a chip; read always qualifies —
    // it is the unlabelled default and hides otherwise-identical rows.
    const chips: Array<{ id: UsageFilter; label: string; count: number }> = [
      { id: "all", label: "all", count: this.currentRows.length },
      ...FILTER_KINDS.filter((kind) => counts.has(kind)).map((kind) => ({
        id: kind as UsageFilter,
        label: kind,
        count: counts.get(kind)!,
      })),
    ];
    if (chips.length <= 2) return; // nothing to filter between
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
    this.list.replaceChildren();
    if (rows.length === 0) {
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
        // With filter chips in play the badges stay useful — but a lone
        // "read" on everything would be noise, so reads stay quiet.
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
  }
}
