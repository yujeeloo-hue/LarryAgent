/**
 * `agentd setup` — interactive first-run configuration for a fresh node.
 *
 * Writes:
 * - {configDir}/settings.json      providers + remote relay + device identity
 * - {dataDir}/llm-api-keys.json    relay API key + LLM provider key (0600)
 * - {home}/workspaces/             default workspace root for the console
 *
 * Run it under sudo: when invoked as root the config/data/home trees are
 * chowned to the service user and secrets land mode 0600. Secret inputs are
 * read without echo and never logged.
 */
import { createInterface } from "node:readline/promises";
import { chownSync, chmodSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { configureSettingsRoot } from "../settings/settingsRoot.js";
import { readWorkspaceSettings } from "../settings/readWorkspaceSettings.js";
import { writeWorkspaceSettingsUnlocked } from "../settings/writeWorkspaceSettings.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL_ID,
  withSettingsDefaults,
} from "../settings/types.js";
import { newProviderId } from "../settings/readWorkspaceSettings.js";
import {
  configureCredentialsRoot,
  writeApiKeyToStore,
} from "../llm/credentials.js";
import { ensureDeviceId } from "../remote/remoteBridge.js";
import {
  AGENTD_SERVICE_USER,
  resolveAgentdConfigDir,
  resolveAgentdDataDir,
  resolveAgentdHomeDir,
} from "./config.js";

/** Credential-store account for the relay API key (desktop parity). */
const REMOTE_RELAY_CREDENTIAL_ID = "remote-relay";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

/** Recursive chown for the small, service-owned config/data/home trees. */
function chownTree(path: string, uid: number, gid: number): void {
  chownSync(path, uid, gid);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) {
      chownTree(child, uid, gid);
    } else if (entry.isFile()) {
      chownSync(child, uid, gid);
    }
  }
}

