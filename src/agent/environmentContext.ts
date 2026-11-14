import { displayPath } from "../tools/pathUtil.js";
import type { EnvironmentContextFlags } from "../settings/types.js";

export type EnvironmentLocaleSnapshot = {
  /** OS preferred languages, most preferred first (e.g. zh-Hans-CN). */
  preferredLanguages: string[];
  /** System locale / region format (e.g. zh-CN). */
  systemLocale: string;
  /** Chromium / app locale. */
  appLocale: string;
};

export type EnvironmentWorkspaceSnapshot = {
  id: string;
  name: string;
  path: string;
};

export type EnvironmentContextInput = {
  flags: EnvironmentContextFlags;
  workspace: EnvironmentWorkspaceSnapshot;
  locale: EnvironmentLocaleSnapshot;
  /** Inject for tests; defaults to now (timezone offset only). */
  now?: Date;
  /** Inject for tests; defaults to the real process platform. */
  platform?: NodeJS.Platform;
};

export function anyEnvironmentContextEnabled(
  flags: EnvironmentContextFlags,
): boolean {
  return (
    flags.workspace || flags.timezone || flags.locale || flags.location
  );
}

function formatOffset(minutes: number): string {
  const sign = minutes <= 0 ? "+" : "-";
  const abs = Math.abs(minutes);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return `UTC${sign}${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function regionFromLocale(locale: string): string | null {
  const trimmed = locale.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/[-_]([A-Za-z]{2})$/);
  return match ? match[1]!.toUpperCase() : null;
}

/**
 * Build an ephemeral Environment system message from live OS / workspace data.
 * Does not include local date/time — use the get_current_time tool when needed.
 * Returns null when every flag is off (caller skips injection).
 */
export function buildEnvironmentContextPrompt(
  input: EnvironmentContextInput,
): string | null {
  if (!anyEnvironmentContextEnabled(input.flags)) return null;

  const now = input.now ?? new Date();
  const timeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
  const utcOffset = formatOffset(now.getTimezoneOffset());
  const region =
    regionFromLocale(input.locale.systemLocale) ??
    regionFromLocale(input.locale.appLocale);

  const lines: string[] = [
    "Environment context for this model iteration (live; not part of the chat transcript):",
  ];

  // Windows v1: without this hint the model generates POSIX commands first
  // and self-corrects. macOS output stays byte-identical (no line on darwin).
  if ((input.platform ?? process.platform) === "win32") {
    lines.push(
      "- OS: Windows · shell: cmd.exe — generate cmd.exe-compatible commands (not POSIX); the shell tool is exec_command",
    );
  }

  if (input.flags.workspace) {
    const name = input.workspace.name.trim() || "(unnamed)";
    const id = input.workspace.id.trim() || "(none)";
    const pathLabel = input.workspace.path.trim()
      ? displayPath(input.workspace.path.trim())
      : "(not set)";
    lines.push(`- Workspace: ${name}`);
    lines.push(`- Workspace id: ${id}`);
    lines.push(`- Workspace path: ${pathLabel}`);
  }

  if (input.flags.timezone) {
    lines.push(`- Timezone: ${timeZone} (${utcOffset})`);
  }

  if (input.flags.locale) {
    const preferred =
      input.locale.preferredLanguages.length > 0
        ? input.locale.preferredLanguages.join(", ")
        : "(unknown)";
    lines.push(`- Preferred languages: ${preferred}`);
    lines.push(
      `- System locale: ${input.locale.systemLocale.trim() || "(unknown)"}`,
    );
    if (
      input.locale.appLocale.trim() &&
      input.locale.appLocale !== input.locale.systemLocale
    ) {
      lines.push(`- App locale: ${input.locale.appLocale.trim()}`);
    }
  }

  if (input.flags.location) {
    const parts: string[] = [];
    parts.push(`timezone ${timeZone}`);
    if (region) parts.push(`region ${region}`);
    else if (input.locale.systemLocale.trim()) {
      parts.push(`locale ${input.locale.systemLocale.trim()}`);
    }
    lines.push(
      `- Location: ${parts.join(" · ")} (from system timezone and region; not GPS)`,
    );
  }

  return lines.length > 1 ? lines.join("\n") : null;
}
