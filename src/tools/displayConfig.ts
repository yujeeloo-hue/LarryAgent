/**
 * In-memory tool card visibility overrides.
 * Persisted as `toolDisplayOverrides` in tools.json.
 *
 * false = tool still executes and is stored in the session, but its card is
 * not rendered in the conversation flow (streaming / finished / replay).
 * Absent = show (true).
 */

const overrides = new Map<string, boolean>();

/** Tools whose cards must always render (interactive / plan progress UI). */
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

/** Effective card visibility: always-visible tools win, default true. */
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

/** Hidden card names (false only) — for the renderer's hidden set. */
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
