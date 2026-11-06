/**
 * Quick Open (⌘T / Ctrl+T) — Dev Mode overlay for files + symbols.
 *
 * Files: main-process recursive filter (`devmode:searchFiles`) — the same
 * ignore rules and budgets as the Solution Outline search box. Results
 * cache per workspace key so repeat opens are instant (the walk is the
 * expensive part).
 *
 * Symbols: a lazy workspace-wide symbol index built on first use. Ext-based
 * candidate filter (ts/tsx/js/jsx/c/cs/cpp/h/hpp/cc/cxx/py/rs/go/java …),
 * streamed scan with caps (files, matches, deadline) so giant workspaces
 * can't stall; leftover work resumes on the next keystroke (visible via
 * the "Indexing…" meta note). Matches: types plus function/method names
 * (TS/JS class members, C++ header declarations, `Class::Method` in .cpp,
 * `def` / `fn` / `function` heads). Fields and access-specifier rows stay
 * off the index.
 *
 * Jump: file rows open a tab; symbol rows open the file, then reveal +
 * briefly highlight the line via the editor's public reveal API.
 */
import { createLucideIcon, FileText, Braces, SquareFunction } from "../ui/originalIcons.js";
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

export type QuickOpenOptions = {
  /** Reveal a file (tab open + optional line highlight). */
  openFile: (path: string, line?: number) => void;
  /** Workspace root for the file walk + symbol scan (null → disabled). */
  getWorkspaceRoot: () => string | null;
};

/** Debounce for the search pass (file filter + index probe). */
const SEARCH_DEBOUNCE_MS = 150;
/** Files section cap before the Symbols group. */
const MAX_FILE_ROWS = 50;
const MAX_SYMBOL_ROWS = 30;
/**
 * Project index: full code+text tree (assets dropped). NF-sized UE projects
 * hold ~22k code files — 20k would silently drop the tail.
 */
const FILE_CACHE_MAX = 60_000;
const FILE_CACHE_DEADLINE_MS = 15_000;

/**
 * Engine index: streamed in as a second, disjoint pass so the palette answers
 * from project files immediately and engine hits fold in as batches land. The
 * tree runs several times the size of a game project, hence the wider budget.
 */
const ENGINE_INDEX_MAX = 200_000;
/**
 * The Engine pass is cancellable, streamed, and never blocks the renderer, so
 * a foreground-style wall-clock deadline only creates a permanently partial
 * index on slower disks. `0` means no time deadline; file/dir caps remain.
 */
const ENGINE_INDEX_DEADLINE_MS = 0;

/** `~engine` narrows results to engine sources (the index loads either way). */
const ENGINE_QUERY_PREFIX = "~engine";

/** Refresh cadence while streamed index batches land. */
const STREAM_REFRESH_MS = 400;

// -------------------------------------------------------------- symbol scan

const SYMBOL_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts",
  "cs", "c", "cpp", "cc", "cxx", "hpp", "hh", "h", "hxx",
  "py", "rs", "go", "java", "kt", "swift", "php", "rb",
]);

type ScanFile = { path: string; rel: string; ext: string };

/** Display path relative to the workspace root (basename when outside). */
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
  /** Scan budget exhausted — more files remain (resume on next keystroke). */
  incomplete: boolean;
  scannedFiles: number;
};

const SYMBOL_SCAN_BUDGET_FILES = 2500;
/** Methods multiply hits vs type-heads-only; keep room for a mid-size tree. */
const SYMBOL_SCAN_BUDGET_MATCHES = 25_000;
const SYMBOL_SCAN_DEADLINE_MS = 3000;
const SYMBOL_SCAN_CHUNK = 150;
/** Files over this size are skipped (UE vcxproj-scale sources). */
const SYMBOL_SCAN_MAX_BYTES = 512_000;

export class QuickOpenController {
  private readonly root: HTMLElement;
  private readonly inputRow: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly listEl: HTMLElement;
  private readonly countEl: HTMLElement;
  private readonly metaNoteEl: HTMLElement;

