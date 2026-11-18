
const overrides = new Map<string, boolean>();

export const ALWAYS_VISIBLE_TOOLS = new Set([
  "ask_user",
  "request_full_permissions",
  "create_plan",
  "update_plan",
  "complete_plan",
]);

export function setToolDisplayOverride(name: string, visible: boolean): void {
  const key = name.trim();
  if (!key) return;
  if (ALWAYS_VISIBLE_TOOLS.has(key)) return;
  overrides.set(key, visible);
}

export function clearToolDisplayOverride(name: string): void {
  overrides.delete(name.trim());
}

export function getToolDisplayOverride(name: string): boolean | undefined {
  return overrides.get(name.trim());
}

export function isToolCardVisible(name: string): boolean {
  if (ALWAYS_VISIBLE_TOOLS.has(name)) return true;
  return overrides.get(name) !== false;
}

export function getAllToolDisplayOverrides(): Record<string, boolean> {
  return Object.fromEntries(overrides);
}

export function loadToolDisplayOverrides(
  entries: Record<string, boolean> | null | undefined,
): void {
  overrides.clear();
  if (!entries) return;
  for (const [name, value] of Object.entries(entries)) {
    const key = name.trim();
    if (!key) continue;
    if (ALWAYS_VISIBLE_TOOLS.has(key)) continue;
    if (typeof value === "boolean") {
      overrides.set(key, value);
    }
  }
}

export function listHiddenToolCards(): string[] {
  const out: string[] = [];
  for (const [name, visible] of overrides) {
    if (visible === false) out.push(name);
  }
  return out;
}

export function clearToolDisplayStateForTests(): void {
  overrides.clear();
}
