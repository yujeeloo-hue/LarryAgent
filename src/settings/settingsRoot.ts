
let override: string | null = null;

export function configureSettingsRoot(root: string | null): void {
  const next = typeof root === "string" && root.trim() ? root.trim() : null;
  override = next;
}

export function resolveSettingsDir(appDataRoot: string): string {
  return override ?? appDataRoot;
}
