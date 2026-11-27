import { baseNameOf } from "./slnPaths.js";
import { QuickOpenSearchClient } from "./QuickOpenSearchClient.js";
import type { RankFile, RankSymbol } from "./quickOpenRank.js";
import { clangdWorkspaceSymbols } from "./clangdFeatures.js";
import { isUhtGeneratedPath } from "./goToDefinition.js";
import { QuickOpenView, type QuickOpenRow } from "./QuickOpenView.js";
import {
  isTypeEntry,
  mergeQuickOpenLayers,
  quickOpenEntryKey,
  quickOpenGroupLabel,
  reselectQuickOpenIndex,
  type QuickOpenCategory,
  type QuickOpenEntry,
  type QuickOpenTextHit,
} from "./quickOpenMerge.js";

export { fuzzyMatch } from "./quickOpenRank.js";
export { quickOpenEntryKey, reselectQuickOpenIndex, type QuickOpenEntry } from "./quickOpenMerge.js";

export type QuickOpenOptions = {
  getRecentFiles?: () => string[];
  openFile: (path: string, line?: number) => void;
  getWorkspaceRoot: () => string | null;
};

type LayerName = "semantic" | "index" | "text" | "files";

type SearchSession = {
  gen: number;
  key: string;
  root: string;
  query: string;
  category: QuickOpenCategory;
  engineOnly: boolean;
  includeEngine: boolean;
  semantic: RankSymbol[];
  index: RankSymbol[];
  text: QuickOpenTextHit[];
  files: RankFile[];
  pending: Set<LayerName>;
  textRequestId: number | null;
  textTruncated: boolean;
  textError: string | null;
};

const normalizedPath = (path: string): string => path.replace(/\\/g, "/").replace(/\/+$/, "");
const withinRoot = (path: string, root: string): boolean => {
  const p = normalizedPath(path).toLowerCase();
  const r = normalizedPath(root).toLowerCase();
  return p === r || p.startsWith(`${r}/`);
};

const SEARCH_DEBOUNCE_MS = 150;
const MAX_FILE_ROWS = 50;
const FILE_CACHE_MAX = 60_000;
const FILE_CACHE_DEADLINE_MS = 15_000;
const ENGINE_INDEX_MAX = 200_000;
const ENGINE_INDEX_DEADLINE_MS = 0;
const ENGINE_QUERY_PREFIX = "~engine";
const STREAM_REFRESH_MS = 400;
const SYMBOL_QUERY_LIMIT = 500;
const TEXT_MIN_CHARS = 3;

const LAYERS_BY_CATEGORY: Record<QuickOpenCategory, readonly LayerName[]> = {
  All: ["files", "index", "semantic", "text"],
  Files: ["files"],
  Types: ["index", "semantic"],
  Symbols: ["index", "semantic"],
  Text: ["text"],
};

function relPathWithin(root: string, path: string): string {
  const norm = path.replace(/\\/g, "/");
  const rootNorm = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
  if (norm.toLowerCase().startsWith(rootNorm.toLowerCase())) {
    return norm.slice(rootNorm.length);
  }
  return baseNameOf(norm);
}

export class QuickOpenController {
  private readonly view: QuickOpenView;
  private readonly search = new QuickOpenSearchClient();
  private readonly recent = new Map<string, string[]>();
  private category: QuickOpenCategory = "All";
  private includeEngine = true;
  private engineOnly = false;
  private scopeRoot: string | null = null;
  private showingRecent = false;
  private visible = false;
  private query = "";
  private results: QuickOpenEntry[] = [];
  private selected = 0;
  private resultsKey: string | null = null;
  private pinnedKey: string | null = null;
  private debounceTimer: number | null = null;
  private searchGen = 0;
  private session: SearchSession | null = null;
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
  private textRequestId = 0;
  private textRunning = false;
  private unsubscribeText: (() => void) | null = null;

  constructor(private readonly options: QuickOpenOptions) {
    this.view = new QuickOpenView({
      onQueryChange: (text) => {
        this.query = text;
        this.scheduleSearch();
      },
      onClear: () => {
        this.query = "";
        this.view.setQuery("");
        this.scheduleSearch();
        this.view.focusInput();
      },
      onCategoryChange: (category) => {
        this.category = category;
        this.view.setCategory(category);
        this.selected = 0;
        this.scheduleSearch();
        this.view.focusInput();
      },
      onEngineScopeChange: (checked) => {
        this.includeEngine = checked;
        if (!checked && this.query.toLowerCase().startsWith(ENGINE_QUERY_PREFIX)) {
          this.query = this.query.slice(ENGINE_QUERY_PREFIX.length).trim();
          this.view.setQuery(this.query);
        }
        this.selected = 0;
        this.scheduleSearch();
        this.view.focusInput();
      },
      onMove: (delta) => this.moveSelection(delta),
      onAccept: () => this.openSelected(),
      onDismiss: () => this.close(),
      onRowActivate: (index) => {
        this.selected = index;
        this.openSelected();
      },
      onRowHover: (index) => {
        if (this.selected === index) return;
        this.selected = index;
        this.pinSelection();
        this.view.setSelected(index);
      },
    });
  }