  private visible = false;
  private query = "";
  private results: QuickOpenEntry[] = [];
  private selected = 0;
  private debounceTimer: number | null = null;
  private searchGen = 0;
  /** Ranking runs here — a worker when the platform allows, else in-thread. */
  private readonly search = new QuickOpenSearchClient();
  /** Workspace key of the loaded index (root path). */
  private fileCacheKey: string | null = null;
  /** Project-tier files, retained as the symbol scanner's candidate list. */
  private fileCache: Array<{ path: string; rel: string }> = [];
  /** Walk hit its budget — the meta note says so (huge trees). */
  private fileCacheTruncated = false;
  /** Engine tier: streamed after the project tier lands. */
  private engineState: "idle" | "loading" | "done" = "idle";
  private engineCount = 0;
  private engineTruncated = false;
  /** Correlates streamed batches with the walk we asked for. */
  private indexRequestId = 0;
  private unsubscribeChunk: (() => void) | null = null;
  private streamRefreshTimer: number | null = null;
  private lastStreamRefresh = 0;
  /** Workspace key of the symbol index (root path). */
  private symbolIndexKey: string | null = null;
  private symbolIndex: SymbolIndex | null = null;
  /** Resume cursor (file index into the walk) while incomplete. */
  private symbolScanCursor = 0;
  private symbolFiles: ScanFile[] | null = null;
  private symbolTimer: number | null = null;
  /** `~engine` prefix active — results narrow to the engine tier. */
  private engineOnly = false;

  constructor(private readonly options: QuickOpenOptions) {
    this.root = document.createElement("div");
    this.root.className = "devmode-quickopen";
    this.root.setAttribute("role", "dialog");
    this.root.setAttribute("aria-label", "Quick Open");
    this.root.hidden = true;

    this.inputRow = document.createElement("div");
    this.inputRow.className = "devmode-quickopen-row";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "devmode-quickopen-input";
    this.input.placeholder = "Search files and symbols by name… (~engine for UE engine)";
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
    this.inputRow.append(this.input);

    this.listEl = document.createElement("div");
    this.listEl.className = "devmode-quickopen-list";
    this.listEl.setAttribute("role", "listbox");

    const meta = document.createElement("div");
    meta.className = "devmode-quickopen-meta";
    this.countEl = document.createElement("span");
    this.countEl.className = "devmode-quickopen-count";
    this.metaNoteEl = document.createElement("span");
    this.metaNoteEl.className = "devmode-quickopen-note";
    meta.append(this.countEl, this.metaNoteEl);

    this.root.append(this.inputRow, this.listEl, meta);

    // Outside pointer-down dismisses (scrim is visual only — clicks pass
    // through to the workbench underneath).
    window.addEventListener("pointerdown", (event) => {
      if (!this.visible) return;
      if (this.root.contains(event.target as Node)) return;
      this.close();
    });
  }

  /** Overlay host — mounted once (DevModeController wires it). */
  mount(host: HTMLElement): void {
    host.append(this.root);
  }

