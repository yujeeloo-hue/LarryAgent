/**
 * Paths & version for the jellybot-agentd headless node.
 *
 * Layout (Bookworm service install):
 * - config dir  /etc/jellybot-agent      settings.json (0600, service user)
 * - data dir    /var/lib/jellybot-agent  sessions.sqlite, credentials store,
 *                                        user memory, skills, logs, uploads
 * - home        /srv/jellybot-agent      workspace root (the console folder
 *                                        picker is scoped to the service
 *                                        user's home subtree)
 *
 * Env overrides keep dev runs and tests hermetic:
 * JELLYBOT_AGENTD_CONFIG_DIR / JELLYBOT_AGENTD_DATA_DIR /
 * JELLYBOT_RESOURCES_DIR / JELLYBOT_AGENTD_VERSION.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const AGENTD_SERVICE_USER = "jellybot-agent";
export const DEFAULT_CONFIG_DIR = "/etc/jellybot-agent";
export const DEFAULT_DATA_DIR = "/var/lib/jellybot-agent";
export const DEFAULT_HOME_DIR = "/srv/jellybot-agent";
export const AGENTD_UPDATER_PATH_UNIT = "jellybot-agentd-update.path";
export const AGENTD_UPDATER_SERVICE = "jellybot-agentd-update.service";
export const AGENTD_REBOOT_PATH_UNIT = "jellybot-agentd-reboot.path";
export const AGENTD_REBOOT_SERVICE = "jellybot-agentd-reboot.service";

export function resolveAgentdConfigDir(): string {
  const env = process.env.JELLYBOT_AGENTD_CONFIG_DIR?.trim();
  return env || DEFAULT_CONFIG_DIR;
}

export function resolveAgentdDataDir(): string {
  const env = process.env.JELLYBOT_AGENTD_DATA_DIR?.trim();
  return env || DEFAULT_DATA_DIR;
}

/** Root updater request spool — the service user writes, the root oneshot consumes. */
export function resolveAgentdUpdateQueueDir(dataDir = resolveAgentdDataDir()): string {
  return join(dataDir, "update-queue");
}

/** Update progress files written by the root updater, polled by the service. */
export function resolveAgentdUpdateStatusDir(dataDir = resolveAgentdDataDir()): string {
  return join(dataDir, "update-status");
}

/** Install root (<install>/lib/agentd.mjs → <install>); null outside a release/dev tree. */
export function resolveAgentdInstallRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, ".."), // <install>/lib → <install>
    join(here, "..", ".."), // repo src/agentd → repo root (dev)
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

/** Service-user home (workspace root). Env override for dev runs. */
export function resolveAgentdHomeDir(): string {
  const env = process.env.JELLYBOT_AGENTD_HOME_DIR?.trim();
  return env || DEFAULT_HOME_DIR;
}

/**
 * Role-prompts dir: `{resources}/prompts`. Packaged layout resolves it
 * relative to the bundle (`<install>/lib/agentd.mjs` → `<install>/resources`);
 * dev falls back to the repo's `resources/prompts`. JELLYBOT_RESOURCES_DIR
 * wins when set (same contract as the Loops daemon plist).
 */
export function resolveAgentdPromptsDir(): string {
  const envDir = process.env.JELLYBOT_RESOURCES_DIR?.trim();
  if (envDir) {
    const candidate = join(envDir, "prompts");
    if (existsSync(candidate)) return candidate;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "resources", "prompts"), // <install>/lib → <install>/resources
    join(here, "..", "..", "resources", "prompts"), // repo src/agentd → repo resources
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

/** Version string: env override → shipped package.json → "dev". */
export function resolveAgentdVersion(): string {
  const env = process.env.JELLYBOT_AGENTD_VERSION?.trim();
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"), // <install>/lib → <install>/package.json
    join(here, "package.json"),
    join(here, "..", "..", "package.json"), // dev: repo package.json
  ]) {
    try {
      if (!existsSync(candidate)) continue;
      const parsed = JSON.parse(readFileSync(candidate, "utf8")) as {
        name?: unknown;
        version?: unknown;
      };
      if (
        (parsed.name === "jellybot-agentd" || parsed.name === "jellybot") &&
        typeof parsed.version === "string" &&
        parsed.version.trim()
      ) {
        return parsed.version.trim();
      }
    } catch {
      // try next candidate
    }
  }
  return "dev";
}
