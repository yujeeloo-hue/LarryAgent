import { createLucideIcon, FileText, Braces, SquareFunction, Search, X } from "../ui/originalIcons.js";
import { baseNameOf } from "./slnPaths.js";
import { QuickOpenSearchClient } from "./QuickOpenSearchClient.js";
import { rankSymbols, type RankSymbol } from "./quickOpenRank.js";
import { scanQuickOpenSymbols } from "./documentSymbols.js";
import { clangdWorkspaceSymbols } from "./clangdFeatures.js";

export { fuzzyMatch } from "./quickOpenRank.js";

export type QuickOpenEntry =
  | { kind: "file"; path: string; rel: string }
  | {
      kind: "symbol";
      name: string;
      path: string;
      rel: string;
      line: number;
      symbolKind: string;
      container?: string;
    };

export function quickOpenEntryKey(entry: QuickOpenEntry): string {
  return entry.kind === "file" ? `file|${entry.path}` : `symbol|${entry.name}|${entry.path}|${entry.line}`;
}

export function reselectQuickOpenIndex(
  pinnedKey: string | null,
  results: readonly QuickOpenEntry[],
  previousIndex: number,
): number {
  if (results.length === 0) return 0;
  if (pinnedKey !== null) {
    const index = results.findIndex((entry) => quickOpenEntryKey(entry) === pinnedKey);
    if (index >= 0) return index;
  }
  return Math.min(Math.max(0, previousIndex), results.length - 1);
}

export type QuickOpenOptions = {
  getRecentFiles?: () => string[];
  openFile: (path: string, line?: number) => void;
  getWorkspaceRoot: () => string | null;
};

type SearchCategory = "All" | "Files" | "Types" | "Symbols";
const TYPE_KINDS = new Set(["class", "struct", "interface", "enum", "type", "typealias", "record", "delegate", "trait"]);
const isType = (entry: QuickOpenEntry): boolean => entry.kind === "symbol" && TYPE_KINDS.has(entry.symbolKind.toLowerCase());
const normalizedPath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
const withinRoot = (path: string, root: string): boolean => {
  const p = normalizedPath(path).toLowerCase(), r = normalizedPath(root).toLowerCase();
  return p === r || p.startsWith(`${r}/`);
};

const SEARCH_DEBOUNCE_MS = 150;
const MAX_FILE_ROWS = 50;
const MAX_SYMBOL_ROWS = 30;
const FILE_CACHE_MAX = 60_000;
const FILE_CACHE_DEADLINE_MS = 15_000;

const ENGINE_INDEX_MAX = 200_000;
const ENGINE_INDEX_DEADLINE_MS = 0;

const ENGINE_QUERY_PREFIX = "~engine";

const STREAM_REFRESH_MS = 400;


const SYMBOL_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "cs", "c", "cpp", "cc", "cxx", "hpp", "hh", "h", "hxx",
  "py", "rs", "go", "java", "kt", "swift", "php", "rb",
]);

type ScanFile = { path: string; rel: string; ext: string };

function relPathWithin(root: string, path: string): string {
  const norm = path.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (norm.toLowerCase().startsWith(rootNorm.toLowerCase())) {
    return norm.slice(rootNorm.length);
  }
  return baseNameOf(norm);
}

type SymbolIndex = {
  entries: Array<{
    name: string;
    path: string;
    rel: string;
    line: number;
    symbolKind: string;
    container?: string;
  }>;
  incomplete: boolean;
  scannedFiles: number;
};

const SYMBOL_SCAN_BUDGET_FILES = 2500;
const SYMBOL_SCAN_BUDGET_MATCHES = 25_000;
const SYMBOL_SCAN_DEADLINE_MS = 3000;
const SYMBOL_SCAN_CHUNK = 150;
const SYMBOL_SCAN_MAX_BYTES = 512_000;

let quickOpenId = 0;

