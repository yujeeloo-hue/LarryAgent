/**
 * Background C++ symbol scan. Spawned via electron-vite `?modulePath`.
 * Owns the writable SQLite connection; the main process only reads.
 */
import { parentPort } from "node:worker_threads";
import { openCppSymbolDatabase, type CppSymbolDatabase } from "./db.js";
import { removeCppFileSymbols } from "./db.js";
import { normalizeSymbolPath } from "./paths.js";
import { reindexCppFile, scanCppSymbolDatabase } from "./scanWorkspace.js";

type Inbound =
  | { type: "start"; root: string; dbPath: string; extraRoots?: string[] }
  | { type: "upsert"; path: string }
  | { type: "remove"; path: string }
  | { type: "stop" };

if (!parentPort) {
  throw new Error("C++ symbol worker requires parentPort");
}

const port = parentPort;
let stopped = false;
let started = false;
let db: CppSymbolDatabase | null = null;
const dirty = new Map<string, "upsert" | "remove">();
let wake: (() => void) | null = null;

function poke(): void {
  const resume = wake;
  wake = null;
  resume?.();
}

port.on("message", (msg: Inbound) => {
  if (msg.type === "stop") {
    stopped = true;
    poke();
    return;
  }
  if (msg.type === "start") {
    if (!started) {
      started = true;
      void run(msg.root, msg.dbPath, msg.extraRoots ?? []);
    }
    return;
  }
  const path = normalizeSymbolPath(msg.path);
  dirty.set(path, msg.type === "remove" ? "remove" : "upsert");
  poke();
});

async function drain(): Promise<void> {
  if (!db || dirty.size === 0) return;
  const batch = [...dirty];
  dirty.clear();
  for (const [path, op] of batch) {
    if (stopped) return;
    if (op === "remove") removeCppFileSymbols(db, path);
    else await reindexCppFile(db, path);
  }
}

function waitForWork(): Promise<void> {
  if (stopped || dirty.size > 0) return Promise.resolve();
  return new Promise((resolve) => {
    wake = resolve;
  });
}

async function run(
  root: string,
  dbPath: string,
  extraRoots: string[],
): Promise<void> {
  try {
    db = openCppSymbolDatabase(dbPath);
    await scanCppSymbolDatabase({
      db,
      root,
      extraRoots,
      shouldStop: () => stopped,
      onTick: () => drain(),
      onProgress: (progress) => {
        port.postMessage({ type: "progress", ...progress });
      },
    });
    await drain();
    if (!stopped) {
      port.postMessage({ type: "idle" });
    }
    while (!stopped) {
      await waitForWork();
      if (stopped) break;
      await drain();
    }
  } catch (err) {
    port.postMessage({
      type: "error",
      message: err instanceof Error ? err.message : String(err),
    });
  } finally {
    try {
      db?.close();
    } catch {
      // The process is going away; a failed close is not actionable.
    }
    db = null;
  }
}