  mount(host: HTMLElement): void {
    this.view.mount(host);
  }

  destroy(): void {
    if (this.debounceTimer !== null) window.clearTimeout(this.debounceTimer);
    this.debounceTimer = null;
    if (this.streamRefreshTimer !== null) window.clearTimeout(this.streamRefreshTimer);
    this.streamRefreshTimer = null;
    this.searchGen++;
    this.indexRequestId++;
    this.session = null;
    this.unsubscribeChunk?.();
    this.unsubscribeChunk = null;
    this.cancelText();
    this.unsubscribeText?.();
    this.unsubscribeText = null;
    void window.jellybot?.cancelDevModeFileIndex?.();
    this.search.dispose();
    this.view.destroy();
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
    this.view.setVisible(true);
    this.query = seed;
    this.view.setQuery(seed);
    if (seed) {
      this.category = "All";
      this.view.setCategory("All");
    }
    if (this.scopeRoot !== root) {
      this.scopeRoot = root;
      this.view.setEngineScopeVisible(false);
      void window.jellybot
        ?.getDevModeEngineRoot?.(root)
        .then((engineRoot) => {
          if (this.options.getWorkspaceRoot() === root) this.view.setEngineScopeVisible(!!engineRoot);
        })
        .catch(() => {});
    }
    this.selected = 0;
    this.results = [];
    this.resultsKey = null;
    this.pinnedKey = null;
    this.showHint(seed ? `Searching "${seed}" …` : "Type to search files, symbols and text.");
    this.renderMeta(0);
    this.view.focusInput(seed.length);
    this.scheduleSearch();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.view.setVisible(false);
    this.searchGen++;
    this.session = null;
    this.cancelText();
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
    if (!this.visible || this.streamRefreshTimer !== null) return;
    const wait = Math.max(0, STREAM_REFRESH_MS - (Date.now() - this.lastStreamRefresh));
    this.streamRefreshTimer = window.setTimeout(() => {
      this.streamRefreshTimer = null;
      this.lastStreamRefresh = Date.now();
      const session = this.session;
      if (session && session.gen === this.searchGen && LAYERS_BY_CATEGORY[session.category].includes("files")) {
        void this.loadFileLayer(session);
      } else {
        this.renderMeta(this.results.length);
      }
    }, wait);
  }

  private runSearch(): void {
    if (!this.visible) return;
    const gen = ++this.searchGen;
    const raw = this.query.trim();
    const root = this.options.getWorkspaceRoot();
    if (!root) return;

    this.engineOnly = raw.toLowerCase().startsWith(ENGINE_QUERY_PREFIX);
    const q = this.engineOnly ? raw.slice(ENGINE_QUERY_PREFIX.length).trim() : raw;
    if (this.engineOnly) {
      this.includeEngine = true;
      this.view.setEngineChecked(true);
    }
    this.showingRecent = !q;
    const key = `${this.category}|${this.engineOnly}|${this.includeEngine}|${q}`;

    if (!q) {
      this.session = null;
      this.cancelText();
      const filesLike = this.category === "All" || this.category === "Files";
      this.results = filesLike ? this.recentFiles(root) : [];
      this.showResults(key, q);
      if (!this.results.length) {
        this.showHint(filesLike ? "No recent files" : `Type to search ${this.category.toLowerCase()}.`);
      }
      this.renderMeta(this.results.length);
      return;
    }

    const session: SearchSession = {
      gen,
      key,
      root,
      query: q,
      category: this.category,
      engineOnly: this.engineOnly,
      includeEngine: this.includeEngine,
      semantic: [],
      index: [],
      text: [],
      files: [],
      pending: new Set(),
      textRequestId: null,
      textTruncated: false,
      textError: null,
    };
    this.session = session;
    const layers = LAYERS_BY_CATEGORY[session.category];
    if (!layers.includes("text") || !this.startTextLayer(session)) this.cancelText();
    if (layers.includes("files")) {
      session.pending.add("files");
      void this.loadFileLayer(session);
    }
    if (layers.includes("index")) {
      session.pending.add("index");
      void this.loadIndexLayer(session);
    }
    if (layers.includes("semantic")) {
      session.pending.add("semantic");
      void this.loadSemanticLayer(session);
    }
  }

  private isCurrent(session: SearchSession): boolean {
    return this.session === session && session.gen === this.searchGen && this.visible;
  }