export class QuickOpenController {
  private readonly root: HTMLElement;
  private readonly inputRow: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly metaNoteEl: HTMLElement;
  private readonly categoryButtons = new Map<SearchCategory, HTMLButtonElement>();
  private readonly engineCheckbox: HTMLInputElement;
  private readonly engineScope: HTMLLabelElement;
  private category: SearchCategory = "All";
  private includeEngine = true;
  private scopeRoot: string | null = null;
  private showingRecent = false;
  private matchQuery = "";
  private readonly recent = new Map<string, string[]>();
  private readonly outsideClick = (event: PointerEvent): void => {
    if (this.visible && !this.root.contains(event.target as Node)) this.close();
  };

  private visible = false;
  private query = "";
  private results: QuickOpenEntry[] = [];
  private selected = 0;
  private resultsKey: string | null = null;
  private pinnedKey: string | null = null;
  private lastPointer = { x: Number.NaN, y: Number.NaN };
  private debounceTimer: number | null = null;
  private searchGen = 0;
  private readonly search = new QuickOpenSearchClient();
  private fileCacheKey: string | null = null;
  private fileCache: Array<{ path: string; rel: string }> = [];
  private fileCacheTruncated = false;
  private engineState: "idle" | "loading" | "done" = "idle";
  private engineCount = 0;
  private engineTruncated = false;
  private indexRequestId = 0;
  private unsubscribeChunk: (() => void) | null = null;
  private streamRefreshTimer: number | null = null;
  private lastStreamRefresh = 0;
  private symbolIndexKey: string | null = null;
  private symbolIndex: SymbolIndex | null = null;
  private symbolScanCursor = 0;
  private symbolFiles: ScanFile[] | null = null;
  private symbolTimer: number | null = null;
  private engineOnly = false;

  constructor(private readonly options: QuickOpenOptions) {
    this.root = document.createElement("div");
    this.root.className = "devmode-quickopen";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Search Everywhere");
    this.root.hidden = true;

    const header = document.createElement("div");
    header.className = "devmode-quickopen-header";
    const tabs = document.createElement("div");
    tabs.className = "devmode-quickopen-tabs";
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Search category");
    for (const category of ["All", "Files", "Types", "Symbols"] as const) {
      const button = document.createElement("button");
      button.type = "button"; button.textContent = category;
      button.dataset.category = category;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(category === this.category));
      button.addEventListener("click", () => {
        this.category = category;
        this.categoryButtons.forEach((tab, kind) => tab.setAttribute("aria-selected", String(kind === category)));
        this.selected = 0; this.scheduleSearch(); this.input.focus();
      });
      button.addEventListener("keydown", event => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        const buttons = [...this.categoryButtons.values()];
        const next = buttons[(buttons.indexOf(button) + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length]!;
        next.click(); next.focus();
      });
      this.categoryButtons.set(category, button); tabs.append(button);
    }
    this.engineScope = document.createElement("label");
    this.engineScope.className = "devmode-quickopen-scope";
    this.engineScope.hidden = true;
    this.engineCheckbox = document.createElement("input");
    this.engineCheckbox.type = "checkbox"; this.engineCheckbox.checked = true;
    this.engineCheckbox.addEventListener("change", () => {
      this.includeEngine = this.engineCheckbox.checked;
      if (!this.includeEngine && this.query.toLowerCase().startsWith(ENGINE_QUERY_PREFIX)) {
        this.query = this.query.slice(ENGINE_QUERY_PREFIX.length).trim(); this.input.value = this.query;
      }
      this.selected = 0; this.scheduleSearch(); this.input.focus();
    });
    this.engineScope.append(this.engineCheckbox, document.createTextNode("Include Engine"));
    header.append(tabs, this.engineScope);

