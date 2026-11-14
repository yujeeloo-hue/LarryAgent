/** Mirrors `DiffLine` from src/tools/lineDiff.ts for the renderer. */
export type DiffLine = {
  kind: "equal" | "add" | "del";
  text: string;
  oldLine: number | null;
  newLine: number | null;
};

export function parseDiffLinesJson(raw: string): DiffLine[] | null {
  try {
    const parsed = JSON.parse(raw) as { lines?: unknown };
    if (!parsed || !Array.isArray(parsed.lines)) return null;
    const lines: DiffLine[] = [];
    for (const item of parsed.lines) {
      if (!item || typeof item !== "object") return null;
      const row = item as Record<string, unknown>;
      const kind = row.kind;
      if (kind !== "equal" && kind !== "add" && kind !== "del") return null;
      if (typeof row.text !== "string") return null;
      lines.push({
        kind,
        text: row.text,
        oldLine: typeof row.oldLine === "number" ? row.oldLine : null,
        newLine: typeof row.newLine === "number" ? row.newLine : null,
      });
    }
    return lines;
  } catch {
    return null;
  }
}
