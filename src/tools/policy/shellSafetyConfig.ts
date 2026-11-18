
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
