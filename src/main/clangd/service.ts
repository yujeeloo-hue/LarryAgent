/**
 * ClangdService — one hosted clangd child process per workspace (the UE
 * preamble is ~100MB and RAM-hungry, so a single instance is the policy).
 *
 * Responsibilities:
 * - locate clangd + compile_commands.json (UBT `-Mode=GenerateClangDatabase`)
 * - LSP lifecycle: initialize / didOpen / didChange / didClose
 * - semantic queries: references / definition / hover / completion /
 *   signatureHelp
 * - watch UHT-generated headers (`Intermediate/**.generated.h`) and push
 *   `workspace/didChangeWatchedFiles` so clangd recovers after UHT runs
 *
 * The text-level CppSymbolIndexService stays the fallback when no compile
 * database exists (non-UE workspaces, fresh clones).
 */

import { watch, type FSWatcher } from "node:fs";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { cpus } from "node:os";
import { readFile as readFileAsync, stat as statAsync } from "node:fs/promises";
import { agentLogInfo, agentLogWarn } from "../../logging/agentLog.js";
import type { CppCompletionHit, CppCompletionRequest } from "../cppSymbols/types.js";
import { openCppSymbolDatabase } from "../cppSymbols/db.js";
import { cppSymbolDatabasePath, normalizeSymbolPath } from "../cppSymbols/paths.js";
import { CompileDbInspector } from "./compileFlags.js";
import { ClangdIndexCompletion } from "./indexCompletion.js";
import { LspConnection } from "./lsp.js";
import { parseSignatureHelp } from "./signatureHelp.js";
import { findClangdBinary, findCompileDb } from "./locate.js";
import type {
  ClangdFileBuildState,
  ClangdIndexProgressEvent,
  ClangdCompletionItem,
  ClangdCompletionResult,
  ClangdDefinitionResult,
  ClangdHoverResult,
  ClangdLocation,
  ClangdPositionRequest,
  ClangdReferencesResult,
  ClangdSignatureHelpResult,
  ClangdStatus,
  ClangdWorkspaceSymbol,
  ClangdWorkspaceSymbolsResult,
} from "./types.js";

type DocState = { text: string; version: number };

type Session = {
  root: string;
  clangdPath: string;
  compileCommandsDir: string;
  engineRoot: string | null;
  conn: LspConnection;
  docs: Map<string, DocState>;
  uhtWatcher: FSWatcher | null;
  /** First request after spawn pays the preamble build — allow more time. */
  warm: boolean;
  /** Compile-command reader for the `clangd.compile_flags` log line. */
  inspector: CompileDbInspector;
  /** Per-document build phase start (FileStatus) → duration log lines. */
  fileBuilds: Map<string, { state: ClangdFileBuildState; since: number }>;
  /** Background index begin time (`$/progress` begin). */
  indexStartedAt: number | null;
  /** Persistent-index member completion (class chain cache lives here). */
  indexCompletion: ClangdIndexCompletion;
  /** True once a `workspace/symbol` query returned hits (shards loaded). */
  indexReady: boolean;
  /** Virtual document that triggers compile-db + index loading at start. */
  probeUri: string;
};

/**
 * clangd loads the compile database — and with it the on-disk index (~30s
 * for 60k UE shards) — only when the first document asks for a command.
 * A tiny in-memory document (never written to disk) starts that at spawn.
 */
const INDEX_PROBE_NAME = "__jellybot_index_probe.cpp";
const INDEX_READY_POLL_MS = 2_000;
const INDEX_READY_GIVE_UP_MS = 10 * 60_000;
/** After this, stop waiting for workspace markers and accept any index symbol. */
const INDEX_MARKER_GIVE_UP_MS = 3 * 60_000;
/**
 * Whole index-completion budget per completion site. The renderer shows the
 * text index first and merges this answer in when it lands.
 */
const INDEX_COMPLETE_TIMEOUT_MS = 3_000;
/** Completion candidates per request (clangd `--limit-results`). */
const COMPLETION_RESULT_LIMIT = 20;
/** clangd reports macros as LSP SymbolKind.String in workspace/symbol. */
const MACRO_SYMBOL_KIND = 15;

/** Rolling completion latency window, flushed to the log periodically. */
type CompletionStats = {
  samples: number[];
  errors: number;
  cancelled: number;
  windowStart: number;
};
const COMPLETION_STATS_FLUSH_COUNT = 50;
const COMPLETION_STATS_FLUSH_MS = 60_000;

const REQUEST_TIMEOUT_MS = 30_000;
const FIRST_REQUEST_TIMEOUT_MS = 120_000;
/**
 * Interactive queries (editor keystrokes) must never block the UI for a
 * preamble build — bail fast and let the text-index fallback answer.
 */
