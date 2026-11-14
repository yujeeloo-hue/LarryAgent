import { Worker } from "node:worker_threads";
import { stat } from "node:fs/promises";
import workerPath from "./symbolScan.worker?modulePath";
import usageWorkerPath from "./usageSearch.worker?modulePath";
import { agentLogWarn } from "../../logging/agentLog.js";
import type { DevModeFsEvent } from "../devModeFs.js";
import { isSymbolIndexablePath } from "../../renderer/src/devmode/cppSymbolIndex.js";
import {
  openCppSymbolDatabase,
  listIndexedPaths,
  lookupCppSymbolsFromFile,
  readCppExtraRoots,
  writeCppExtraRoots,
} from "./db.js";
import { ensureCppSymbolGitignored } from "./gitignore.js";
import { cppSymbolDatabasePath, normalizeSymbolPath } from "./paths.js";
import { CppCompletionIndex } from "./complete.js";
import type { CppSymbolDatabase } from "./db.js";
import type {
  CppCompletionHit,
  CppCompletionRequest,
  CppSymbolHit,
  CppSymbolProgressEvent,
  CppSymbolRootMutationResult,
  CppSymbolRootsResult,
  CppUsageSearchRequest,
  CppUsageSearchResult,
} from "./types.js";

type WorkerOutbound =
  | { type: "progress"; filesDone: number; filesTotal: number }
  | { type: "idle" }
  | { type: "error"; message: string };

/** Windows/macOS fold path case; keep comparisons consistent with the tree. */
const FOLD_CASE = process.platform === "win32" || process.platform === "darwin";

function foldPath(path: string): string {
  return FOLD_CASE ? path.toLowerCase() : path;
}

function isSamePath(a: string, b: string): boolean {
  return foldPath(a) === foldPath(b);
}

/** True when `child` sits strictly inside `parent` (both normalized). */
function isPathUnder(child: string, parent: string): boolean {
  return foldPath(child).startsWith(`${foldPath(parent)}/`);
}

/**
 * One writable scan thread per process. Lookup opens a separate read-only
 * connection so F12 does not wait on the walker.
 */
export class CppSymbolIndexService {
  private worker: Worker | null = null;
  private readonly usageWorkers = new Map<string, Worker>();
  private root: string | null = null;
  private extraRoots: string[] = [];
  /** `root` + extraRoots — detects root-list changes for worker restarts. */
  private signature: string | null = null;
  private filesDone = 0;
  private filesTotal = 0;

  constructor(
    private readonly broadcast: (event: CppSymbolProgressEvent) => void,
  ) {}