  private async loadFileLayer(session: SearchSession): Promise<void> {
    await this.ensureFileCache(session.root, session.gen);
    if (!this.isCurrent(session)) return;
    const ranked = await this.search.query(
      session.query,
      MAX_FILE_ROWS,
      session.engineOnly,
      session.includeEngine,
    );
    if (!this.isCurrent(session)) return;
    session.files = ranked.files.filter((file) => !isUhtGeneratedPath(file.path));
    this.finishLayer(session, "files");
  }

  private async loadIndexLayer(session: SearchSession): Promise<void> {
    const bridge = window.jellybot;
    let symbols: RankSymbol[] = [];
    if (bridge?.searchSymbols) {
      try {
        const hits = await bridge.searchSymbols(session.root, session.query, SYMBOL_QUERY_LIMIT);
        symbols = hits
          .filter((hit) => !isUhtGeneratedPath(hit.path))
          .map((hit) => ({
            name: hit.name,
            path: hit.path,
            rel: relPathWithin(session.root, hit.path),
            line: hit.line,
            symbolKind: hit.kind,
            ...(hit.container ? { container: hit.container } : {}),
          }));
      } catch {
        symbols = [];
      }
    }
    if (!this.isCurrent(session)) return;
    session.index = symbols;
    this.finishLayer(session, "index");
  }

  private async loadSemanticLayer(session: SearchSession): Promise<void> {
    const semantic = await clangdWorkspaceSymbols(session.root, session.query).catch(
      () => [] as Awaited<ReturnType<typeof clangdWorkspaceSymbols>>,
    );
    if (!this.isCurrent(session)) return;
    session.semantic = semantic
      .filter((symbol) => !isUhtGeneratedPath(symbol.path))
      .map((symbol) => ({
        name: symbol.name,
        path: symbol.path,
        rel: relPathWithin(session.root, symbol.path),
        line: symbol.line,
        symbolKind: symbol.symbolKind,
        ...(symbol.container ? { container: symbol.container } : {}),
      }));
    this.finishLayer(session, "semantic");
  }

  private startTextLayer(session: SearchSession): boolean {
    const bridge = window.jellybot;
    if (
      session.query.length < TEXT_MIN_CHARS ||
      !bridge?.startDevModeTextSearch ||
      !bridge.onDevModeTextSearchChunk
    ) {
      return false;
    }
    this.unsubscribeText ??= bridge.onDevModeTextSearchChunk((chunk) => this.onTextChunk(chunk));
    const requestId = ++this.textRequestId;
    session.textRequestId = requestId;
    session.pending.add("text");
    this.textRunning = true;
    void bridge
      .startDevModeTextSearch(session.root, requestId, session.query, {
        includeEngine: session.includeEngine,
        engineOnly: session.engineOnly,
      })
      .then((result) => {
        if (!result.ok && session.textRequestId === requestId) {
          session.textError = result.message ?? "Text search failed";
          this.finishLayer(session, "text");
        }
      })
      .catch(() => {
        if (session.textRequestId === requestId) {
          session.textError = "Text search failed";
          this.finishLayer(session, "text");
        }
      });
    return true;
  }

  private onTextChunk(chunk: {
    requestId: number;
    hits: QuickOpenTextHit[];
    done: boolean;
    truncated: boolean;
    error?: string;
  }): void {
    const session = this.session;
    if (!session || chunk.requestId !== session.textRequestId) return;
    for (const hit of chunk.hits) {
      if (!isUhtGeneratedPath(hit.path)) session.text.push(hit);
    }
    if (!chunk.done) {
      if (this.isCurrent(session)) this.renderSession(session);
      return;
    }
    this.textRunning = false;
    session.textTruncated = chunk.truncated;
    if (chunk.error) session.textError = chunk.error;
    this.finishLayer(session, "text");
  }

  private cancelText(): void {
    if (!this.textRunning) return;
    this.textRunning = false;
    this.textRequestId++;
    void window.jellybot?.cancelDevModeTextSearch?.();
  }

  private finishLayer(session: SearchSession, layer: LayerName): void {
    session.pending.delete(layer);
    if (this.isCurrent(session)) this.renderSession(session);
  }

  private renderSession(session: SearchSession): void {
    this.results = mergeQuickOpenLayers({
      layers: session,
      query: session.query,
      category: session.category,
      keepSymbol: (symbol) => {
        const external = !withinRoot(symbol.path, session.root);
        return session.engineOnly ? external : session.includeEngine || !external;
      },
    });
    this.showResults(session.key, session.query);
    if (this.results.length === 0) {
      this.showHint(session.pending.size > 0 ? "Searching…" : "No results found");
    }
    this.renderMeta(this.results.length);
  }

