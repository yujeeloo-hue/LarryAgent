/**
 * In-memory Shell Safe Mode runtime config (plan:
 * docs/plans/20260819-shell-safe-mode.md).
 *
 * Persisted as `shellSafety` in `{userData}/tools.json` by the main
 * process (normalize/parse live in toolsConfig/types.ts); this module is
 * the single runtime read point for the permission pipeline.
 *
 * - enabled=false bypasses every assessor (byte-identical legacy behavior)
 * - fatalPolicy: "ask" (default, settled) — Class A runs after a
 *   confirmation card; "block" — Class A is denied outright.
 */

export type ShellFatalPolicy = "ask" | "block";

export type ShellSafetyConfig = {
  enabled: boolean;
  fatalPolicy: ShellFatalPolicy;
};

const DEFAULTS: ShellSafetyConfig = { enabled: true, fatalPolicy: "ask" };

let current: ShellSafetyConfig = { ...DEFAULTS };

export function getShellSafetyConfig(): ShellSafetyConfig {
  return current;
}

/** Patch shape with explicit undefined (exactOptionalPropertyTypes-safe). */
export type ShellSafetyPatch = {
  enabled?: boolean | undefined;
  fatalPolicy?: ShellFatalPolicy | undefined;
};

export function setShellSafetyConfig(patch: ShellSafetyPatch): void {
  const next: ShellSafetyConfig = {
    enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
    fatalPolicy:
      patch.fatalPolicy === "ask" || patch.fatalPolicy === "block"
        ? patch.fatalPolicy
        : current.fatalPolicy,
  };
  current = next;
}

/** Replace from tools.json on app start / config change. */
export function loadShellSafetyConfig(
  value: unknown,
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    current = { ...DEFAULTS };
    return;
  }
  const raw = value as Record<string, unknown>;
  setShellSafetyConfig({
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : undefined,
    fatalPolicy:
      raw.fatalPolicy === "ask" || raw.fatalPolicy === "block"
        ? raw.fatalPolicy
        : undefined,
  });
}

export function resetShellSafetyConfigForTests(): void {
  current = { ...DEFAULTS };
}
