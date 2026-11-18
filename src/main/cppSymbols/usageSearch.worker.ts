import { parentPort } from "node:worker_threads";
import { readFile, stat } from "node:fs/promises";
import type { CppUsageCandidate, CppUsageSearchResult } from "./types.js";
import { scanCppUsageText } from "./usageSearch.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_MATCHES = 5000;

type UsageWorkerRequest = {
  queryId: string;
  word: string;
  paths: string[];
  overlay?: { path: string; text: string };
};

if (!parentPort) throw new Error("C++ usage worker requires parentPort");

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/");
}

async function run(request: UsageWorkerRequest): Promise<CppUsageSearchResult> {
  const matches: CppUsageCandidate[] = [];
  const overlayPath = request.overlay
    ? normalizePath(request.overlay.path)
    : null;
  let scannedFiles = 0;
  let truncated = false;

  for (const rawPath of request.paths) {
    const path = normalizePath(rawPath);
    let text: string | null = null;
    if (overlayPath === path) {
      text = request.overlay!.text;
    } else {
      try {
        const info = await stat(path);
        if (!info.isFile() || info.size > MAX_FILE_BYTES) continue;
        text = await readFile(path, "utf8");
      } catch {
        continue;
      }
    }
    scannedFiles += 1;
    const scanned = scanCppUsageText(
      path,
      text,
      request.word,
      MAX_MATCHES - matches.length,
    );
    matches.push(...scanned.matches);
    if (scanned.truncated || matches.length >= MAX_MATCHES) {
      truncated = true;
      break;
    }
  }

  return {
    queryId: request.queryId,
    matches,
    scannedFiles,
    truncated,
  };
}

parentPort.once("message", (request: UsageWorkerRequest) => {
  void run(request)
    .then((result) => parentPort!.postMessage({ type: "result", result }))
    .catch((error) =>
      parentPort!.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      }),
    );
});
