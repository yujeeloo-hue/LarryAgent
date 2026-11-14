/**
 * Settings-root override.
 *
 * Desktop keeps settings.json inside the Electron userData root (same dir as
 * sessions.sqlite). The headless jellybot-agentd node splits the two: runtime
 * data (sessions/history/credentials/memory) lives under /var/lib/jellybot-agent
 * while the non-secret settings.json lives under /etc/jellybot-agent (0600,
 * config-style location).
 *
 * configureSettingsRoot points the settings IO at that config dir. Unset
 * (desktop, Loops daemon, tests) keeps the historical appDataRoot behavior —
 * byte-identical for every existing caller.
 */

let override: string | null = null;

export function configureSettingsRoot(root: string | null): void {
  const next = typeof root === "string" && root.trim() ? root.trim() : null;
  override = next;
}

/** Directory that holds settings.json for the given app data root. */
export function resolveSettingsDir(appDataRoot: string): string {
  return override ?? appDataRoot;
}