  destroy(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.symbolTimer !== null) window.clearInterval(this.symbolTimer);
    this.symbolTimer = null;
    if (this.streamRefreshTimer !== null) {
      window.clearTimeout(this.streamRefreshTimer);
    }
    this.streamRefreshTimer = null;
    this.searchGen++;
    // Stop the engine walk in main — it can outlive the window by seconds.
    this.indexRequestId++;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = null;
    void window.jellybot?.cancelDevModeFileIndex?.();
    this.search.dispose();
    this.root.remove();
  }

  get isOpen(): boolean {
    return this.visible;
  }

  /** ⌘T / Ctrl+T — toggle (visible → dismiss, like an escape hatch). */
  toggle(): void {
    if (this.visible) this.close();
    else this.open();
  }

  /**
   * Exact-basename lookup over the loaded file index (project + engine
   * tiers). Feeds the tab-toggle counterpart resolver — the index already
   * holds every workspace + engine source file once Quick Open has loaded.
   * Returns [] while the index is cold (Quick Open never opened).
   */
  filesByBasename(base: string): Array<{ path: string; rel: string }> {
    return this.search.filesByBasename(base);
  }

  /** Open fresh — hint shown (VS Code quick-open behavior). Optional seed query (e.g. F12 fallback). */
  open(seedQuery?: string): void {
    const root = this.options.getWorkspaceRoot();
    if (!root) return; // no workspace context — nothing to search
    const seed = seedQuery?.trim() ?? "";
    this.visible = true;
    this.root.hidden = false;
    this.query = seed;
    this.input.value = seed;
    this.selected = 0;
    this.results = [];
    this.listEl.replaceChildren();
    this.showHint(
      seed ? `Searching "${seed}" …` : "Type to search files and symbols.",
    );
    this.renderMeta(0, this.symbolIndex?.incomplete ?? false);
    this.input.focus();
    // Caret after the seed so editing continues naturally.
    // (linkedom inputs lack setSelectionRange — guard for tests.)
    if (typeof this.input.setSelectionRange === "function") {
      this.input.setSelectionRange(seed.length, seed.length);
    }
    this.scheduleSearch();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.root.hidden = true;
    this.searchGen++;
    if (this.debounceTimer !== null) {
      window.clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
  }

  // ------------------------------------------------------------- search

  private scheduleSearch(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = window.setTimeout(() => {
      this.debounceTimer = null;
      void this.runSearch();
    }, SEARCH_DEBOUNCE_MS);
  }

  /**
   * Throttled refresh for streamed index batches. A debounce would starve the
   * list for the whole walk (batches keep resetting it); this fires on a
   * fixed cadence so results visibly grow while the engine loads.
   */
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

    // `~engine` narrows to engine sources. It no longer gates the walk — the
    // engine tier streams in on its own — so toggling it is instant.
    this.engineOnly = query.toLowerCase().startsWith(ENGINE_QUERY_PREFIX);
    const q = this.engineOnly
      ? query.slice(ENGINE_QUERY_PREFIX.length).trim()
      : query;

    // Empty query: recent hint, no walk.
    if (!q) {
      this.results = [];
      this.listEl.replaceChildren();
      this.showHint("Type to search files and symbols.");
      this.renderMeta(0, false);
      return;
    }

    await this.ensureFileCache(root, gen);
    if (gen !== this.searchGen) return;

    const ranked = await this.search.query(q, MAX_FILE_ROWS, this.engineOnly);
    if (gen !== this.searchGen) return;
    const fileHits = ranked.files;

    // clangd workspace/symbol answers from the disk index (0ms warm) and
    // catches macro-generated types (UHT delegates etc.) the text scanner
    // structurally cannot see. Fire it in parallel with the text index.
    const semanticPromise = clangdWorkspaceSymbols(root, q).catch(
      () => [] as Awaited<ReturnType<typeof clangdWorkspaceSymbols>>,
    );

    // Symbols: first-use index probe (instant if cached).
    const symbols = await this.ensureSymbolIndex(root, gen);
    if (gen !== this.searchGen) return;
    const semantic = await semanticPromise;
    if (gen !== this.searchGen) return;

    // Semantic hits lead; identical text-index rows are dropped.
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
      [...semanticEntries, ...textEntries],
      q,
      MAX_SYMBOL_ROWS,
    );

    this.results = [...fileHits.map(f => ({ kind: "file", ...f }) as QuickOpenEntry), ...symbolHits.map(s => ({ kind: "symbol", ...s }) as QuickOpenEntry)];
    this.selected = 0;
    this.renderResults();
    this.renderMeta(this.results.length, Boolean(symbols?.incomplete));
  }

  /**
   * Load the project tier (awaited — it is small and the palette is useless
   * without it), then kick off the engine tier, which streams in behind it.
   */
  private async ensureFileCache(
    root: string,
    gen: number,
  ): Promise<Array<{ path: string; rel: string }>> {
    if (this.fileCacheKey === root) {
      // A transiently unavailable preload bridge must not turn the cached
      // project tier into a permanent "never index Engine" state.
      if (this.engineState === "idle") this.startEngineIndex(root);
      return this.fileCache;
    }
    const bridge = window.jellybot;
    if (!bridge?.searchDevModeFiles) return [];
    // Different workspace: drop the whole index before reloading, or the old
    // tree's files linger and the engine pass stays stuck on "done".
    this.resetIndex();
    // Full tree, code + text only: UE projects drown ~20k source files in
    // ~300k assets, and the fuzzy filter runs client-side against this
    // list, so a `.` catch-all query (300 cap) would drop Source/ entirely.
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

  /**
   * Drop every tier and disown the in-flight engine walk. Bumping the request
   * id is what makes late batches from the previous workspace harmless.
   */
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

  /**
   * Stream the engine tree into the index. Runs once per workspace; batches
   * land on `devmode:indexChunk` and refresh the visible results as they
   * arrive, so a multi-second engine walk never blocks a project-file search.
   */
  private startEngineIndex(root: string): void {
    if (this.engineState !== "idle") return;
    const bridge = window.jellybot;
    if (!bridge?.startDevModeFileIndex || !bridge.onDevModeIndexChunk) return;
    this.engineState = "loading";
    const requestId = ++this.indexRequestId;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = bridge.onDevModeIndexChunk((chunk) => {
      // A workspace switch bumps the id; late batches from the old walk are
      // for an index we have already thrown away.
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
      // Fold the new batch into whatever the user is looking at.
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
        // Start-up rejection (bad path, no engine) never yields a `done`.
        if (!result.ok && requestId === this.indexRequestId) {
          this.engineState = "done";
        }
      })
      .catch(() => {
        if (requestId === this.indexRequestId) this.engineState = "done";
      });
  }

  /** First symbol use builds the index; incomplete scans resume lazily. */
  private async ensureSymbolIndex(
    root: string,
    gen: number,
  ): Promise<SymbolIndex | null> {
    // Symbols stay project-scoped: scanning engine sources would multiply the
    // candidate list several times over for hits nobody asked for.
    const indexKey = root;
    if (this.symbolIndexKey === indexKey && this.symbolIndex) {
      return this.symbolIndex;
    }
    const bridge = window.jellybot;
    if (!bridge?.searchDevModeFiles) return null;
    if (this.symbolIndexKey !== indexKey) {
      // Workspace switch — kill any in-flight scan for the old root.
      if (this.symbolTimer !== null) {
        window.clearInterval(this.symbolTimer);
        this.symbolTimer = null;
      }
      this.symbolIndexKey = indexKey;
      this.symbolIndex = { entries: [], incomplete: true, scannedFiles: 0 };
      this.symbolFiles = null;
      this.symbolScanCursor = 0;
    }
    // Kick the scan now (budgeted); results render as they land.
    void this.runSymbolScan(root, gen);
    return this.symbolIndex;
  }

  /**
   * Chunked scanner. Each pass reads SYMBOL_SCAN_CHUNK files within the
   * deadline; while incomplete, a 250ms interval keeps scanning until the
   * budget is exhausted, then stops (resumes when a new query needs it).
   */
  private async runSymbolScan(root: string, gen: number): Promise<void> {
    const idx = this.symbolIndex;
    const bridge = window.jellybot;
    if (!idx || !bridge?.readTextFile) return;
    if (this.symbolTimer !== null) return; // already scanning
    if (this.symbolFiles === null) {
      // Candidate list: one walk (cache-shared with files when possible).
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
    // Per-chunk deadline: the interval re-arms it each pass, so background
    // scanning continues instead of dying at the first deadline.
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
        if (this.symbolTimer !== null) window.clearInterval(this.symbolTimer);
        this.symbolTimer = null;
      }
      // Live update while the user is looking at results.
      if (this.visible && gen === this.searchGen) {
        void this.runSearch();
      }
    };
    if (idx.incomplete) {
      await scan();
      if (idx.incomplete && this.symbolTimer === null) {
        this.symbolTimer = window.setInterval(() => {
          if (gen !== this.searchGen || !this.symbolIndex) {
            if (this.symbolTimer !== null) window.clearInterval(this.symbolTimer);
            this.symbolTimer = null;
            return;
          }
          // Re-arm the deadline for this background pass.
          deadline = Date.now() + SYMBOL_SCAN_DEADLINE_MS;
          void scan();
        }, 250);
      }
    }
  }

  // ------------------------------------------------------------ selection

  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    const next = (this.selected + delta + this.results.length) % this.results.length;
    this.selected = next;
    this.updateSelectionClasses();
    this.renderMeta(this.results.length, this.symbolIndex?.incomplete ?? false);
    const row = this.listEl.querySelector<HTMLElement>(
      `.devmode-quickopen-item[data-idx="${this.selected}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }

  private openSelected(): void {
    const entry = this.results[this.selected];
    if (!entry) return;
    this.close();
    if (entry.kind === "file") {
      this.options.openFile(entry.path);
    } else {
      this.options.openFile(entry.path, entry.line);
    }
  }

  // --------------------------------------------------------------- render

  private renderResults(): void {
    this.listEl.replaceChildren();
    if (this.results.length === 0) return;
    let lastKind: "file" | "symbol" | null = null;
    this.results.forEach((entry, i) => {
      if (entry.kind !== lastKind) {
        const label = document.createElement("div");
        label.className = "devmode-quickopen-label";
        label.textContent = entry.kind === "file" ? "Files" : "Symbols";
        this.listEl.append(label);
        lastKind = entry.kind;
      }
      const row = document.createElement("div");
      row.className = "devmode-quickopen-item";
      row.setAttribute("role", "option");
      row.setAttribute("data-kind", entry.kind);
      row.setAttribute("data-idx", String(i));
      row.classList.toggle("is-sel", i === this.selected);
      const icon = document.createElement("span");
      icon.className = "devmode-quickopen-icon";
      icon.append(
        createLucideIcon(
          entry.kind === "file"
            ? FileText
            : entry.symbolKind === "function"
              ? SquareFunction
              : Braces,
          { size: 13, strokeWidth: 1.75 },
        ),
      );
      const name = document.createElement("span");
      name.className = "devmode-quickopen-name";
      name.textContent =
        entry.kind === "file" ? baseNameOf(entry.rel) : entry.name;
      const detail = document.createElement("span");
      detail.className = "devmode-quickopen-detail";
      if (entry.kind === "file") {
        const slash = entry.rel.lastIndexOf("/");
        detail.textContent = slash === -1 ? "" : entry.rel.slice(0, slash);
      } else {
        const slash = entry.rel.lastIndexOf("/");
        const dir = slash === -1 ? "" : entry.rel.slice(0, slash);
        const bits: string[] = [];
        if (entry.container) bits.push(entry.container);
        if (dir) bits.push(dir);
        bits.push(`:${entry.line}`);
        detail.textContent = bits.join(" · ");
      }
      row.append(icon, name, detail);
      row.addEventListener("click", () => {
        this.selected = i;
        this.openSelected();
      });
      row.addEventListener("pointermove", () => {
        if (this.selected !== i) {
          this.selected = i;
          this.updateSelectionClasses();
        }
      });
      this.listEl.append(row);
    });
  }

  private updateSelectionClasses(): void {
    // Labels interleave items — map result index → row via data-idx.
    [...this.listEl.querySelectorAll<HTMLElement>(".devmode-quickopen-item")].forEach(
      (el) => {
        el.classList.toggle("is-sel", el.dataset.idx === String(this.selected));
      },
    );
  }

  private renderMeta(count: number, indexing: boolean): void {
    this.countEl.textContent =
      count > 0 ? `${this.selected + 1} / ${count}` : "0 results";
    // Engine progress outranks the symbol note: it explains why results are
    // still growing, which is the more confusing state to leave unexplained.
    this.metaNoteEl.textContent =
      this.engineState === "loading"
        ? `Indexing Engine… ${this.engineCount.toLocaleString()} files`
        : this.engineTruncated
          ? "Engine index incomplete (budget reached)"
          : this.fileCacheTruncated
            ? "Project index incomplete (budget reached)"
            : indexing
              ? "Indexing symbols…"
              : "";
  }

  private showHint(text: string): void {
    // Surface the engine filter so the prefix is discoverable.
    const hint = this.engineOnly
      ? `${text} · ~engine on (Engine sources only)`
      : text;
    const row = document.createElement("div");
    row.className = "quickopen-hint";
    row.textContent = hint;
    this.listEl.replaceChildren(row);
  }
}