    this.inputRow = document.createElement("div");
    this.inputRow.className = "devmode-quickopen-row";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "devmode-quickopen-input";
    this.input.placeholder = "Search everywhere";
    this.input.setAttribute("aria-label", "Search everywhere");
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.input.spellcheck = false;
    this.input.autocomplete = "off";
    this.input.addEventListener("input", () => {
      this.query = this.input.value;
      this.scheduleSearch();
    });
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        this.moveSelection(1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        this.moveSelection(-1);
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.openSelected();
      } else if (event.key === "Escape") {
        event.preventDefault();
        this.close();
      }
    });
    const clear = document.createElement("button");
    clear.type = "button"; clear.className = "devmode-quickopen-clear";
    clear.setAttribute("aria-label", "Clear search"); clear.append(createLucideIcon(X, { size: 14 }));
    clear.addEventListener("click", () => { this.query = ""; this.input.value = ""; this.scheduleSearch(); this.input.focus(); });
    this.inputRow.append(createLucideIcon(Search, { size: 14 }), this.input, clear);

    this.listEl = document.createElement("div");
    this.listEl.className = "devmode-quickopen-list";
    this.listEl.setAttribute("role", "listbox");
    this.listEl.id = `devmode-quickopen-results-${++quickOpenId}`;
    this.listEl.setAttribute("aria-label", "Search results");
    this.input.setAttribute("aria-controls", this.listEl.id);

    const meta = document.createElement("div");
    meta.className = "devmode-quickopen-meta";
    this.countEl = document.createElement("span");
    this.countEl.className = "devmode-quickopen-count";
    this.countEl.setAttribute("role", "status");
    this.metaNoteEl = document.createElement("span");
    this.metaNoteEl.className = "devmode-quickopen-note";
    const hints = document.createElement("div"); hints.className = "devmode-quickopen-keys";
    for (const [keys, text] of [[["Up", "Dn"], "Navigate"], [["Enter"], "Open"], [["Esc"], "Close"]] as const) {
      const hint = document.createElement("span");
      for (const key of keys) { const kbd = document.createElement("kbd"); kbd.textContent = key; hint.append(kbd); }
      hint.append(document.createTextNode(text)); hints.append(hint);
    }
    meta.append(hints, this.countEl, this.metaNoteEl);

    this.root.append(header, this.inputRow, this.listEl, meta);
    this.root.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); this.close(); } });

    window.addEventListener("pointerdown", this.outsideClick);
  }

  mount(host: HTMLElement): void {
    host.append(this.root);
  }

  destroy(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.symbolTimer !== null) window.clearTimeout(this.symbolTimer);
    this.symbolTimer = null;
    if (this.streamRefreshTimer !== null) {
      window.clearTimeout(this.streamRefreshTimer);
    }
    this.streamRefreshTimer = null;
    this.searchGen++;
    this.indexRequestId++;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = null;
    void window.jellybot?.cancelDevModeFileIndex?.();
    this.search.dispose();
    window.removeEventListener("pointerdown", this.outsideClick);
    this.root.remove();
  }

  get isOpen(): boolean {
    return this.visible;
  }

  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  filesByBasename(base: string): Array<{ path: string; rel: string }> {
    return this.search.filesByBasename(base);
  }

  open(seedQuery?: string): void {
    const root = this.options.getWorkspaceRoot();
    if (!root) return;
    const seed = seedQuery?.trim() ?? "";
    this.visible = true;
    this.root.hidden = false;
    this.query = seed;
    this.input.value = seed;
    this.input.setAttribute("aria-expanded", "true");
    if (seed) { this.category = "All"; this.categoryButtons.forEach((tab, kind) => tab.setAttribute("aria-selected", String(kind === "All"))); }
    if (this.scopeRoot !== root) {
      this.scopeRoot = root; this.engineScope.hidden = true;
      void window.jellybot?.getDevModeEngineRoot?.(root).then(engineRoot => {
        if (this.options.getWorkspaceRoot() === root) this.engineScope.hidden = !engineRoot;
      }).catch(() => {});
    }
    this.selected = 0;
    this.results = [];
    this.resultsKey = null;
    this.pinnedKey = null;
    this.listEl.replaceChildren();
    this.showHint(
      seed ? `Searching "${seed}" …` : "Type to search files and symbols.",
    );
    this.renderMeta(0, this.symbolIndex?.incomplete ?? false);
    this.input.focus();
    if (typeof this.input.setSelectionRange === "function") {
      this.input.setSelectionRange(seed.length, seed.length);
    }
    this.scheduleSearch();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.input.setAttribute("aria-expanded", "false");
    this.searchGen++;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }


  private scheduleSearch(): void {
    this.searchGen++;
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  private scheduleStreamRefresh(): void {
    if (!this.visible) return;
    if (this.streamRefreshTimer !== null) return;
    const wait = Math.max(
      0,
      STREAM_REFRESH_MS - (Date.now() - this.lastStreamRefresh),
    );
    this.streamRefreshTimer = window.setTimeout(() => {
      this.streamRefreshTimer = null;
      this.lastStreamRefresh = Date.now();
      void this.runSearch();
    }, wait);
  }

  private async runSearch(): Promise<void> {
    if (!this.visible) return;
    const gen = ++this.searchGen;
    const query = this.query.trim();
    const root = this.options.getWorkspaceRoot();
    if (!root) return;

    this.engineOnly = query.toLowerCase().startsWith(ENGINE_QUERY_PREFIX);
    const q = this.engineOnly
      ? query.slice(ENGINE_QUERY_PREFIX.length).trim()
      : query;
    this.matchQuery = q;
    this.showingRecent = !q;
    if (this.engineOnly) { this.includeEngine = true; this.engineCheckbox.checked = true; }
    const searchKey = `${this.category}|${this.engineOnly}|${this.includeEngine}|${q}`;

    if (!q) {
      this.results = (this.category === "All" || this.category === "Files") ? this.recentFiles(root) : [];
      this.showResults(searchKey);
      if (!this.results.length) this.showHint(this.category === "All" || this.category === "Files" ? "No recent files" : `Type to search ${this.category.toLowerCase()}.`);
      this.renderMeta(this.results.length, false);
      return;
    }

    await this.ensureFileCache(root, gen);
    if (gen !== this.searchGen) return;

    const ranked = await this.search.query(q, MAX_FILE_ROWS, this.engineOnly, this.includeEngine);
    if (gen !== this.searchGen) return;
    const fileHits = ranked.files;
    if (this.category === "Files") {
      this.results = fileHits.map(file => ({ kind: "file", ...file }));
      this.showResults(searchKey); this.renderMeta(this.results.length, false); return;
    }

    const semanticPromise = clangdWorkspaceSymbols(root, q).catch(
      () => [] as Awaited<ReturnType<typeof clangdWorkspaceSymbols>>,
    );

    const symbols = await this.ensureSymbolIndex(root, gen);
    if (gen !== this.searchGen) return;
    const semantic = await semanticPromise;
    if (gen !== this.searchGen) return;

    const semanticEntries: RankSymbol[] = semantic.map((s) => ({
      name: s.name,
      path: s.path,
      rel: relPathWithin(root, s.path),
      line: s.line,
      symbolKind: s.symbolKind,
      ...(s.container ? { container: s.container } : {}),
    }));
    const seen = new Set(
      semanticEntries.map((s) => `${s.name}|${s.path}|${s.line}`),
    );
    const textEntries = (symbols?.entries ?? []).filter(
      (e) => !seen.has(`${e.name}|${e.path}|${e.line}`),
    );

    const symbolHits = rankSymbols(
      [...semanticEntries, ...textEntries].filter(entry => {
        const external = !withinRoot(entry.path, root);
        if (this.engineOnly ? !external : !this.includeEngine && external) return false;
        const type = TYPE_KINDS.has(entry.symbolKind.toLowerCase());
        return this.category === "Types" ? type : this.category === "Symbols" ? !type : true;
      }),
      q,
      MAX_SYMBOL_ROWS,
    );

    const entries = symbolHits.map(s => ({ kind: "symbol", ...s }) as QuickOpenEntry);
    this.results = [...(this.category === "All" ? fileHits.map(f => ({ kind: "file", ...f }) as QuickOpenEntry) : []), ...entries.filter(isType), ...entries.filter(entry => !isType(entry))];
    this.showResults(searchKey);
    this.renderMeta(this.results.length, Boolean(symbols?.incomplete));
  }

  private showResults(searchKey: string): void {
    const refresh = searchKey === this.resultsKey;
    this.resultsKey = searchKey;
    if (!refresh) this.pinnedKey = null;
    const scrollTop = refresh ? this.listEl.scrollTop : 0;
    this.selected = refresh ? reselectQuickOpenIndex(this.pinnedKey, this.results, this.selected) : 0;
    this.renderResults();
    this.listEl.scrollTop = scrollTop;
    if (refresh && this.pinnedKey !== null) {
      this.listEl
        .querySelector<HTMLElement>(`.devmode-quickopen-item[data-idx="${this.selected}"]`)
        ?.scrollIntoView?.({ block: "nearest" });
    }
  }

  private pinSelection(): void {
    const entry = this.results[this.selected];
    this.pinnedKey = entry ? quickOpenEntryKey(entry) : null;
  }

  private async ensureFileCache(
    root: string,
    gen: number,
  ): Promise<Array<{ path: string; rel: string }>> {
    if (this.fileCacheKey === root) {
      if (this.engineState === "idle") this.startEngineIndex(root);
      return this.fileCache;
    }
    const bridge = window.jellybot;
    if (!bridge?.searchDevModeFiles) return [];
    this.resetIndex();
    const res = await bridge.searchDevModeFiles(root, "", {
      listAll: true,
      codeOnly: true,
      limit: FILE_CACHE_MAX,
      deadlineMs: FILE_CACHE_DEADLINE_MS,
    });
    if (gen !== this.searchGen) return this.fileCache;
    if (!res.ok) return [];
    this.fileCacheKey = root;
    this.fileCache = res.files;
    this.fileCacheTruncated = res.truncated;
    this.search.setTier("project", res.files);
    this.startEngineIndex(root);
    return this.fileCache;
  }

  private resetIndex(): void {
    this.search.reset();
    this.engineState = "idle";
    this.engineCount = 0;
    this.engineTruncated = false;
    this.indexRequestId++;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = null;
    void window.jellybot?.cancelDevModeFileIndex?.();
  }

  private startEngineIndex(root: string): void {
    if (this.engineState !== "idle") return;
    const bridge = window.jellybot;
    if (!bridge?.startDevModeFileIndex || !bridge.onDevModeIndexChunk) return;
    this.engineState = "loading";
    const requestId = ++this.indexRequestId;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = bridge.onDevModeIndexChunk((chunk) => {
      if (chunk.requestId !== this.indexRequestId) return;
      if (chunk.files.length > 0) {
        this.engineCount += chunk.files.length;
        this.search.appendTier("engine", chunk.files);
      }
      if (chunk.done) {
        this.engineState = "done";
        this.engineTruncated = chunk.truncated;
        this.unsubscribeChunk?.();
        this.unsubscribeChunk = null;
      }
      this.scheduleStreamRefresh();
    });
    void bridge
      .startDevModeFileIndex(root, requestId, {
        codeOnly: true,
        engineOnly: true,
        limit: ENGINE_INDEX_MAX,
        deadlineMs: ENGINE_INDEX_DEADLINE_MS,
      })
      .then((result) => {
        if (!result.ok && requestId === this.indexRequestId) {
          this.engineState = "done";
        }
      })
      .catch(() => {
        if (requestId === this.indexRequestId) this.engineState = "done";
      });
  }

  private async ensureSymbolIndex(
    root: string,
    gen: number,
  ): Promise<SymbolIndex | null> {
    const indexKey = root;
    if (this.symbolIndexKey === indexKey && this.symbolIndex) {
      return this.symbolIndex;
    }
    const bridge = window.jellybot;
    if (!bridge?.searchDevModeFiles) return null;
    if (this.symbolIndexKey !== indexKey) {
      if (this.symbolTimer !== null) {
        window.clearTimeout(this.symbolTimer);
        this.symbolTimer = null;
      }
      this.symbolIndexKey = indexKey;
      this.symbolIndex = { entries: [], incomplete: true, scannedFiles: 0 };
      this.symbolFiles = null;
      this.symbolScanCursor = 0;
    }
    void this.runSymbolScan(root, gen);
    return this.symbolIndex;
  }

  private async runSymbolScan(root: string, gen: number): Promise<void> {
    const idx = this.symbolIndex;
    const bridge = window.jellybot;
    if (!idx || !bridge?.readTextFile) return;
    if (this.symbolTimer !== null) return;
    if (this.symbolFiles === null) {
      const files = await this.ensureFileCache(root, gen);
      if (gen !== this.searchGen) return;
      this.symbolFiles = files
        .map((f) => {
          const dot = f.rel.lastIndexOf(".");
          const ext = dot === -1 ? "" : f.rel.slice(dot + 1).toLowerCase();
          return { path: f.path, rel: f.rel, ext };
        })
        .filter((f) => SYMBOL_EXTENSIONS.has(f.ext))
        .slice(0, SYMBOL_SCAN_BUDGET_FILES);
    }
    let deadline = Date.now() + SYMBOL_SCAN_DEADLINE_MS;
    const scan = async (): Promise<void> => {
      const list = this.symbolFiles!;
      const start = this.symbolScanCursor;
      const end = Math.min(start + SYMBOL_SCAN_CHUNK, list.length);
      for (let i = start; i < end; i++) {
        const file = list[i]!;
        if (idx.entries.length >= SYMBOL_SCAN_BUDGET_MATCHES) break;
        if (Date.now() > deadline) break;
        let text: string;
        try {
          const res = await bridge.readTextFile!(file.path);
          if (!res.ok) continue;
          text = res.content;
        } catch {
          continue;
        }
        if (text.length > SYMBOL_SCAN_MAX_BYTES) continue;
        const hits = scanQuickOpenSymbols(text, file.path);
        for (const hit of hits) {
          const entry: SymbolIndex["entries"][number] = {
            name: hit.name,
            path: file.path,
            rel: file.rel,
            line: hit.line,
            symbolKind: hit.kind,
          };
          if (hit.container) entry.container = hit.container;
          idx.entries.push(entry);
          if (idx.entries.length >= SYMBOL_SCAN_BUDGET_MATCHES) break;
        }
      }
      this.symbolScanCursor = end;
      idx.scannedFiles = end;
      const done =
        this.symbolScanCursor >= list.length ||
        idx.entries.length >= SYMBOL_SCAN_BUDGET_MATCHES;
      idx.incomplete = !done;
      if (done) {
        if (this.symbolTimer !== null) window.clearTimeout(this.symbolTimer);
        this.symbolTimer = null;
      }
      if (this.visible && gen === this.searchGen) {
        void this.runSearch();
      }
    };
    const continueScan = (): void => {
      if (gen !== this.searchGen || !this.symbolIndex?.incomplete) {
        this.symbolTimer = null;
        return;
      }
      this.symbolTimer = window.setTimeout(() => {
        void (async () => {
          if (gen !== this.searchGen || !this.symbolIndex) {
            this.symbolTimer = null;
            return;
          }
          deadline = Date.now() + SYMBOL_SCAN_DEADLINE_MS;
          try {
            await scan();
          } finally {
            if (this.symbolIndex?.incomplete && gen === this.searchGen) continueScan();
            else this.symbolTimer = null;
          }
        })();
      }, 0);
    };
    if (idx.incomplete) {
      await scan();
      if (idx.incomplete && this.symbolTimer === null) continueScan();
    }
  }


  private recentFiles(root: string): QuickOpenEntry[] {
    if (!this.recent.has(root)) {
      let paths: string[] = [];
      try {
        const saved: unknown = JSON.parse(window.localStorage.getItem(`jellybot.quickOpen.recent:${root}`) ?? "[]");
        if (Array.isArray(saved)) paths = saved.filter((path): path is string => typeof path === "string").slice(0, 20);
      } catch {  }
      this.recent.set(root, paths);
    }
    return [...new Set([...(this.options.getRecentFiles?.() ?? []), ...this.recent.get(root)!])]
      .filter(path => this.engineOnly ? !withinRoot(path, root) : this.includeEngine || withinRoot(path, root)).slice(0, 12)
      .map(path => ({ kind: "file", path, rel: relPathWithin(root, path) }));
  }

  private highlight(element: HTMLElement, text: string): void {
    const query = this.matchQuery.toLowerCase();
    const lower = text.toLowerCase();
    const contiguous = query ? lower.indexOf(query) : -1;
    const positions = new Set<number>();
    if (contiguous >= 0) {
      for (let i = contiguous; i < contiguous + query.length; i++) positions.add(i);
    } else if (query) {
      let cursor = 0;
      for (const char of query) {
        const index = lower.indexOf(char, cursor);
        if (index < 0) { positions.clear(); break; }
        positions.add(index); cursor = index + 1;
      }
    }
    let start = 0;
    while (start < text.length) {
      const matched = positions.has(start);
      let end = start + 1;
      while (end < text.length && positions.has(end) === matched) end++;
      if (matched) { const mark = document.createElement("mark"); mark.textContent = text.slice(start, end); element.append(mark); }
      else element.append(document.createTextNode(text.slice(start, end)));
      start = end;
    }
  }

  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    const next = (this.selected + delta + this.results.length) % this.results.length;
    this.selected = next;
    this.pinSelection();
    this.updateSelectionClasses();
    this.renderMeta(this.results.length, this.symbolIndex?.incomplete ?? false);
    const row = this.listEl.querySelector<HTMLElement>(
      `.devmode-quickopen-item[data-idx="${this.selected}"]`,
    );
    row?.scrollIntoView?.({ block: "nearest" });
  }

  private openSelected(): void {
    const entry = this.results[this.selected];
    if (!entry) return;
    const root = this.options.getWorkspaceRoot();
    if (root) {
      const paths = [entry.path, ...(this.recent.get(root) ?? []).filter(path => path !== entry.path)].slice(0, 20);
      this.recent.set(root, paths);
      try { window.localStorage.setItem(`jellybot.quickOpen.recent:${root}`, JSON.stringify(paths)); } catch {  }
    }
    this.close();
    if (entry.kind === "file") {
      this.options.openFile(entry.path);
    } else {
      this.options.openFile(entry.path, entry.line);
    }
  }


  private renderResults(): void {
    this.listEl.replaceChildren();
    this.input.removeAttribute("aria-activedescendant");
    if (this.results.length === 0) {
      this.showHint(this.symbolIndex?.incomplete && this.category !== "Files" ? "Searching…" : "No results found");
      return;
    }
    let lastKind: string | null = null;
    this.results.forEach((entry, i) => {
      const group = this.showingRecent ? "Recent Files" : entry.kind === "file" ? "Files" : isType(entry) ? "Types" : "Symbols";
      if (group !== lastKind && (this.category === "All" || this.showingRecent)) {
        const label = document.createElement("div");
        label.className = "devmode-quickopen-label";
        label.textContent = group;
        this.listEl.append(label);
        lastKind = group;
      }
      const row = document.createElement("div");
      row.className = "devmode-quickopen-item";
      row.setAttribute("role", "option");
      row.setAttribute("data-kind", entry.kind);
      row.setAttribute("data-idx", String(i));
      row.id = `${this.listEl.id}-${i}`;
      row.setAttribute("aria-selected", String(i === this.selected));
      row.title = `${entry.path}${entry.kind === "symbol" ? `:${entry.line}` : ""}`;
      row.classList.toggle("is-sel", i === this.selected);
      const icon = document.createElement("span");
      icon.className = "devmode-quickopen-icon";
      icon.append(
        createLucideIcon(
          entry.kind === "file"
            ? FileText
            : isType(entry) ? Braces : SquareFunction,
          { size: 14, strokeWidth: 1.75 },
        ),
      );
      const name = document.createElement("span");
      name.className = "devmode-quickopen-name";
      this.highlight(name, entry.kind === "file" ? baseNameOf(entry.rel) : entry.name);
      const detail = document.createElement("span");
      detail.className = "devmode-quickopen-detail";
      if (entry.kind === "file") {
        const slash = entry.rel.lastIndexOf("/");
        this.highlight(detail, slash === -1 ? "" : entry.rel.slice(0, slash));
      } else {
        const bits: string[] = [];
        if (entry.container) bits.push(entry.container);
        bits.push(`${baseNameOf(entry.rel)}:${entry.line}`);
        this.highlight(detail, bits.join(" · "));
      }
      const project = document.createElement("span");
      project.className = "devmode-quickopen-project";
      const root = this.options.getWorkspaceRoot() ?? "";
      project.textContent = withinRoot(entry.path, root) ? baseNameOf(root) : /(?:^|[\\/])Engine[\\/]/i.test(entry.path) ? "Engine" : "External";
      const content = document.createElement("span"); content.className = "devmode-quickopen-content";
      content.append(name, detail);
      row.append(icon, content, project);
      row.addEventListener("click", () => {
        this.selected = i;
        this.openSelected();
      });
      row.addEventListener("pointermove", (event) => {
        const moved = event.clientX !== this.lastPointer.x || event.clientY !== this.lastPointer.y;
        this.lastPointer = { x: event.clientX, y: event.clientY };
        if (!moved) return;
        if (this.selected !== i) {
          this.selected = i;
          this.pinSelection();
          this.updateSelectionClasses();
        }
      });
      this.listEl.append(row);
    });
    this.updateSelectionClasses();
  }

  private updateSelectionClasses(): void {
    [...this.listEl.querySelectorAll<HTMLElement>(".devmode-quickopen-item")].forEach(
      (el) => {
        el.classList.toggle("is-sel", el.dataset.idx === String(this.selected));
        el.setAttribute("aria-selected", String(el.dataset.idx === String(this.selected)));
        if (el.dataset.idx === String(this.selected)) this.input.setAttribute("aria-activedescendant", el.id);
      },
    );
  }

  private renderMeta(count: number, indexing: boolean): void {
    this.countEl.textContent =
      count > 0 ? `${this.selected + 1} / ${count}` : "0 results";
    this.metaNoteEl.textContent =
      this.includeEngine && this.engineState === "loading"
        ? `Indexing Engine… ${this.engineCount.toLocaleString()} files`
        : this.includeEngine && this.engineTruncated
          ? "Engine index incomplete (budget reached)"
          : this.fileCacheTruncated
            ? "Project index incomplete (budget reached)"
            : indexing
              ? "Indexing symbols…"
              : "";
  }

  private showHint(text: string): void {
    const hint = this.engineOnly
      ? `${text} · ~engine on (Engine sources only)`
      : text;
    const row = document.createElement("div");
    row.className = "devmode-quickopen-hint";
    this.input.removeAttribute("aria-activedescendant");
    row.textContent = hint;
    this.listEl.replaceChildren(row);
  }
}