  private showResults(key: string, highlight: string): void {
    const refresh = key === this.resultsKey;
    this.resultsKey = key;
    if (!refresh) this.pinnedKey = null;
    this.selected = refresh ? reselectQuickOpenIndex(this.pinnedKey, this.results, this.selected) : 0;
    const root = this.options.getWorkspaceRoot() ?? "";
    this.view.renderRows({
      rows: this.results.map((entry) => this.rowFor(entry, root)),
      selected: this.selected,
      highlight,
      preserveScroll: refresh,
      revealSelected: refresh && this.pinnedKey !== null,
    });
  }

  private rowFor(entry: QuickOpenEntry, root: string): QuickOpenRow {
    const project = withinRoot(entry.path, root)
      ? baseNameOf(root)
      : /(?:^|[\\/])Engine[\\/]/i.test(entry.path)
        ? "Engine"
        : "External";
    const group = this.showingRecent
      ? "Recent Files"
      : this.category === "All"
        ? quickOpenGroupLabel(entry)
        : null;
    if (entry.kind === "file") {
      const slash = entry.rel.lastIndexOf("/");
      return {
        kind: "file",
        icon: "file",
        name: baseNameOf(entry.rel),
        detail: slash === -1 ? "" : entry.rel.slice(0, slash),
        project,
        title: entry.path,
        group,
      };
    }
    if (entry.kind === "text") {
      return {
        kind: "text",
        icon: "text",
        name: entry.preview,
        detail: `${entry.rel}:${entry.line}`,
        project,
        title: `${entry.path}:${entry.line}`,
        group,
      };
    }
    const bits: string[] = [];
    if (entry.container) bits.push(entry.container);
    bits.push(`${baseNameOf(entry.rel)}:${entry.line}`);
    return {
      kind: "symbol",
      icon: isTypeEntry(entry) ? "type" : "symbol",
      name: entry.name,
      detail: bits.join(" · "),
      project,
      title: `${entry.path}:${entry.line}`,
      group,
    };
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
        if (!result.ok && requestId === this.indexRequestId) this.engineState = "done";
      })
      .catch(() => {
        if (requestId === this.indexRequestId) this.engineState = "done";
      });
  }

  private recentFiles(root: string): QuickOpenEntry[] {
    if (!this.recent.has(root)) {
      let paths: string[] = [];
      try {
        const saved: unknown = JSON.parse(
          window.localStorage.getItem(`jellybot.quickOpen.recent:${root}`) ?? "[]",
        );
        if (Array.isArray(saved)) {
          paths = saved.filter((path): path is string => typeof path === "string").slice(0, 20);
        }
      } catch {
        paths = [];
      }
      this.recent.set(root, paths);
    }
    return [...new Set([...(this.options.getRecentFiles?.() ?? []), ...this.recent.get(root)!])]
      .filter((path) =>
        this.engineOnly ? !withinRoot(path, root) : this.includeEngine || withinRoot(path, root),
      )
      .filter((path) => !isUhtGeneratedPath(path))
      .slice(0, 12)
      .map((path) => ({ kind: "file", path, rel: relPathWithin(root, path) }));
  }

  private moveSelection(delta: number): void {
    if (this.results.length === 0) return;
    this.selected = (this.selected + delta + this.results.length) % this.results.length;
    this.pinSelection();
    this.view.setSelected(this.selected);
    this.renderMeta(this.results.length);
    this.view.revealSelected(this.selected);
  }

  private openSelected(): void {
    const entry = this.results[this.selected];
    if (!entry) return;
    const root = this.options.getWorkspaceRoot();
    if (root) {
      const paths = [
        entry.path,
        ...(this.recent.get(root) ?? []).filter((path) => path !== entry.path),
      ].slice(0, 20);
      this.recent.set(root, paths);
      try {
        window.localStorage.setItem(`jellybot.quickOpen.recent:${root}`, JSON.stringify(paths));
      } catch {
        this.recent.set(root, paths);
      }
    }
    this.close();
    if (entry.kind === "file") this.options.openFile(entry.path);
    else this.options.openFile(entry.path, entry.line);
  }

  private renderMeta(count: number): void {
    const session = this.session;
    const note =
      this.includeEngine && this.engineState === "loading"
        ? `Indexing Engine… ${this.engineCount.toLocaleString()} files`
        : this.includeEngine && this.engineTruncated
          ? "Engine index incomplete (budget reached)"
          : this.fileCacheTruncated
            ? "Project index incomplete (budget reached)"
            : session?.textError
              ? "Text search unavailable"
              : session?.textTruncated
                ? "Text results limited to the first matches"
                : "";
    this.view.setMeta(count > 0 ? `${this.selected + 1} / ${count}` : "0 results", note);
  }

  private showHint(text: string): void {
    this.view.showHint(this.engineOnly ? `${text} · ~engine on (Engine sources only)` : text);
  }
}
