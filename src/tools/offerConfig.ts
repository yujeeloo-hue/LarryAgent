/**
 * In-memory tool-offer overrides + Auto-organize baseline.
 * Persisted as `toolOfferOverrides` / `toolOfferAutoBaseline` in tools.json.
 */

/** true = always include, false = defer (until search_tools). */
const overrides = new Map<string, boolean>();

/** Last Auto-organize result (ordered names, ≤ MAX_USER_OFFERED_TOOLS). null = never auto'd. */
let autoBaseline: string[] | null = null;

export function setToolOfferOverride(name: string, include: boolean): void {
  const key = name.trim();
  if (!key) return;
  overrides.set(key, include);
}

export function clearToolOfferOverride(name: string): void {
  overrides.delete(name.trim());
}

export function getToolOfferOverride(name: string): boolean | undefined {
  return overrides.get(name.trim());
}

export function getAllToolOfferOverrides(): Record<string, boolean> {
  return Object.fromEntries(overrides);
}

export function loadToolOfferOverrides(
  entries: Record<string, boolean> | null | undefined,
): void {
  overrides.clear();
  if (!entries) return;
  for (const [name, value] of Object.entries(entries)) {
    const key = name.trim();
    if (!key) continue;
    // MCP tools are always deferred — ignore stale Include overrides.
    if (key.startsWith("mcp__")) continue;
    if (typeof value === "boolean") {
      overrides.set(key, value);
    }
  }
}

export function clearAllToolOfferOverrides(): void {
  overrides.clear();
}

/** Drop overrides whose registry name starts with `prefix` (e.g. MCP server). */
export function clearToolOfferOverridesWithPrefix(prefix: string): string[] {
  if (!prefix) return [];
  const removed: string[] = [];
  for (const name of [...overrides.keys()]) {
    if (name.startsWith(prefix)) {
      overrides.delete(name);
      removed.push(name);
    }
  }
  return removed;
}

export function getToolOfferAutoBaseline(): string[] | null {
  return autoBaseline ? [...autoBaseline] : null;
}

export function setToolOfferAutoBaseline(names: string[] | null): void {
  if (!names || names.length === 0) {
    autoBaseline = null;
    return;
  }
  const cleaned: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const name = typeof raw === "string" ? raw.trim() : "";
    if (!name || seen.has(name)) continue;
    if (name.startsWith("mcp__")) continue;
    seen.add(name);
    cleaned.push(name);
  }
  autoBaseline = cleaned.length > 0 ? cleaned : null;
}

export function loadToolOfferAutoBaseline(
  names: string[] | null | undefined,
): void {
  setToolOfferAutoBaseline(names ?? null);
}

export function clearToolOfferStateForTests(): void {
  overrides.clear();
  autoBaseline = null;
}