/** uid/gid of the service user from /etc/passwd (null when absent). */
function serviceIds(): { uid: number; gid: number } | null {
  try {
    const line = readFileSync("/etc/passwd", "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${AGENTD_SERVICE_USER}:`));
    if (!line) return null;
    const parts = line.split(":");
    const uid = Number(parts[2]);
    const gid = Number(parts[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) return null;
    return { uid, gid };
  } catch {
    return null;
  }
}

/**
 * Prompt helpers. Interactive = readline on a TTY; hidden inputs mute the
 * echo with a raw-mode reader.
 *
 * Non-TTY (scripted/CI `setup < answers.txt`) reads all of stdin once and
 * answers sequentially — readline's question() drops piped lines that
 * arrive between questions, which silently killed scripted runs.
 */
function createPrompter(): {
  ask: (query: string) => Promise<string>;
  askHidden: (query: string) => Promise<string>;
  close: () => void;
} {
  const rl = process.stdin.isTTY
    ? createInterface({ input: process.stdin, output: process.stdout })
    : null;
  let pipedLines: string[] | null = null;
  const nextPipedLine = (): string => {
    if (pipedLines === null) {
      let raw = "";
      try {
        raw = readFileSync(0, "utf8");
      } catch {
        raw = "";
      }
      pipedLines = raw.split(/\r?\n/);
    }
    return (pipedLines.shift() ?? "").trim();
  };

  const ask = async (query: string): Promise<string> => {
    if (!rl) {
      process.stdout.write(`${query}\n`);
      return nextPipedLine();
    }
    return (await rl.question(query)).trim();
  };

  const askHidden = async (query: string): Promise<string> => {
    if (!rl) {
      process.stdout.write(`${query}\n`);
      return nextPipedLine();
    }
    process.stdout.write(query);
    rl.pause();
    const stdin = process.stdin;
    const value = await new Promise<string>((resolve) => {
      let buffer = "";
      const onData = (chunk: string): void => {
        for (const char of chunk) {
          if (char === "\r" || char === "\n") {
            stdin.setRawMode(false);
            stdin.off("data", onData);
            stdin.pause();
            process.stdout.write("\n");
            resolve(buffer);
            return;
          }
          if (char === "\u0003") {
            // Ctrl+C — leave the terminal usable.
            stdin.setRawMode(false);
            process.stdout.write("\n");
            process.exit(130);
          }
          if (char === "\u007f" || char === "\b") {
            buffer = buffer.slice(0, -1);
            continue;
          }
          if (char >= " ") buffer += char;
        }
      };
      stdin.setEncoding("utf8");
      stdin.setRawMode(true);
      stdin.resume();
      stdin.on("data", onData);
    });
    rl.resume();
    return value.trim();
  };

  return {
    ask,
    askHidden,
    close: () => {
      rl?.close();
    },
  };
}

export async function runAgentdSetup(): Promise<number> {
  const configDir = resolveAgentdConfigDir();
  const dataDir = resolveAgentdDataDir();
  const homeDir = resolveAgentdHomeDir();
  configureSettingsRoot(configDir);
  configureCredentialsRoot(dataDir);

  log("");
  log("JellyBot agentd setup — configures this device for the web console.");
  log("");

  const prompter = createPrompter();
  const { ask, askHidden } = prompter;

  try {
    const existing = await readWorkspaceSettings(dataDir);
    if (existing?.remote?.deviceId) {
      const answer = (
        await ask(
          `Existing device config found (deviceId ${existing.remote.deviceId.slice(0, 8)}…). Overwrite? [y/N] `,
        )
      ).toLowerCase();
      if (answer !== "y" && answer !== "yes") {
        log("Aborted — nothing changed.");
        return 0;
      }
    }

    log("Relay (web console) connection:");
    const relayUrl = await ask(
      "  Relay server URL (e.g. https://remote.jellybot.cloud): ",
    );
    if (!relayUrl) {
      log("✖ Relay server URL is required.");
      return 1;
    }
    const relayKey = await askHidden("  Relay API key (input hidden): ");
    if (!relayKey) {
      log("✖ Relay API key is required.");
      return 1;
    }
    const deviceName =
      (await ask(`  Device name [${hostname()}]: `)) || hostname();
    const modeAnswer = (
      await ask("  Control mode — full or readonly [full]: ")
    ).toLowerCase();
    const mode = modeAnswer === "readonly" ? "readonly" : "full";

    log("");
    log("LLM provider (used for turns started from the console):");
    const llmBaseUrl =
      (await ask(`  Base URL [${DEFAULT_BASE_URL}]: `)) || DEFAULT_BASE_URL;
    const llmModelId =
      (await ask(`  Model id [${DEFAULT_MODEL_ID}]: `)) || DEFAULT_MODEL_ID;
    const llmName =
      (await ask("  Display name [LLM]: ")) || "LLM";
    const llmKey = await askHidden(
      "  API key (input hidden; empty = add it later in the console): ",
    );

    // ── Write settings ────────────────────────────────────────
    const provider = {
      id: newProviderId(),
      name: llmName,
      baseUrl: llmBaseUrl.trim().replace(/\/+$/, ""),
      modelId: llmModelId.trim(),
    };
    const settings = withSettingsDefaults(existing);
    settings.providers = [provider];
    settings.activeProviderId = provider.id;
    settings.remote = {
      enabled: true,
      serverUrl: relayUrl,
      deviceId: ensureDeviceId(existing?.remote?.deviceId),
      deviceName,
      mode,
      pushActivity: existing?.remote?.pushActivity ?? "all",
      memorySync: existing?.remote?.memorySync ?? {
        enabled: false,
        sessionArchive: false,
        projectDocs: false,
      },
    };

    mkdirSync(configDir, { recursive: true });
    await writeWorkspaceSettingsUnlocked(dataDir, settings);

    // ── Write credentials (0600; never logged) ────────────────
    mkdirSync(dataDir, { recursive: true });
    await writeApiKeyToStore(relayKey, REMOTE_RELAY_CREDENTIAL_ID);
    if (llmKey) {
      await writeApiKeyToStore(llmKey, provider.id);
    }

    // ── Default workspace root for the console folder picker ──
    mkdirSync(join(homeDir, "workspaces"), { recursive: true });

    // ── Ownership / permissions ───────────────────────────────
    chmodSync(configDir, 0o700);
    chmodSync(dataDir, 0o700);
    chmodSync(join(configDir, "settings.json"), 0o600);
    chmodSync(join(dataDir, "llm-api-keys.json"), 0o600);

    if (process.getuid?.() === 0) {
      const ids = serviceIds();
      if (ids) {
        for (const dir of [configDir, dataDir, homeDir]) {
          try {
            chownTree(dir, ids.uid, ids.gid);
          } catch (error) {
            log(
              `⚠ chown of ${dir} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      } else {
        log(
          `⚠ service user "${AGENTD_SERVICE_USER}" not found — run install.sh first (or chown ${configDir}, ${dataDir}, ${homeDir} manually).`,
        );
      }
    } else {
      log(
        `⚠ not running as root — ${configDir}, ${dataDir} and ${homeDir} were not chowned to ${AGENTD_SERVICE_USER}.`,
      );
    }

    log("");
    log("✔ Setup complete");
    log(`  settings : ${join(configDir, "settings.json")}`);
    log(
      `  keys     : ${join(dataDir, "llm-api-keys.json")}${llmKey ? "" : " (LLM key not set)"}`,
    );
    log(`  device   : ${deviceName} (${settings.remote.deviceId})`);
    log(`  relay    : ${relayUrl} — mode ${mode}`);
    log(`  LLM      : ${llmName} · ${provider.baseUrl} · ${provider.modelId}`);
    log("");
    log("Start the service:   sudo systemctl enable --now jellybot-agentd");
    log("Follow the logs:     journalctl -u jellybot-agentd -f");
    log("");
    return 0;
  } finally {
    prompter.close();
  }
}