  /** Start (or keep) the scan for this workspace. Idempotent per root set. */
  start(rootPath: string): void {
    const root = normalizeSymbolPath(rootPath);
    const extraRoots = this.readPersistedRoots(root);
    const signature = [root, ...extraRoots].join("\n");
    if (this.root === root && this.signature === signature && this.worker) {
      return;
    }
    this.stop();
    this.root = root;
    this.extraRoots = extraRoots;
    this.signature = signature;
    this.filesDone = 0;
    this.filesTotal = 0;
    void ensureCppSymbolGitignored(root);
    let worker: Worker;
    try {
      worker = new Worker(workerPath);
    } catch (err) {
      agentLogWarn("cpp_symbols.worker_start_failed", {
        workspacePath: root,
        message: err instanceof Error ? err.message : String(err),
      });
      this.root = null;
      this.signature = null;
      return;
    }
    this.worker = worker;
    worker.on("message", (msg: WorkerOutbound) => {
      if (this.worker !== worker || this.root !== root) return;
      this.onWorkerMessage(root, msg);
    });
    worker.on("error", (err) => {
      agentLogWarn("cpp_symbols.worker_error", {
        workspacePath: root,
        message: err instanceof Error ? err.message : String(err),
      });
      if (this.worker === worker) this.fail(root);
    });
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
    });
    worker.postMessage({
      type: "start",
      root,
      dbPath: cppSymbolDatabasePath(root),
      extraRoots,
    });
    this.broadcast({
      rootPath: root,
      phase: "scanning",
      filesDone: 0,
      filesTotal: 0,
    });
  }

  stop(): void {
    const root = this.root;
    const worker = this.worker;
    this.worker = null;
    this.root = null;
    this.extraRoots = [];
    this.signature = null;
    worker?.terminate();
    for (const usageWorker of this.usageWorkers.values()) {
      void usageWorker.terminate();
    }
    this.usageWorkers.clear();
    if (root) {
      this.broadcast({
        rootPath: root,
        phase: "idle",
        filesDone: this.filesDone,
        filesTotal: this.filesTotal,
      });
    }
  }

  stopIfRoot(rootPath: string): void {
    if (this.root && normalizeSymbolPath(rootPath) === this.root) this.stop();
  }

  // ---------------------------------------------------------- extra roots

  /** User-added scan roots (engine source directories, …) for display. */
  extraRootsOf(rootPath: string): CppSymbolRootsResult {
    if (typeof rootPath !== "string" || !rootPath.trim()) {
      return { ok: false, message: "Missing workspace path." };
    }
    return { ok: true, extraRoots: this.readPersistedRoots(normalizeSymbolPath(rootPath)) };
  }

  /**
   * Add one directory as an extra scan root and rescan. Rejects anything
   * redundant (the workspace itself, an ancestor of it, or a directory an
   * existing root already covers) so the scan never runs twice over the
   * same tree. A broader new root absorbs narrower roots it contains.
   */
  async addExtraRoot(
    rootPath: string,
    dir: string,
  ): Promise<CppSymbolRootMutationResult> {
    if (typeof rootPath !== "string" || !rootPath.trim()) {
      return { ok: false, message: "Missing workspace path." };
    }
    if (typeof dir !== "string" || !dir.trim()) {
      return { ok: false, message: "Missing directory." };
    }
    const root = normalizeSymbolPath(rootPath);
    const candidate = normalizeSymbolPath(dir);
    if (isSamePath(candidate, root)) {
      return {
        ok: false,
        message: "The workspace root is always indexed.",
      };
    }
    if (isPathUnder(root, candidate)) {
      return {
        ok: false,
        message: "Pick a narrower directory — this one contains the workspace.",
      };
    }
    try {
      const info = await stat(candidate);
      if (!info.isDirectory()) {
        return { ok: false, message: `Not a directory: ${candidate}` };
      }
    } catch {
      return { ok: false, message: `Directory not found: ${candidate}` };
    }
    const current = this.readPersistedRoots(root);
    if (current.some((existing) => isSamePath(existing, candidate))) {
      return { ok: true, extraRoots: current, restarted: false };
    }
    const covering = current.find((existing) => isPathUnder(candidate, existing));
    if (covering) {
      return {
        ok: true,
        extraRoots: current,
        restarted: false,
        message: `Already indexed via ${covering}.`,
      };
    }
    const next = current.filter((existing) => !isPathUnder(existing, candidate));
    next.push(candidate);
    if (!this.persistRoots(root, next)) {
      return {
        ok: false,
        message: "Could not persist the symbol-index root list.",
      };
    }
    const restarted = this.restartIfActive(root);
    return { ok: true, extraRoots: next, restarted };
  }

  /**
   * Remove the root covering `dir` (exact match, else the root that contains
   * it) and rescan — the next scan prunes that tree's symbols.
   */
  async removeExtraRoot(
    rootPath: string,
    dir: string,
  ): Promise<CppSymbolRootMutationResult> {
    if (typeof rootPath !== "string" || !rootPath.trim()) {
      return { ok: false, message: "Missing workspace path." };
    }
    if (typeof dir !== "string" || !dir.trim()) {
      return { ok: false, message: "Missing directory." };
    }
    const root = normalizeSymbolPath(rootPath);
    const target = normalizeSymbolPath(dir);
    const current = this.readPersistedRoots(root);
    const hit =
      current.find((existing) => isSamePath(existing, target)) ??
      current.find((existing) => isPathUnder(target, existing));
    if (!hit) {
      return { ok: true, extraRoots: current, restarted: false };
    }
    const next = current.filter((existing) => !isSamePath(existing, hit));
    if (!this.persistRoots(root, next)) {
      return {
        ok: false,
        message: "Could not persist the symbol-index root list.",
      };
    }
    const restarted = this.restartIfActive(root);
    return { ok: true, extraRoots: next, restarted };
  }

  /** Re-run start() so a running scan picks up the new root list. */
  private restartIfActive(root: string): boolean {
    if (this.root !== root) return false;
    this.start(root);
    return true;
  }

  private readPersistedRoots(root: string): string[] {
    try {
      const db = openCppSymbolDatabase(cppSymbolDatabasePath(root), {
        readOnly: true,
      });
      try {
        return readCppExtraRoots(db);
      } finally {
        db.close();
      }
    } catch {
      return []; // no database yet — first scan creates it
    }
  }

  private persistRoots(root: string, roots: string[]): boolean {
    try {
      const db = openCppSymbolDatabase(cppSymbolDatabasePath(root));
      try {
        writeCppExtraRoots(db, roots);
      } finally {
        db.close();
      }
      return true;
    } catch (err) {
      agentLogWarn("cpp_symbols.roots_persist_failed", {
        workspacePath: root,
        message: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  onFsEvents(payload: DevModeFsEvent): void {
    if (!this.worker || !this.root) return;
    if (normalizeSymbolPath(payload.rootPath) !== this.root) return;
    for (const event of payload.events) {
      const path = normalizeSymbolPath(event.path);
      if (!isSymbolIndexablePath(path)) continue;
      this.worker.postMessage({
        type: event.kind === "unlink" ? "remove" : "upsert",
        path,
      });
    }
  }

  lookup(rootPath: string, word: string): CppSymbolHit[] {
    if (typeof word !== "string") return [];
    return lookupCppSymbolsFromFile(cppSymbolDatabasePath(rootPath), word);
  }

  private completionDb: { path: string; db: CppSymbolDatabase; openedAt: number } | null = null;
  private readonly completionIndex = new CppCompletionIndex();

  /**
   * Keystroke-rate completion: one long-lived read-only handle, reopened
   * periodically so a rebuilt database file is picked up.
   */
  complete(rootPath: string, request: CppCompletionRequest): CppCompletionHit[] {
    const dbPath = cppSymbolDatabasePath(rootPath);
    const cached = this.completionDb;
    if (!cached || cached.path !== dbPath || Date.now() - cached.openedAt > 30_000) {
      try {
        cached?.db.close();
      } catch {
        // Already closed.
      }
      this.completionDb = null;
      try {
        this.completionDb = {
          path: dbPath,
          db: openCppSymbolDatabase(dbPath, { readOnly: true }),
          openedAt: Date.now(),
        };
      } catch {
        return [];
      }
    }
    try {
      return this.completionIndex.complete(this.completionDb!.db, request);
    } catch {
      return [];
    }
  }

  async findUsages(
    rootPath: string,
    request: CppUsageSearchRequest,
  ): Promise<CppUsageSearchResult> {
    const empty = (cancelled = false): CppUsageSearchResult => ({
      queryId: request.queryId,
      matches: [],
      scannedFiles: 0,
      truncated: false,
      ...(cancelled ? { cancelled: true } : {}),
    });
    const word = request.word.trim();
    if (!request.queryId || !/^[A-Za-z_]\w*$/.test(word)) return empty();
    this.cancelFindUsages(request.queryId);

    let paths: string[];
    try {
      const db = openCppSymbolDatabase(cppSymbolDatabasePath(rootPath), {
        readOnly: true,
      });
      try {
        paths = listIndexedPaths(db);
      } finally {
        db.close();
      }
    } catch {
      return empty();
    }

    return await new Promise<CppUsageSearchResult>((resolve) => {
      let settled = false;
      const worker = new Worker(usageWorkerPath);
      this.usageWorkers.set(request.queryId, worker);
      const finish = (result: CppUsageSearchResult): void => {
        if (settled) return;
        settled = true;
        if (this.usageWorkers.get(request.queryId) === worker) {
          this.usageWorkers.delete(request.queryId);
        }
        void worker.terminate();
        resolve(result);
      };
      worker.on("message", (message: unknown) => {
        if (
          message &&
          typeof message === "object" &&
          "type" in message &&
          message.type === "result" &&
          "result" in message
        ) {
          finish(message.result as CppUsageSearchResult);
        } else {
          finish(empty());
        }
      });
      worker.once("error", () => finish(empty()));
      worker.once("exit", () => finish(empty(true)));
      worker.postMessage({
        queryId: request.queryId,
        word,
        paths,
        ...(request.overlay ? { overlay: request.overlay } : {}),
      });
    });
  }

  cancelFindUsages(queryId: string): void {
    const worker = this.usageWorkers.get(queryId);
    if (!worker) return;
    this.usageWorkers.delete(queryId);
    void worker.terminate();
  }

  private onWorkerMessage(root: string, msg: WorkerOutbound): void {
    if (msg.type === "progress") {
      this.filesDone = msg.filesDone;
      this.filesTotal = msg.filesTotal;
      this.broadcast({
        rootPath: root,
        phase: "scanning",
        filesDone: msg.filesDone,
        filesTotal: msg.filesTotal,
      });
      return;
    }
    if (msg.type === "idle") {
      // The thread stays up so later file watches can upsert one path.
      this.broadcast({
        rootPath: root,
        phase: "idle",
        filesDone: this.filesDone,
        filesTotal: this.filesTotal,
      });
      return;
    }
    agentLogWarn("cpp_symbols.scan_failed", {
      workspacePath: root,
      message: msg.message,
    });
    this.fail(root);
  }

  private fail(root: string): void {
    if (this.root !== root) return;
    const worker = this.worker;
    this.worker = null;
    this.root = null;
    this.broadcast({
      rootPath: root,
      phase: "idle",
      filesDone: this.filesDone,
      filesTotal: this.filesTotal,
    });
    worker?.terminate();
  }
}
