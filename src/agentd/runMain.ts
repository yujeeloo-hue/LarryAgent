import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { hostname } from "node:os";
import { basename, join } from "node:path";

import { configureHostAdapter, createHeadlessHost } from "../host/adapter.js";
import { createDeviceMaintenance, defaultMaintenanceProbes } from "./deviceMaintenance.js";
import {
  addAgentStreamSink,
  createSessionStore,
  removeAgentStreamSink,
} from "../main/sessionRuntime.js";
import {
  createRemoteBridge,
  ensureDeviceId,
  type RemoteMaintenanceState,
} from "../remote/remoteBridge.js";
import {
  exportSyncProvider,
  listSyncProviders,
  removeSyncProvider,
  removeSyncProviderById,
  upsertSyncProvider,
} from "../remote/providerSync.js";
import {
  exportSyncMcpServer,
  listSyncMcpServers,
  removeSyncMcpServer,
  upsertSyncMcpServer,
} from "../remote/mcpSync.js";
import {
  exportSyncSkill,
  listSyncSkills,
  removeSyncSkill,
  upsertSyncSkill,
} from "../remote/skillSync.js";
import { configureSettingsRoot } from "../settings/settingsRoot.js";
import { readWorkspaceSettings } from "../settings/readWorkspaceSettings.js";
import { patchWorkspaceSettings } from "../settings/patchWorkspaceSettings.js";
import {
  resolveActiveProvider,
  withSettingsDefaults,
  type RemoteRelaySettings,
  type WorkspaceSettings,
} from "../settings/types.js";
import {
  configureCredentialsRoot,
  readApiKeyFromStore,
} from "../llm/credentials.js";
import { buildLlmUserAgent, configureLlmUserAgent } from "../llm/userAgent.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { configureAgentLog } from "../logging/agentLog.js";
import { configureUserMemoryRoot, loadUserMemory } from "../memory/store.js";
import {
  configureToolsConfigRoot,
  migrateToolsConfigFromSettings,
} from "../toolsConfig/store.js";
import {
  listHiddenToolCards,
  loadToolPermissionOverrides,
  loadToolOfferOverrides,
  loadToolOfferAutoBaseline,
  loadToolDisplayOverrides,
  registerBuiltins,
} from "../tools/index.js";
import { loadShellSafetyConfig } from "../tools/policy/shellSafetyConfig.js";
import {
  configureSkillPersistence,
  configureSkillsRoot,
  skillManager,
} from "../skills/index.js";
import { mcpManager } from "../mcp/index.js";
import {
  filterExistingFilePaths,
  readTextFilePreview,
} from "../main/filePreview.js";
import { getPathsDiffStats } from "../vcs/index.js";
import { buildAttachmentDrafts } from "../tools/attachmentDrafts.js";
import { wireToolsConfigPersistence } from "./toolsPersistence.js";
import { configureTrashMover } from "../tools/policy/trashRewrite.js";
import { createDeviceTrashMover } from "./deviceTrash.js";
import { configureFsmGraphsRoot } from "../agent/fsm/graphLibrary/manager.js";
import {
  resolveAgentdConfigDir,
  resolveAgentdDataDir,
  resolveAgentdPromptsDir,
  resolveAgentdVersion,
} from "./config.js";

const REMOTE_RELAY_CREDENTIAL_ID = "remote-relay";
const STATUS_LOG_INTERVAL_MS = 5 * 60 * 1000;

export interface AgentdRunOptions {
  configDir?: string;
  dataDir?: string;
}

function log(message: string): void {
  process.stdout.write(`[agentd] ${new Date().toISOString()} ${message}\n`);
}

function logError(message: string, error: unknown): void {
  const detail =
    error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(
    `[agentd] ${new Date().toISOString()} ${message}: ${detail}\n`,
  );
}

