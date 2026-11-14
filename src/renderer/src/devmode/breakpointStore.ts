/**
 * Per-workspace breakpoint memory (renderer localStorage).
 * Convention: jellybot.* keys, same as other Dev Mode chrome prefs.
 */
const KEY_PREFIX = "jellybot.debug.breakpoints.";

export type StoredBreakpoint = {
  path: string;
  line: number;
  condition: string;
  enabled: boolean;
};

export type BreakpointValue = {
  condition: string;
  enabled: boolean;
};

function norm(path: string): string {
  return path.replace(/\\/g, "/");
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function serializeBreakpoints(
  map: Map<string, Map<number, BreakpointValue>>,
): StoredBreakpoint[] {
  const out: StoredBreakpoint[] = [];
  for (const [path, lines] of map) {
    const file = norm(path).trim();
    if (!file) continue;
    for (const [line, value] of lines) {
      if (!Number.isInteger(line) || line <= 0) continue;
      out.push({
        path: file,
        line,
        condition:
          typeof value?.condition === "string" ? value.condition : "",
        enabled: value?.enabled !== false,
      });
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
  return out;
}

export function parseBreakpoints(
  raw: unknown,
): Map<string, Map<number, BreakpointValue>> {
  const map = new Map<string, Map<number, BreakpointValue>>();
  const rows = Array.isArray(raw)
    ? raw
    : raw &&
        typeof raw === "object" &&
        Array.isArray((raw as { breakpoints?: unknown }).breakpoints)
      ? (raw as { breakpoints: unknown[] }).breakpoints
      : [];
  for (const item of rows) {
    if (typeof item !== "object" || item === null) continue;
    const path = norm(String((item as { path?: unknown }).path ?? "")).trim();
    const line = (item as { line?: unknown }).line;
    const condition = (item as { condition?: unknown }).condition;
    const enabled = (item as { enabled?: unknown }).enabled;
    if (!path || !Number.isInteger(line) || (line as number) <= 0) continue;
    const lines = map.get(path) ?? new Map<number, BreakpointValue>();
    lines.set(
      line as number,
      {
        condition: typeof condition === "string" ? condition : "",
        // Version 1 rows did not have this field and were always active.
        enabled: enabled !== false,
      },
    );
    map.set(path, lines);
  }
  return map;
}

export function loadBreakpoints(
  workspacePath: string | null | undefined,
): Map<string, Map<number, BreakpointValue>> {
  const root = workspacePath?.trim();
  if (!root) return new Map();
  const store = storage();
  if (!store) return new Map();
  try {
    const raw = store.getItem(`${KEY_PREFIX}${norm(root)}`);
    if (!raw) return new Map();
    return parseBreakpoints(JSON.parse(raw) as unknown);
  } catch {
    return new Map();
  }
}

export function saveBreakpoints(
  workspacePath: string | null | undefined,
  map: Map<string, Map<number, BreakpointValue>>,
): void {
  const root = workspacePath?.trim();
  if (!root) return;
  const store = storage();
  if (!store) return;
  const key = `${KEY_PREFIX}${norm(root)}`;
  try {
    const rows = serializeBreakpoints(map);
    if (rows.length === 0) store.removeItem(key);
    else store.setItem(key, JSON.stringify({ version: 2, breakpoints: rows }));
  } catch {
    /* quota / private mode */
  }
}
