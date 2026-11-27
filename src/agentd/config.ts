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

export function resolveAgentdUpdateQueueDir(dataDir = resolveAgentdDataDir()): string {
  return join(dataDir, "update-queue");
}

export function resolveAgentdUpdateStatusDir(dataDir = resolveAgentdDataDir()): string {
  return join(dataDir, "update-status");
}

export function resolveAgentdInstallRoot(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, ".."),
    join(here, "..", ".."),
  ];
  for (const candidate of candidates) {
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return null;
}

export function resolveAgentdHomeDir(): string {
  const env = process.env.JELLYBOT_AGENTD_HOME_DIR?.trim();
  return env || DEFAULT_HOME_DIR;
}

export function resolveAgentdPromptsDir(): string {
  const envDir = process.env.JELLYBOT_RESOURCES_DIR?.trim();
  if (envDir) {
    const candidate = join(envDir, "prompts");
    if (existsSync(candidate)) return candidate;
  }
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, "..", "resources", "prompts"),
    join(here, "..", "..", "resources", "prompts"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0]!;
}

export function resolveAgentdVersion(): string {
  const env = process.env.JELLYBOT_AGENTD_VERSION?.trim();
  if (env) return env;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [
    join(here, "..", "package.json"),
    join(here, "package.json"),
    join(here, "..", "..", "package.json"),
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
    }
  }
  return "dev";
}