export async function runAgentd(options: AgentdRunOptions = {}): Promise<void> {
  const configDir = options.configDir ?? resolveAgentdConfigDir();
  const dataDir = options.dataDir ?? resolveAgentdDataDir();
  const version = resolveAgentdVersion();

  mkdirSync(dataDir, { recursive: true });

  configureSettingsRoot(configDir);
  configureCredentialsRoot(dataDir);
  configureAgentLog(dataDir);
  configureLlmUserAgent(buildLlmUserAgent("OctoBot", version));
  configurePromptDefaults(resolveAgentdPromptsDir());
  configureUserMemoryRoot(dataDir);
  void loadUserMemory();
  configureToolsConfigRoot(dataDir);
  wireToolsConfigPersistence();
  configureSkillsRoot(join(dataDir, "skills"));
  configureTrashMover(createDeviceTrashMover(join(dataDir, "trash")));
  configureFsmGraphsRoot(join(dataDir, "fsm-graphs"));
  registerBuiltins();
  configureHostAdapter(createHeadlessHost({ version }));

  let mcpServers: Parameters<typeof mcpManager.startFromSettings>[0] = [];
  let skills: Parameters<typeof skillManager.startFromSettings>[0] = [];
  try {
    const tools = await migrateToolsConfigFromSettings();
    loadToolPermissionOverrides(tools.toolPermissionOverrides);
    loadToolOfferOverrides(tools.toolOfferOverrides);
    loadToolOfferAutoBaseline(tools.toolOfferAutoBaseline);
    loadToolDisplayOverrides(tools.toolDisplayOverrides);
    loadShellSafetyConfig(tools.shellSafety);
    mcpServers = tools.mcpServers;
    skills = tools.skills;
  } catch (error) {
    logError("tools config migration failed; running with defaults", error);
  }
  try {
    await mcpManager.startFromSettings(mcpServers);
  } catch (error) {
    logError("mcp start failed; continuing without MCP tools", error);
  }
  try {
    await skillManager.startFromSettings(skills);
  } catch (error) {
    logError("skills start failed; continuing without skills", error);
  }

  const store = createSessionStore(dataDir);

  const readRemoteSettings = async (): Promise<RemoteRelaySettings> => {
    const settings =
      (await readWorkspaceSettings(dataDir)) ?? ({} as WorkspaceSettings);
    const remote = settings.remote;
    return {
      enabled: remote?.enabled ?? false,
      serverUrl: remote?.serverUrl?.trim() ?? "",
      deviceId: ensureDeviceId(remote?.deviceId),
      deviceName: remote?.deviceName?.trim() || hostname(),
      mode: remote?.mode === "full" ? "full" : "readonly",
      pushActivity: remote?.pushActivity ?? "all",
      memorySync: remote?.memorySync ?? {
        enabled: false,
        sessionArchive: false,
        projectDocs: false,
      },
    };
  };
  let remoteSettings = await readRemoteSettings();

  if (remoteSettings.deviceId) {
    const persisted = await readWorkspaceSettings(dataDir);
    if (
      persisted &&
      (!persisted.remote || persisted.remote.deviceId !== remoteSettings.deviceId)
    ) {
      try {
        await patchWorkspaceSettings(dataDir, { remote: { ...remoteSettings } });
      } catch (error) {
        logError("failed to persist deviceId", error);
      }
    }
  }

  const remoteUploadDir = (): string => join(dataDir, "remote-uploads");
  let pushMaintenance: (state: RemoteMaintenanceState) => void = () => {};
  const requestStopRef: { current: ((reason: string) => void) | null } = { current: null };
  const maintenance = createDeviceMaintenance({
    dataDir,
    version,
    requestRestart: () => requestStopRef.current?.("remote-restart"),
    onStateChange: (state) => pushMaintenance(state),
    ...defaultMaintenanceProbes(),
  });
  const bridge = createRemoteBridge({
    store,
    getSettings: () => remoteSettings,
    getApiKey: () => readApiKeyFromStore(REMOTE_RELAY_CREDENTIAL_ID),
    appVersion: () => version,
    platform: () => `${process.platform} ${process.arch}`,
    listHiddenToolCards: () => listHiddenToolCards(),
    getComposerSnapshot: async () => {
      const settings = withSettingsDefaults(
        (await readWorkspaceSettings(dataDir)) ?? ({} as WorkspaceSettings),
      );
      const active = resolveActiveProvider(settings);
      return {
        providers: settings.providers.map((p) => ({
          id: p.id,
          name: p.name,
          modelId: p.modelId,
        })),
        activeProviderId: active.id,
        composerInfinite: settings.composerInfinite === true,
        reasoningEffort: settings.reasoningEffort,
        contextLimitTokens: settings.contextLimitTokens,
      };
    },
    providerSync: {
      list: () => listSyncProviders(dataDir),
      exportOne: (providerId) => exportSyncProvider(dataDir, providerId),
      upsert: (transfer) => upsertSyncProvider(dataDir, transfer),
      remove: (baseUrl, modelId) => removeSyncProvider(dataDir, baseUrl, modelId),
      removeById: (providerId) => removeSyncProviderById(dataDir, providerId),
    },
    mcpSync: {
      list: listSyncMcpServers,
      exportOne: exportSyncMcpServer,
      upsert: upsertSyncMcpServer,
      remove: removeSyncMcpServer,
    },
    skillSync: {
      list: listSyncSkills,
      exportOne: exportSyncSkill,
      upsert: upsertSyncSkill,
      remove: removeSyncSkill,
    },
    saveRemoteUpload: async ({ name, contentBase64 }) => {
      try {
        const dir = remoteUploadDir();
        await mkdir(dir, { recursive: true });
        const safeBase =
          basename(name).replace(/[\u0000-\u001f/\\]/g, "") || "upload.bin";
        const filePath = join(
          dir,
          `${Date.now()}-${randomUUID().slice(0, 8)}-${safeBase}`,
        );
        const bytes = Buffer.from(contentBase64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) {
          return null;
        }
        await writeFile(filePath, bytes);
        const drafts = await buildAttachmentDrafts([filePath]);
        return drafts[0] ?? null;
      } catch {
        return null;
      }
    },
    remoteUploadDir,
    readTextFilePreview,
    filterExistingFiles: filterExistingFilePaths,
    getPathsDiffStats,
    events: {
      onStatusChange: (status, detail) => {
        log(detail ? `relay status: ${status} — ${detail}` : `relay status: ${status}`);
      },
    },
    deviceMaintenance: maintenance,
    deviceCaps: ["maintenance", "reboot", "exec"],
  });
  pushMaintenance = (state) => {
    try {
      bridge.pushMaintenanceState(state);
    } catch {
    }
  };
  const streamSink = (payload: { sessionId: string; event: unknown }): void => {
    bridge.handleStreamEvent(payload);
  };
  addAgentStreamSink(streamSink);

  log(`jellybot-agentd ${version} — data=${dataDir} config=${configDir}`);
  if (remoteSettings.enabled && remoteSettings.serverUrl) {
    log(
      `relay: connecting to ${remoteSettings.serverUrl} as "${remoteSettings.deviceName}" (${remoteSettings.deviceId})`,
    );
    void bridge.start();
  } else if (!remoteSettings.enabled) {
    log("relay disabled — run `agentd setup` (or edit settings.json) to enable");
  } else {
    log("relay enabled but no server URL configured — run `agentd setup`");
  }

  const heartbeat = setInterval(() => {
    log(`status=${bridge.status()} sessions=${store.listSessions().length}`);
  }, STATUS_LOG_INTERVAL_MS);

  let stopReason = "signal";
  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) return;
      stopping = true;
      stopReason = signal;
      log(`received ${signal} — shutting down`);
      clearInterval(heartbeat);
      try {
        maintenance.stop();
      } catch {
      }
      try {
        removeAgentStreamSink(streamSink);
      } catch {
      }
      try {
        store.persistRunningSessionsOnQuit();
      } catch {
      }
      try {
        bridge.stop();
      } catch {
      }
      try {
        store.memorySync.stop();
      } catch {
      }
      setTimeout(resolveStop, 250);
    };
    requestStopRef.current = stop;
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
  if (stopReason === "remote-restart") {
    log("restarting (systemd Restart=always revives the service)");
    process.exit(0);
  }
  log("stopped");
}