const INTERACTIVE_TIMEOUT_MS = 5_000;
/** Find Usages runs with a loading indicator; long waits are acceptable. */
const REFERENCES_TIMEOUT_MS = 90_000;
/**
 * Go-to-definition waits as long as it must (cold UE headers pay a 30s+
 * preamble build); the renderer cancels with ESC, so `0` disables the
 * wall-clock timer in LspConnection.request.
 */
const DEFINITION_TIMEOUT_MS = 0;

function toUri(path: string): string {
  return "file:///" + path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function fromUri(uri: string): string {
  return uri.replace(/^file:\/\/\//, "").replace(/^\/([A-Za-z]:)/, "$1");
}

function toLocation(location: unknown): ClangdLocation | null {
  if (!location || typeof location !== "object") return null;
  const uri = (location as { uri?: unknown }).uri ?? (location as { targetUri?: unknown }).targetUri;
  const rawRange = (location as { range?: unknown }).range;
  // LocationLink (definition results) carries targetRange instead of range.
  const range = rawRange ?? (location as { targetRange?: unknown }).targetRange;
  if (typeof uri !== "string" || !range || typeof range !== "object") return null;
  const start = (range as { start?: unknown }).start;
  const end = (range as { end?: unknown }).end;
  if (!start || typeof start !== "object") return null;
  const s = start as { line?: unknown; character?: unknown };
  const e = (end ?? start) as { line?: unknown; character?: unknown };
  if (typeof s.line !== "number" || typeof s.character !== "number") return null;
  return {
    path: fromUri(uri),
    line: s.line + 1,
    column: s.character + 1,
    endLine: typeof e.line === "number" ? e.line + 1 : s.line + 1,
    endColumn: typeof e.character === "number" ? e.character + 1 : s.character + 1,
  };
}

function plainDocumentation(doc: unknown): string | undefined {
  if (typeof doc === "string") return doc;
  if (doc && typeof doc === "object" && typeof (doc as { value?: unknown }).value === "string") {
    return (doc as { value: string }).value;
  }
  return undefined;
}

export class ClangdService {
  private session: Session | null = null;
  private starting: Promise<Session | null> | null = null;
  /** Live cancellable queries (renderer ESC) keyed by their query id. */
  private readonly queryCancellers = new Map<string, AbortController>();

  constructor(
    private readonly broadcastIndexProgress: (event: ClangdIndexProgressEvent) => void = () => {},
  ) {}

  // ------------------------------------------------------------- lifecycle

  async status(rootPath: string): Promise<ClangdStatus> {
    if (typeof rootPath !== "string" || !rootPath.trim()) {
      return { ok: false, message: "Missing workspace path." };
    }
    const clangdPath = findClangdBinary();
    if (!clangdPath) {
      return {
        ok: false,
        message:
          "clangd not found. Install LLVM (clangd + clang) or extract the standalone " +
          "clangd zip to %LOCALAPPDATA%\\JellyBot\\tools\\clangd\\.",
      };
    }
    const db = await findCompileDb(rootPath);
    if (!db) {
      return {
        ok: false,
        message:
          "No compile_commands.json for this workspace. For Unreal projects run: " +
          "Engine\\Build\\BatchFiles\\Build.bat -Mode=GenerateClangDatabase " +
          "-Project=<uproject> <Target> Win64 <Config>",
      };
    }
    return {
      ok: true,
      clangdPath,
      compileCommandsDir: db.compileCommandsDir,
      engineRoot: db.engineRoot,
      running: this.session?.root === rootPath.replace(/\\/g, "/") && !!this.session?.conn,
    };
  }

  /** Resolve the character column when only a symbol name was supplied. */
  private async resolveColumn(request: ClangdPositionRequest): Promise<{
    line: number;
    character: number;
    text: string;
  } | null> {
    let text = request.text;
    if (typeof text !== "string") {
      try {
        text = readFileSync(request.path, "utf8");
      } catch {
        return null;
      }
    }
    const lines = text.split(/\r?\n/);
    const lineText = lines[request.line - 1];
    if (lineText === undefined) return null;
    let character: number;
    if (typeof request.column === "number" && request.column >= 1) {
      character = request.column - 1;
    } else if (typeof request.symbol === "string") {
      const index = lineText.indexOf(request.symbol);
      if (index < 0) return null;
      character = index;
    } else {
      const word = /([A-Za-z_]\w*)/.exec(lineText);
      if (!word) return null;
      character = word.index;
    }
    return { line: request.line - 1, character, text };
  }

  /**
   * Warm up: spawn clangd for this workspace so the background index
   * starts before the first query. No-op when prerequisites are missing.
   */
  async ensureStarted(rootPath: string): Promise<ClangdStatus> {
    const status = await this.status(rootPath);
    if (!status.ok) return status;
    await this.ensure(rootPath);
    return this.status(rootPath);
  }

  /** Ensure clangd runs for this root; null when it cannot be started. */
  private async ensure(rootPath: string): Promise<Session | null> {
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (this.session && this.session.root === root) return this.session;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const clangdPath = findClangdBinary();
      if (!clangdPath) return null;
      const db = await findCompileDb(root);
      if (!db) return null;
      this.stopSession();
      this.writeWorkspaceClangdConfig(root);
      this.broadcastIndexProgress({ rootPath: root, phase: "starting" });
      const cpu = Math.max(4, Math.min(16, osCpus()));
      const args = [
        `--compile-commands-dir=${db.compileCommandsDir}`,
        "--background-index",
        // `low` (clangd's default): the background index of ~27k engine
        // TUs must not starve the preamble build of the file being edited.
        "--background-index-priority=low",
        "--clang-tidy=false",
        // Measured on a UE .cpp: `this->` completion answers in ~0.5s at 20
        // results but exceeds 8s at 50 / 100 (per-item signature/doc work).
        // The list is marked incomplete, so typing re-queries the next 20.
        `--limit-results=${COMPLETION_RESULT_LIMIT}`,
        "--header-insertion=never",
        // Default decorators prefix every completion label with " " / "•".
        "--header-insertion-decorators=false",
        // UE preambles are ~100MB: keep them in temp files, not RAM. clangd
        // deletes them on exit, so each app start rebuilds once per file.
        "--pch-storage=disk",
        `-j=${cpu}`,
        "--log=error",
      ];
      const startedAt = Date.now();
      agentLogInfo("clangd.start", {
        root,
        clangdPath,
        compileCommandsDir: db.compileCommandsDir,
        args,
      });
      const conn = await LspConnection.start(
        clangdPath,
        args,
        // clangdFileStatus: per-document "parsing includes" / "parsing main
        // file" notifications — the only signal for preamble build progress.
        { rootUri: toUri(root), initializationOptions: { clangdFileStatus: true } },
        root,
        (line) => {
          // Only surface server-side failures; progress spam stays silent.
          if (/^E\[/.test(line)) agentLogWarn("clangd.server", { root, line });
        },
      ).catch(() => null);
      if (!conn) {
        agentLogWarn("clangd.start_failed", { root, ms: Date.now() - startedAt });
        this.broadcastIndexProgress({
          rootPath: root,
          phase: "failed",
          message: "clangd failed to start",
        });
        return null;
      }
      agentLogInfo("clangd.ready", { root, startupMs: Date.now() - startedAt });
      this.broadcastIndexProgress({ rootPath: root, phase: "ready" });
      conn.onNotification = (method, params) =>
        this.onServerNotification(root, method, params);
      const session: Session = {
        root,
        clangdPath,
        compileCommandsDir: db.compileCommandsDir,
        engineRoot: db.engineRoot,
        conn,
        docs: new Map(),
        uhtWatcher: this.startUhtWatcher(root, conn),
        warm: true,
        inspector: new CompileDbInspector(db.compileCommandsDir),
        fileBuilds: new Map(),
        indexStartedAt: null,
        indexCompletion: new ClangdIndexCompletion({
          query: (query) => this.workspaceSymbolQuery(session, query),
          readLines: (path) => this.readLinesCached(path),
        }),
        indexReady: false,
        probeUri: toUri(`${root}/${INDEX_PROBE_NAME}`),
      };
      this.session = session;
      this.startIndexWarmup(session, startedAt);
      return session;
    })();
    try {
      return await this.starting;
    } finally {
      this.starting = null;
    }
  }

  /**
   * Seed `<root>/.clangd` with the MSVC STL workaround when the workspace
   * has none of its own (never overwrite a user config).
   */
  private writeWorkspaceClangdConfig(root: string): void {
    const configPath = root + "/.clangd";
    if (existsSync(configPath)) return;
    try {
      writeFileSync(
        configPath,
        [
          "# Generated by JellyBot (clangd semantic engine). Safe to commit or edit.",
          "CompileFlags:",
          "  Add: [-D_ALLOW_COMPILER_AND_STL_VERSION_MISMATCH]",
          "",
        ].join("\n"),
        "utf8",
      );
    } catch {
      // Read-only workspace — the flag only affects MSVC STL diagnostics.
    }
  }

  /**
   * Watch UHT outputs: `Intermediate/**.generated.h` regenerate on every
   * build and clangd must re-index them, and modules get stale after UHT
   * adds new reflection code.
   */
  private startUhtWatcher(root: string, conn: LspConnection): FSWatcher | null {
    if (process.platform !== "win32") return null; // recursive watch is win/darwin only
    const intermediate = root + "/Intermediate/Build";
    try {
      const watcher = watch(intermediate, { recursive: true }, (_kind, filename) => {
        const name = String(filename ?? "");
        if (!/\.generated\.h$/i.test(name) && !/\.gen\.cpp$/i.test(name)) return;
        const changed = root + "/Intermediate/Build/" + name.replace(/\\/g, "/");
        conn.notify("workspace/didChangeWatchedFiles", {
          changes: [{ uri: toUri(changed), type: 2 }],
        });
      });
      watcher.on("error", () => {
        /* build dirs may be deleted/recreated mid-build */
      });
      return watcher;
    } catch {
      return null; // Intermediate/Build not present yet
    }
  }

  private stopSession(): void {
    const session = this.session;
    this.session = null;
    if (!session) return;
    try {
      session.uhtWatcher?.close();
    } catch {
      // Already closed.
    }
    session.conn.dispose();
  }

  /**
   * clangd `$/progress` → renderer events. Background indexing streams
   * begin/report/end under an opaque token; only `indexing` titles are
   * surfaced (preamble building progress is too chatty to be useful).
   */
  private onServerNotification(root: string, method: string, params: unknown): void {
    if (!params || typeof params !== "object") return;
    if (this.session?.root !== root) return;
    if (method === "textDocument/clangd.fileStatus") {
      const uri = (params as { uri?: unknown }).uri;
      const state = (params as { state?: unknown }).state;
      if (typeof uri !== "string" || typeof state !== "string") return;
      if (uri === this.session.probeUri) return;
      const build = fileBuildStateOf(state);
      if (build === null) return;
      this.trackFileBuild(this.session, uri, build);
      this.broadcastIndexProgress({ rootPath: root, phase: "file", path: fromUri(uri), state: build });
      return;
    }
    if (method !== "$/progress") return;
    const value = (params as { value?: unknown }).value;
    if (!value || typeof value !== "object") return;
    const kind = (value as { kind?: unknown }).kind;
    const title = (value as { title?: unknown }).title;
    if (kind === "begin") {
      if (typeof title !== "string" || !/^indexing/i.test(title)) return;
      this.session.indexStartedAt = Date.now();
      agentLogInfo("clangd.index_begin", { root });
      this.broadcastIndexProgress({ rootPath: root, phase: "indexing" });
      return;
    }
    if (kind === "report") {
      const message = (value as { message?: unknown }).message;
      const percentage = (value as { percentage?: unknown }).percentage;
      // Only index reports carry a message; preamble/other tokens stay quiet.
      if (typeof message !== "string") return;
      this.broadcastIndexProgress({
        rootPath: root,
        phase: "indexing",
        ...(typeof percentage === "number"
          ? { percent: Math.round(percentage) }
          : {}),
        message,
      });
      return;
    }
    if (kind === "end") {
      // clangd ends the token once the full background index is built.
      if (this.session.indexStartedAt !== null) {
        agentLogInfo("clangd.index_done", {
          root,
          ms: Date.now() - this.session.indexStartedAt,
        });
        this.session.indexStartedAt = null;
      }
      this.broadcastIndexProgress({ rootPath: root, phase: "idle" });
    }
  }

  /**
   * Open the virtual probe document so clangd loads the compile database and
   * starts pulling index shards right now, then poll until the index answers
   * (status bar: `loading index… Ns`).
   */
  private startIndexWarmup(session: Session, startedAt: number): void {
    session.conn.notify("textDocument/didOpen", {
      textDocument: { uri: session.probeUri, languageId: "cpp", version: 1, text: "int JellyBotIndexProbe;\n" },
    });
    this.broadcastIndexProgress({ rootPath: session.root, phase: "index_loading" });
    // Shards stream in engine-first, so "any symbol" fires far too early:
    // wait until classes that live in the workspace itself are answerable.
    let markers: string[] = [];
    void session.inspector
      .sourceBasenames()
      .then((basenames) => {
        markers = pickWorkspaceMarkerClasses(session.root, basenames);
      })
      .catch(() => {});
    const rootKey = `${session.root.toLowerCase()}/`;
    // clangd exposes no "shards loaded" signal (LSP or log), and a marker
    // whose TU was never indexed would wait forever — so any one marker
    // answering from the workspace counts as "workspace index in memory".
    const markerReady = async (): Promise<boolean> => {
      for (const marker of markers) {
        const hits = await this.workspaceSymbolQuery(session, `::${marker}`).catch(() => []);
        const found = hits.some(
          (hit) =>
            hit.name === marker &&
            hit.path.replace(/\\/g, "/").toLowerCase().startsWith(rootKey),
        );
        if (found) return true;
      }
      return false;
    };
    // No usable marker (or none ever indexed): macros (SymbolKind 15) come
    // from the probe's own forced Definitions.h, never from on-disk shards.
    const anySymbolReady = async (): Promise<boolean> => {
      const hits = await this.workspaceSymbolQuery(session, "U").catch(() => []);
      return hits.some((hit) => hit.kind !== MACRO_SYMBOL_KIND);
    };
    const poll = async (): Promise<void> => {
      if (this.session !== session) return;
      const useMarkers = markers.length > 0 && Date.now() - startedAt < INDEX_MARKER_GIVE_UP_MS;
      const ready = useMarkers ? await markerReady() : await anySymbolReady();
      if (this.session !== session) return;
      if (ready) {
        session.indexReady = true;
        session.indexCompletion.reset();
        session.conn.notify("textDocument/didClose", { textDocument: { uri: session.probeUri } });
        agentLogInfo("clangd.index_loaded", { root: session.root, ms: Date.now() - startedAt });
        this.broadcastIndexProgress({ rootPath: session.root, phase: "index_ready" });
        return;
      }
      if (Date.now() - startedAt > INDEX_READY_GIVE_UP_MS) {
        agentLogWarn("clangd.index_load_timeout", { root: session.root });
        this.broadcastIndexProgress({ rootPath: session.root, phase: "index_ready" });
        return;
      }
      setTimeout(() => void poll(), INDEX_READY_POLL_MS);
    };
    setTimeout(() => void poll(), INDEX_READY_POLL_MS);
  }

  private async workspaceSymbolQuery(
    session: Session,
    query: string,
  ): Promise<{ name: string; kind: number; containerName?: string; path: string; line: number }[]> {
    // clangd's `limit` extension: --limit-results (completion) would cap it.
    const raw = await session.conn.request("workspace/symbol", { query, limit: 100 }, 3_000);
    const list = Array.isArray(raw) ? raw : [];
    const out: { name: string; kind: number; containerName?: string; path: string; line: number }[] = [];
    for (const item of list as unknown[]) {
      const loc = toLocation((item as { location?: unknown })?.location);
      const name = (item as { name?: unknown })?.name;
      const kind = (item as { kind?: unknown })?.kind;
      if (!loc || typeof name !== "string" || typeof kind !== "number") continue;
      const container = (item as { containerName?: unknown })?.containerName;
      out.push({
        name,
        kind,
        path: loc.path,
        line: loc.line,
        ...(typeof container === "string" && container ? { containerName: container } : {}),
      });
    }
    return out;
  }

  private readonly lineCache = new Map<string, { mtimeMs: number; lines: string[] }>();

  private async readLinesCached(path: string): Promise<string[] | null> {
    try {
      const { mtimeMs } = await statAsync(path);
      const cached = this.lineCache.get(path);
      if (cached && cached.mtimeMs === mtimeMs) return cached.lines;
      const lines = (await readFileAsync(path, "utf8")).split(/\r?\n/);
      if (this.lineCache.size > 64) this.lineCache.clear();
      this.lineCache.set(path, { mtimeMs, lines });
      return lines;
    } catch {
      return null;
    }
  }

  /**
   * Members from the persistent index (own class → bases, engine included).
   * Shards stream in while loading, so partial answers are fine; [] on
   * timeout or without a running session — never spawns clangd per keystroke.
   */
  async indexComplete(rootPath: string, request: CppCompletionRequest): Promise<CppCompletionHit[]> {
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    const session = this.session;
    if (!session || session.root !== root) return [];
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        session.indexCompletion.complete(request),
        new Promise<CppCompletionHit[]>((resolve) => {
          timer = setTimeout(() => resolve([]), INDEX_COMPLETE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * FileStatus transitions → one `clangd.preamble` / `clangd.parse` line per
   * finished phase with its wall-clock duration (the cold-start cost Rider
   * hides behind persistent caches).
   */
  private trackFileBuild(session: Session, uri: string, next: ClangdFileBuildState): void {
    const prev = session.fileBuilds.get(uri);
    if (prev?.state === next) return;
    const now = Date.now();
    if (prev) {
      agentLogInfo(prev.state === "preamble" ? "clangd.preamble" : "clangd.parse", {
        path: fromUri(uri),
        ms: now - prev.since,
      });
    }
    if (next === "idle") session.fileBuilds.delete(uri);
    else session.fileBuilds.set(uri, { state: next, since: now });
  }

  private readonly completionStats: CompletionStats = {
    samples: [],
    errors: 0,
    cancelled: 0,
    windowStart: Date.now(),
  };

  /** Record one completion round-trip; flush p50/p90/max every 50 or 60s. */
  private recordCompletion(ms: number | null, outcome: "ok" | "error" | "cancelled"): void {
    const stats = this.completionStats;
    if (outcome === "ok" && ms !== null) stats.samples.push(ms);
    else if (outcome === "error") stats.errors += 1;
    else stats.cancelled += 1;
    const total = stats.samples.length + stats.errors + stats.cancelled;
    if (
      total < COMPLETION_STATS_FLUSH_COUNT &&
      Date.now() - stats.windowStart < COMPLETION_STATS_FLUSH_MS
    ) {
      return;
    }
    const sorted = [...stats.samples].sort((a, b) => a - b);
    const pick = (q: number) =>
      sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
    agentLogInfo("clangd.completion_stats", {
      requests: total,
      ok: sorted.length,
      errors: stats.errors,
      cancelled: stats.cancelled,
      p50Ms: pick(0.5),
      p90Ms: pick(0.9),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
    });
    stats.samples = [];
    stats.errors = 0;
    stats.cancelled = 0;
    stats.windowStart = Date.now();
  }

  stop(): void {
    this.stopSession();
  }

  stopIfRoot(rootPath: string): void {
    if (!this.session) return;
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (this.session.root === root) this.stopSession();
  }

  // ------------------------------------------------------------ doc sync

  private syncDoc(session: Session, path: string, text: string): void {
    const uri = toUri(path);
    const existing = session.docs.get(uri);
    if (existing) {
      if (existing.text === text) return;
      existing.text = text;
      existing.version += 1;
      session.conn.notify("textDocument/didChange", {
        textDocument: { uri, version: existing.version },
        contentChanges: [{ text }],
      });
      return;
    }
    session.docs.set(uri, { text, version: 1 });
    session.conn.notify("textDocument/didOpen", {
      textDocument: { uri, languageId: "cpp", version: 1, text },
    });
    void session.inspector
      .inspect(path)
      .then((summary) => {
        if (!summary) {
          agentLogInfo("clangd.compile_flags", { path, inDatabase: false });
          return;
        }
        agentLogInfo("clangd.compile_flags", { path, inDatabase: true, ...summary });
      })
      .catch(() => {});
  }

  docChanged(rootPath: string, path: string, text: string): void {
    if (typeof rootPath !== "string" || typeof path !== "string" || typeof text !== "string") return;
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (this.session?.root === root) {
      this.syncDoc(this.session, path, text);
      return;
    }
    // Opened before (or while) clangd starts: start / await it so the
    // preamble build begins now, not on the first completion keystroke.
    void this.ensure(rootPath)
      .then((session) => {
        // A query may have synced a newer buffer meanwhile — never roll back.
        if (
          session && session.root === root && this.session === session &&
          !session.docs.has(toUri(path))
        ) {
          this.syncDoc(session, path, text);
        }
      })
      .catch(() => {});
  }

  docClosed(rootPath: string, path: string): void {
    if (!this.session) return;
    const root = rootPath.replace(/\\/g, "/").replace(/\/+$/, "");
    if (this.session.root !== root) return;
    const uri = toUri(path);
    if (!this.session.docs.delete(uri)) return;
    this.session.conn.notify("textDocument/didClose", { textDocument: { uri } });
  }

  // ------------------------------------------------------------- queries

  private async query(
    rootPath: string,
    request: ClangdPositionRequest,
    method: "textDocument/references" | "textDocument/definition" | "textDocument/hover" | "textDocument/completion" | "textDocument/signatureHelp",
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const session = await this.ensure(rootPath);
    if (!session) {
      throw new Error(
        "clangd unavailable for this workspace (missing binary or compile_commands.json).",
      );
    }
    const resolved = await this.resolveColumn(request);
    if (!resolved) throw new Error("Position could not be resolved (file unreadable or line out of range).");
    // Always open/sync the document — clangd refuses AST queries for
    // non-added files, and unsaved edits override disk text when present.
    const text = typeof request.text === "string" ? request.text : resolved.text;
    this.syncDoc(session, request.path, text);
    const timeout = timeoutMs;
    session.warm = false;
    return await session.conn.request(
      method,
      {
        textDocument: { uri: toUri(request.path) },
        position: { line: resolved.line, character: resolved.character },
        ...params,
      },
      timeout,
      signal,
    );
  }

  /** Abort a named in-flight query (renderer ESC). False when unknown/done. */
  cancelQuery(queryId: string): boolean {
    const controller = this.queryCancellers.get(queryId);
    if (!controller) return false;
    this.queryCancellers.delete(queryId);
    controller.abort();
    return true;
  }

  async references(
    rootPath: string,
    request: ClangdPositionRequest,
  ): Promise<ClangdReferencesResult> {
    try {
      const raw = await this.query(rootPath, request, "textDocument/references", {
        context: { includeDeclaration: true },
      }, REFERENCES_TIMEOUT_MS);
      const list = Array.isArray(raw) ? raw : [];
      const references = list
        .map(toLocation)
        .filter((loc): loc is ClangdLocation => loc !== null);
      return { ok: true, references };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async definition(
    rootPath: string,
    request: ClangdPositionRequest,
    queryId?: string,
  ): Promise<ClangdDefinitionResult> {
    let controller: AbortController | null = null;
    if (typeof queryId === "string" && queryId) {
      controller = new AbortController();
      this.queryCancellers.set(queryId, controller);
    }
    try {
      const raw = await this.query(
        rootPath,
        request,
        "textDocument/definition",
        {},
        DEFINITION_TIMEOUT_MS,
        controller?.signal,
      );
      const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
      const definitions = (list as unknown[])
        .map(toLocation)
        .filter((loc): loc is ClangdLocation => loc !== null);
      return { ok: true, definitions };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (controller && typeof queryId === "string") this.queryCancellers.delete(queryId);
    }
  }

  /**
   * `workspace/symbol` — whole-index symbol lookup. Backs Quick Open's
   * symbol search; catches macro-generated types (UHT delegates, UCLASS
   * expansions) the text scanner structurally cannot see.
   */
  async workspaceSymbols(
    rootPath: string,
    query: string,
  ): Promise<ClangdWorkspaceSymbolsResult> {
    if (typeof query !== "string" || !query.trim()) {
      return { ok: true, symbols: [] };
    }
    let session: Session | null = null;
    try {
      session = await this.ensure(rootPath);
      if (!session) return { ok: false, message: "clangd unavailable for this workspace." };
      const raw = await session.conn.request("workspace/symbol", { query, limit: 50 }, 15_000);
      const list = Array.isArray(raw) ? raw : [];
      const symbols: ClangdWorkspaceSymbol[] = [];
      for (const item of list as unknown[]) {
        const loc = toLocation((item as { location?: unknown })?.location);
        const name = (item as { name?: unknown })?.name;
        if (!loc || typeof name !== "string" || !name.trim()) continue;
        const container = (item as { containerName?: unknown })?.containerName;
        symbols.push({
          name,
          path: loc.path,
          line: loc.line,
          column: loc.column,
          symbolKind: symbolKindName((item as { kind?: unknown })?.kind),
          ...(typeof container === "string" && container ? { container } : {}),
        });
        if (symbols.length >= 50) break;
      }
      return { ok: true, symbols };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async hover(rootPath: string, request: ClangdPositionRequest): Promise<ClangdHoverResult> {
    try {
      const raw = await this.query(rootPath, request, "textDocument/hover", {}, INTERACTIVE_TIMEOUT_MS);
      if (!raw || typeof raw !== "object") return { ok: true, markdown: null };
      const contents = (raw as { contents?: unknown }).contents;
      if (typeof contents === "string") return { ok: true, markdown: contents };
      if (contents && typeof contents === "object") {
        const value = (contents as { value?: unknown }).value;
        if (typeof value === "string") return { ok: true, markdown: value };
      }
      return { ok: true, markdown: null };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  async completion(
    rootPath: string,
    request: ClangdPositionRequest,
    queryId?: string,
  ): Promise<ClangdCompletionResult> {
    // Every keystroke supersedes the previous request; the renderer cancels
    // stale ones so clangd does not work through a backlog.
    let controller: AbortController | null = null;
    if (typeof queryId === "string" && queryId) {
      controller = new AbortController();
      this.queryCancellers.set(queryId, controller);
    }
    const startedAt = Date.now();
    try {
      const trigger =
        typeof request.triggerCharacter === "string" && request.triggerCharacter
          ? request.triggerCharacter
          : null;
      const raw = await this.query(rootPath, request, "textDocument/completion", {
        context: trigger
          ? { triggerKind: 2, triggerCharacter: trigger }
          : { triggerKind: 1 },
      }, INTERACTIVE_TIMEOUT_MS, controller?.signal);
      this.recordCompletion(Date.now() - startedAt, "ok");
      return { ok: true, ...parseCompletionList(raw) };
    } catch (err) {
      this.recordCompletion(null, controller?.signal.aborted ? "cancelled" : "error");
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    } finally {
      if (controller && typeof queryId === "string") this.queryCancellers.delete(queryId);
    }
  }

  async signatureHelp(
    rootPath: string,
    request: ClangdPositionRequest,
  ): Promise<ClangdSignatureHelpResult> {
    try {
      const raw = await this.query(rootPath, request, "textDocument/signatureHelp", {}, INTERACTIVE_TIMEOUT_MS);
      return parseSignatureHelp(raw);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

/**
 * Index-readiness markers: workspace classes following the Unreal naming
 * convention (`AFooBar` declared in `FooBar.h`, which forward declarations
 * never satisfy) whose `FooBar.cpp` is a translation unit in the compile
 * database — so clangd's index must know them once workspace shards load.
 */
function pickWorkspaceMarkerClasses(root: string, compiledBasenames: ReadonlySet<string>): string[] {
  let db: ReturnType<typeof openCppSymbolDatabase> | null = null;
  try {
    db = openCppSymbolDatabase(cppSymbolDatabasePath(root), { readOnly: true });
    const rows = db
      .prepare(
        `SELECT name FROM symbols
         WHERE kind IN ('class', 'struct') AND is_impl = 0
           AND path LIKE :root AND path NOT LIKE '%/Intermediate/%'
           AND length(name) > 3
           AND path LIKE '%/' || substr(name, 2) || '.h'
         LIMIT 400`,
      )
      .all({ root: `${normalizeSymbolPath(root)}/%` }) as { name?: unknown }[];
    const out: string[] = [];
    for (const row of rows) {
      if (typeof row.name !== "string") continue;
      if (!compiledBasenames.has(`${row.name.slice(1).toLowerCase()}.cpp`)) continue;
      out.push(row.name);
      if (out.length >= 5) break;
    }
    return out;
  } catch {
    return [];
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}

/**
 * clangd FileStatus text (`parsing includes, running Update`, `parsing main
 * file`, `idle`, `file is queued`, …) → status-bar build state. `null` for
 * transient states (queued / running an action) that should not flicker.
 */
function fileBuildStateOf(state: string): ClangdFileBuildState | null {
  if (/parsing includes/i.test(state)) return "preamble";
  if (/parsing main file/i.test(state)) return "parsing";
  if (/^\s*idle\s*$/i.test(state)) return "idle";
  return null;
}

/** LSP CompletionList | CompletionItem[] → bridge items. */
function parseCompletionList(raw: unknown): {
  items: ClangdCompletionItem[];
  isIncomplete: boolean;
} {
  const list = raw && typeof raw === "object" && !Array.isArray(raw)
    ? (raw as { items?: unknown; isIncomplete?: unknown })
    : null;
  const items = Array.isArray(raw) ? raw : Array.isArray(list?.items) ? list.items : [];
  const mapped: ClangdCompletionItem[] = [];
  for (const item of items as unknown[]) {
    if (!item || typeof item !== "object") continue;
    const it = item as {
      label?: unknown;
      kind?: unknown;
      detail?: unknown;
      documentation?: unknown;
      labelDetails?: { detail?: unknown };
      insertText?: unknown;
      insertTextFormat?: unknown;
      textEdit?: { newText?: unknown };
      sortText?: unknown;
      filterText?: unknown;
    };
    if (typeof it.label !== "string") continue;
    // Older clangd / decorators left on: strip the leading " " / "•".
    const label = it.label.replace(/^[\s\u2022]+/, "").trim();
    if (!label) continue;
    const documentation = plainDocumentation(it.documentation);
    const signature =
      it.labelDetails && typeof it.labelDetails.detail === "string" && it.labelDetails.detail.trim()
        ? it.labelDetails.detail
        : undefined;
    const insertText =
      it.textEdit && typeof it.textEdit.newText === "string"
        ? it.textEdit.newText
        : typeof it.insertText === "string"
          ? it.insertText
          : undefined;
    mapped.push({
      label,
      kind: typeof it.kind === "number" ? it.kind : 0,
      ...(typeof it.detail === "string" && it.detail.trim() ? { detail: it.detail.trim() } : {}),
      ...(documentation !== undefined ? { documentation } : {}),
      ...(signature !== undefined ? { signature } : {}),
      ...(insertText !== undefined ? { insertText } : {}),
      ...(insertText !== undefined && it.insertTextFormat === 2 ? { isSnippet: true } : {}),
      ...(typeof it.sortText === "string" && it.sortText ? { sortText: it.sortText } : {}),
      ...(typeof it.filterText === "string" && it.filterText ? { filterText: it.filterText } : {}),
    });
    if (mapped.length >= 200) break;
  }
  const isIncomplete = list?.isIncomplete === true || items.length > 200;
  return { items: mapped, isIncomplete };
}

/** LSP SymbolKind → the scanner-style kind strings Quick Open renders. */
function symbolKindName(kind: unknown): string {
  switch (typeof kind === "number" ? kind : 0) {
    case 5: return "class";
    case 23: return "struct";
    case 10: case 22: return "enum";
    case 11: return "interface";
    case 6: case 9: case 3: case 12: return "function";
    case 13: case 8: return "type";
    default: return "class";
  }
}

function osCpus(): number {
  try {
    return cpus().length;
  } catch {
    return 4;
  }
}

/** Exported for tests. */
export const __testing = { toUri, fromUri, toLocation, parseCompletionList, fileBuildStateOf };
