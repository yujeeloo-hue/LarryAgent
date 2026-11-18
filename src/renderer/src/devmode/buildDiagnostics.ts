export type BuildDiagnostic = {
  id: string;
  severity: "error" | "warning";
  code: string | null;
  message: string;
  path: string | null;
  line: number | null;
  column: number | null;
};

function diagnostic(
  severity: string,
  code: string | undefined,
  message: string,
  path?: string,
  line?: string,
  column?: string,
): BuildDiagnostic {
  const normalizedPath = path?.trim().replace(/^(["'])(.*)\1$/, "$2").replace(/\\/g, "/") ?? null;
  const item = {
    severity: /error/i.test(severity) ? "error" as const : "warning" as const,
    code: code?.toUpperCase() || null,
    message: message.trim().replace(/\s+\[[^\]]+\.(?:vcxproj|csproj|fsproj)\]\s*$/i, ""),
    path: normalizedPath,
    line: line && Number(line) > 0 ? Number(line) : null,
    column: column && Number(column) > 0 ? Number(column) : null,
  };
  const pathKey = normalizedPath && /^(?:[A-Za-z]:\/|\/\/)/.test(normalizedPath)
    ? normalizedPath.toLowerCase() : normalizedPath;
  return { id: JSON.stringify([item.severity, pathKey, item.line, item.column, item.code, item.message]), ...item };
}

export function parseBuildDiagnostic(raw: string): BuildDiagnostic | null {
  const text = raw
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim()
    .replace(/^(?:\d+>\s*|\[\d+\/\d+\]\s*)+/, "");
  const msvc = /^(.+)\((\d+)(?:,\s*(\d+))?(?:,\s*\d+,\s*\d+)?\)\s*:\s*(fatal\s+error|error|warning)\s*([A-Za-z]+\d+)?\s*:\s*(.+)$/i.exec(text);
  if (msvc) return diagnostic(msvc[4]!, msvc[5], msvc[6]!, msvc[1], msvc[2], msvc[3]);
  const clang = /^(.+):(\d+):(\d+):\s*(fatal\s+error|error|warning)\s*:\s*(.+)$/i.exec(text);
  if (clang) return diagnostic(clang[4]!, undefined, clang[5]!, clang[1], clang[2], clang[3]);
  const lineOnly = /^(.+):(\d+):\s*(fatal\s+error|error|warning)\s*:\s*(.+)$/i.exec(text);
  if (lineOnly) return diagnostic(lineOnly[3]!, undefined, lineOnly[4]!, lineOnly[1], lineOnly[2]);
  const general = /^(?:.+?\s*:\s*)?(?:command\s+line\s+)?(fatal\s+error|error|warning)(?:\s+([A-Za-z]+\d+))?\s*:\s*(.+)$/i.exec(text);
  return general ? diagnostic(general[1]!, general[2], general[3]!) : null;
}

export function createBuildDiagnosticsParser() {
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  const items: BuildDiagnostic[] = [];
  const consume = (line: string, added: BuildDiagnostic[]): void => {
    const item = parseBuildDiagnostic(line);
    if (!item || seen.has(item.id)) return;
    seen.add(item.id); items.push(item); added.push(item);
  };
  return {
    feed(text: string, stream = "stdout"): BuildDiagnostic[] {
      const lines = ((pending.get(stream) ?? "") + text).split(/\r\n|\r|\n/);
      pending.set(stream, lines.pop() ?? "");
      const added: BuildDiagnostic[] = [];
      for (const line of lines) consume(line, added);
      return added;
    },
    flush(): BuildDiagnostic[] {
      const added: BuildDiagnostic[] = [];
      for (const line of pending.values()) consume(line, added);
      pending.clear();
      return added;
    },
    snapshot(): readonly BuildDiagnostic[] { return items; },
    reset(): void { pending.clear(); seen.clear(); items.length = 0; },
  };
}
