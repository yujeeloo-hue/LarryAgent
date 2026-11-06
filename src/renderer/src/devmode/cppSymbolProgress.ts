/** English status-bar copy for the background C++ symbol scan. */
export function formatCppSymbolIndexProgress(
  filesDone: number,
  filesTotal: number,
): string {
  if (!Number.isFinite(filesTotal) || filesTotal <= 0) {
    return "Indexing C++ symbols…";
  }
  const done = Math.max(0, Math.floor(filesDone));
  const total = Math.floor(filesTotal);
  return `Indexing C++ symbols… ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}`;
}
