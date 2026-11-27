export function formatCppSymbolIndexProgress(
  filesDone: number,
  filesTotal: number,
): string {
  if (!Number.isFinite(filesTotal) || filesTotal <= 0) {
    return "Scanning symbols…";
  }
  const done = Math.max(0, Math.floor(filesDone));
  const total = Math.floor(filesTotal);
  return `Scanning symbols… ${done.toLocaleString("en-US")} / ${total.toLocaleString("en-US")}`;
}
