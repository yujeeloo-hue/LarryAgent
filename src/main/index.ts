import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  session,
  shell,
} from "electron";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { notifyHiddenToTrayOnce, setupResidentTray } from "./appTray.js";
import { MENUBAR_ACTION_CHANNEL, setupMenuBarBrandItem } from "./menuBarIcon.js";
import { setupUsagePopup } from "./usagePopup.js";
import type { TrayHostDeps } from "./usagePopup.js";
import { setupAppNotify, appNotify } from "./appNotify.js";
import { setNotifyToolPort } from "./notifyToolAccess.js";
import { setDesktopNotifySink } from "./desktopNotify.js";
import type { AttachmentDraft } from "../agent/ipcTypes.js";
import { abortToolCall } from "../agent/toolCallAbort.js";
import { sessionForPresentation, sessionTailForPresentation, messageWindowForPresentation, subagentDetailForPresentation, messagesForPresentation } from "../session/presentation.js";
import { createRemoteBridge, ensureDeviceId, type RemoteCocoEngine } from "../remote/remoteBridge.js";
import { compareVersions, createDesktopMaintenance } from "./desktopMaintenance.js";
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
import { addAgentStreamSink, removeAgentStreamSink } from "./sessionRuntime.js";
import { cancelWorkspaceTemplateInit } from "./workspaceInit.js";
import { isWorkspaceTemplateId, type WorkspaceTemplateId } from "../workspace/templates.js";
import { deleteApiKeyFromKeychain, readApiKeyFromKeychain } from "../llm/keychain.js";
import type { RemoteRelaySettings, WorkspaceSettings } from "../settings/types.js";
import os from "node:os";
import { LogBuffer } from "../logging/logBuffer.js";
import { installConsoleCapture } from "../logging/installConsoleCapture.js";
import {
  agentLogWarn,
  configureAgentLog,
  getAgentLogsDir,
  setFullLlmRequestLog,
  isFullLlmRequestLogEnabled,
} from "../logging/agentLog.js";
import type { LogEntry, ProcessMetrics } from "../logging/types.js";
import {
  getToolStatsInvocation,
  getToolStatsSummary,
  isToolStatsEnabled,
  listToolStatsInvocations,
  resetToolStats,
  setToolStatsEnabled,
} from "../toolStats/index.js";
import {
  listLlmTimeline,
  subscribeLlmTimeline,
} from "../llm/llmTimeline/recorder.js";
import {
  configureCredentialsRoot,
  deleteApiKeyFromStore,
  hasApiKeyInStore,
  readApiKeyFromStore,
  writeApiKeyToStore,
} from "../llm/credentials.js";
import { getProviderBalance, getProviderUsage } from "./providerFunds.js";
import { llmEndpointKey } from "../llm/openaiCompatibleClient.js";
import { modelEndpoint, providerApiEndpoint, resolveLlmApiProtocol } from "../llm/apiProtocol.js";
import { reasoningScopeForClient } from "../llm/contextScope.js";
import { downloadResponseFile } from "../llm/adapters/responses/files.js";
import {
  findResponseFileReference,
  type ResponseFileDownloadRequest,
  type ResponseFileDownloadResult,
} from "../llm/adapters/responses/fileReferences.js";
import {
  hasUsableLlmProvider,
  isLocalLlmBaseUrl,
  probeLlmModels,
  type ProbeModelsResult,
} from "../llm/providerSetup.js";
import {
  isReasoningEffort,
  type ReasoningEffort,
} from "../llm/reasoningEffort.js";
import { checkLlmHealthGated } from "./llmHealthGate.js";
import {
  buildLlmUserAgent,
  configureLlmUserAgent,
  withLlmUserAgent,
} from "../llm/userAgent.js";
import {
  OBJECT_STORAGE_CREDENTIAL_ID,
  configurePromptDefaults,
  getPromptDefaults,
  normalizeObjectStorageConfig,
  readWorkspaceSettings,
  resolveActiveProvider,
  withSettingsDefaults,
  patchWorkspaceSettings,
  type ObjectStorageConfig,
} from "../settings/index.js";
import { resolveWindowBackground } from "./windowTheme.js";
import {
  S3Error,
  testConnection,
} from "../objectStorage/s3Client.js";
import type {
  McpServerConfig,
  ShellSafetyOptions,
  SkillConfig,
} from "../toolsConfig/index.js";
import { addNotificationListener } from "../events/notificationCenter.js";
import { attachNotificationCenterRendererBridge } from "../events/rendererBridge.js";
import {
  configureToolsConfigRoot,
  getToolsConfigCached,
  migrateToolsConfigFromSettings,
  patchToolsConfig,
  postToolsConfigChanged,
  readToolsConfig,
} from "../toolsConfig/index.js";
import {
  BUNDLE_FILE_EXTENSION,
  buildBackupBundle,
  openBackupPayload,
  payloadSections,
  readBackupHeader,
} from "../settings/backup/bundle.js";
import { collectBackup } from "../settings/backup/collectBackup.js";
import { applyBackup } from "../settings/backup/applyBackup.js";
import { loadShellSafetyConfig } from "../tools/policy/shellSafetyConfig.js";
import { migrateLegacyCwdData } from "../session/db/migrateLegacy.js";
import { optimizeUserPromptOnce } from "../session/optimizePrompt.js";
import { buildAttachmentDrafts } from "../tools/attachmentDrafts.js";
import {
  listToolCatalogGrouped,
  registerBuiltins,
  setToolCatalogPermission,
  setToolCatalogOffer,
  setToolCatalogDisplay,
  autoOrganizeToolOffers,
  getAllToolPermissionOverrides,
  loadToolPermissionOverrides,
  clearToolPermissionOverridesWithPrefix,
  clearToolOfferOverridesWithPrefix,
  getAllToolOfferOverrides,
  getToolOfferAutoBaseline,
  loadToolOfferOverrides,
  loadToolOfferAutoBaseline,
  loadToolDisplayOverrides,
  listHiddenToolCards,
  isToolCardVisible,
  ALWAYS_VISIBLE_TOOLS,
  getAllToolDisplayOverrides,
  setToolDisplayOverride,
  clearToolDisplayOverride,
} from "../tools/index.js";
import type { PermissionLevel } from "../tools/types.js";
import {
  mcpManager,
  configureMcpPersistence,
  mcpToolNamePrefixForServer,
} from "../mcp/index.js";
import type { McpServerUpsertInput } from "../mcp/types.js";
import {
  skillManager,
  configureSkillPersistence,
  configureSkillsRoot,
} from "../skills/index.js";
import type { SkillUpsertInput } from "../skills/types.js";
import {
  configureUserMemoryRoot,
  clearUserMemory,
  loadUserMemory,
  setUserMemoryProfile,
} from "../memory/index.js";
import type { UserMemorySnapshot } from "../memory/index.js";
import {
  clearProjectMemory,
  loadProjectMemory,
  setProjectMemoryBody,
} from "../projectMemory/index.js";
import type { ProjectMemorySnapshot } from "../projectMemory/index.js";
import {
  installLocalFileProtocolHandler,
  registerLocalFileSchemePrivileged,
  setLocalFileDemoWorkspaceRootsResolver,
} from "./localFileProtocol.js";
import { cocoHomePath } from "./cocoHome.js";
import { registerTerminalIpc } from "./terminalIpc.js";
import { registerDevTaskIpc } from "./devTasks.js";
import { registerDebugAdapterIpc } from "./debugAdapterIpc.js";
import { fsmGraphViewForMode, fsmGraphViewFromConfig, parseFsmGraphMode } from "./fsmGraphView.js";
import {
  configureFsmGraphsRoot,
  createNewGraphRecord,
  createForkFromBuiltin,
  deleteFsmGraph,
  getFsmGraph,
  listActionCatalog,
  listBuiltinTemplates,
  listComposerGraphs,
  listFsmGraphs,
  saveFsmGraph,
  setFsmGraphEnabled,
  validateGraphConfig,
} from "../agent/fsm/graphLibrary/manager.js";
import { registerSpeechTranscriptionIpc } from "./speechTranscription.js";
import {
  cleanupStorage,
  scanStorageUsage,
  type CleanupResult,
  type StorageUsage,
} from "./storageCleanup.js";
import { createSessionStore } from "./sessionRuntime.js";
import { configureHostAdapter } from "../host/adapter.js";
import { createDesktopHost } from "../host/desktop.js";
import { createCocoService } from "./cocoService.js";
import { CocoStartup } from "../coco/startup.js";
import { retireLoopsDaemon } from "./loops/daemonControl.js";
import type { CocoCommand, CocoSettings } from "../coco/types.js";
import { setLoopsToolPort } from "./loops/toolAccess.js";
import { createHooksService } from "../hooks/index.js";
import {
  fallbackCommitMessage,
  generateCommitMessage,
  pushToRemote,
  type CommitResult,
  type PathDiffStats,
  type PrepareCommitResult,
  type WorkingTreeChangesResult,
  type WorkingTreePathDiff,
  type WorkingTreeStats,
} from "../git/index.js";
import {
  collectCommitContext,
  commitPaths,
  getPathsDiffStats,
  getWorkingTreePathDiff,
  getWorkingTreeStats,
  listWorkingTreeChanges,
} from "../vcs/index.js";
import {
  resolveVcsAuthResponse,
  setVcsAuthBroadcastSink,
  type VcsAuthResponse,
} from "../vcs/vcsAuth.js";
import {
  filterExistingFilePaths,
  readTextFilePreview,
  type TextFilePreviewResult,
} from "./filePreview.js";
import {
  closeWorkspaceChangesWindow,
  openWorkspaceChangesWindow,
} from "./workspaceChangesWindow.js";
import { openSubagentsWindow } from "./subagentsWindow.js";
import { openFileReaderWindow } from "./fileReaderWindow.js";
import {
  cancelDevModeWalk,
  listDevModeDir,
  readFileForEditor,
  readProjectFile,
  resolveDevModeSourcePath,
  resolveUeEngineSourceRoot,
  searchDevModeFiles,
  startDevModeWatch,
  stopAllDevModeWatches,
  stopDevModeWatch,
  writeTextFileGuarded,
  type DevModeSearchOptions,
} from "./devModeFs.js";
import { runDevModeExecutable } from "./devmodeRun.js";
import { CppSymbolIndexService } from "./cppSymbols/service.js";
import { ClangdService } from "./clangd/service.js";
import { registerClangdIpc } from "./clangd/clangdIpc.js";
import { CLANGD_PROGRESS_CHANNEL } from "./clangd/types.js";
import { configureSymbolIndexService } from "../tools/builtin/symbols.js";
import { configureClangdService } from "../tools/builtin/findCxxReferences.js";
import {
  CPP_SYMBOL_ADD_ROOT_CHANNEL,
  CPP_SYMBOL_COMPLETE_CHANNEL,
  CPP_SYMBOL_LOOKUP_CHANNEL,
  CPP_SYMBOL_PROGRESS_CHANNEL,
  CPP_SYMBOL_REMOVE_ROOT_CHANNEL,
  CPP_SYMBOL_ROOTS_CHANNEL,
  CPP_USAGE_CANCEL_CHANNEL,
  CPP_USAGE_SEARCH_CHANNEL,
  parseCompletionChain,
  type CppUsageSearchRequest,
} from "./cppSymbols/types.js";
import {
  attachWindowControlsEvents,
  registerWindowControlsIpc,
  WINDOW_CLOSE_REQUEST_CHANNEL,
} from "./windowControls.js";
import {
  classifyF12Shortcut,
  EDITOR_FIND_USAGES_CHANNEL,
  EDITOR_GO_TO_DEFINITION_CHANNEL,
} from "./f12Shortcut.js";
import {
  invalidateVcsStatusCache,
  registerVcsIpc,
  startVcsChangeWatch,
  stopVcsChangeWatch,
} from "./vcsStatus.js";
import { IS_WINDOWS } from "../platformCaps.js";
import { applyScrollbarPresentationSwitches } from "./scrollbarPresentation.js";

registerLocalFileSchemePrivileged();

// Chromium switches must land before app ready / any window exists; importing
// this module at top level applies them at process start. macOS is a no-op.
applyScrollbarPresentationSwitches();

const mainLogBuffer = new LogBuffer(500);

/**
 * The stdio pipe dies when whatever launched the app goes away (a detached
 * `npm run dev`, a closed terminal). Each later console write then fails
 * asynchronously with EPIPE on the stream, and with no `error` listener Node
 * reports it as an uncaught main-process exception — repeatedly, since the app
 * keeps logging. Console output is never worth crashing over, so swallow it;
 * the log buffer / Detail → Log tab still has every entry.
 */
function ignoreBrokenStdioPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
      // Intentionally empty: writes to a dead pipe are not recoverable.
    });
  }
}

ignoreBrokenStdioPipe();

function broadcastDiagnosticLog(entry: LogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (wc.isDestroyed()) continue;
    // Renderer may not be ready yet; Electron logs send failures via
    // console.error — must not throw or that re-enters console capture.
    try {
      wc.send("diagnostics:log", entry);
    } catch {
      // Ignore — window closing / not ready / non-cloneable edge cases.
    }
  }
}

function readProcessMetrics(): ProcessMetrics {
  const metrics = app.getAppMetrics();
  let cpuPercent = 0;
  let workingSetKb = 0;
  for (const metric of metrics) {
    cpuPercent += metric.cpu.percentCPUUsage;
    workingSetKb += metric.memory.workingSetSize;
  }
  return {
    cpuPercent,
    memoryMB: workingSetKb / 1024,
  };
}

/** Custom title bar; native traffic lights. Agent turns run via sessionRuntime. */

/**
 * Window / Dock / taskbar icon, so `electron-vite dev` does not show the
 * default Electron icon.
 *
 * Returns undefined for packaged macOS builds: the bundle's `icon.icns` carries
 * per-size representations, and handing AppKit the single 1024px PNG instead
 * (via dock.setIcon or a BrowserWindow `icon`) makes it downscale in one step,
 * washing out thin edge detail such as the rim highlight.
 *
 * Windows gets `icon.ico` for the same reason: the taskbar asks for 16/24/32px
 * representations, which the multi-size ICO carries pre-rendered. The ICO is
 * also full-bleed — unlike the macOS PNG, whose transparent margin would make
 * the taskbar button look a fifth smaller than its neighbours.
 */
function resolveAppIconPath(): string | undefined {
  if (app.isPackaged && process.platform === "darwin") return undefined;
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  return join(base, process.platform === "win32" ? "icon.ico" : "icon.png");
}

/** Packaged: `{resources}/prompts`; dev: `{app}/resources/prompts`. */
function resolvePromptsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "prompts");
  }
  return join(app.getAppPath(), "resources", "prompts");
}

function resolveAppDataRoot(): string {
  return app.getPath("userData");
}

/** Compact error message for IPC result payloads / logs. */
function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function buildSettingsSnapshot(appDataRoot: string) {
  const settings = await readWorkspaceSettings(appDataRoot);
  const resolved = withSettingsDefaults(settings);
  const apiKeyConfiguredByProviderId: Record<string, boolean> = {};
  await Promise.all(
    resolved.providers.map(async (provider) => {
      apiKeyConfiguredByProviderId[provider.id] = await hasApiKeyInStore(
        provider.id,
      );
    }),
  );
  await Promise.all(
    resolved.imageGenProviders.map(async (provider) => {
      apiKeyConfiguredByProviderId[provider.id] = await hasApiKeyInStore(
        provider.id,
      );
    }),
  );
  apiKeyConfiguredByProviderId[OBJECT_STORAGE_CREDENTIAL_ID] =
    await hasApiKeyInStore(OBJECT_STORAGE_CREDENTIAL_ID);
  return {
    settings: resolved,
    promptDefaults: getPromptDefaults(),
    apiKeyConfiguredByProviderId,
    appVersion: app.getVersion(),
  };
}

/** Stopped on quit; assigned when IPC (and the symbol service) comes up. */
let stopCppSymbolIndex: (() => void) | null = null;
let stopClangd: (() => void) | null = null;

function registerIpc(): () => void {
  registerTerminalIpc();
  registerDevTaskIpc();
  registerDebugAdapterIpc();
  registerSpeechTranscriptionIpc();
  const clangd = new ClangdService((event) =>
    broadcastToRenderer(CLANGD_PROGRESS_CHANNEL, event),
  );
  stopClangd = () => clangd.stop();
  registerClangdIpc(clangd);
  // Agent-side `find_cxx_references` tool rides the same clangd host.
  configureClangdService(clangd);
  // Windows caption buttons — no-op registration on macOS.
  registerWindowControlsIpc();
  // Broadcasts on VCS metadata activity (commit / branch switch) — only
  // invoked at runtime, after broadcastToRenderer below is initialized.
  registerVcsIpc({
    onTreeChanged: (root) => broadcastToRenderer("vcs:changed", { rootPath: root }),
  });
  const appDataRoot = resolveAppDataRoot();
  // LLM identity only — keep packaged productName / userData as JellyBot.
  configureLlmUserAgent(buildLlmUserAgent("OctoBot", app.getVersion()));
  configurePromptDefaults(resolvePromptsDir());
  configureAgentLog(appDataRoot);
  migrateLegacyCwdData(appDataRoot, process.cwd());
  // Encrypted API key store — must precede any credential read/write below.
  configureCredentialsRoot(appDataRoot);
  // Summary profile was removed — one-time cleanup of its orphaned key entry
  // (also lifts it out of legacy Keychain storage). Idempotent: a missing
  // entry resolves to null and is ignored.
  void deleteApiKeyFromStore("summary").catch(() => {});
  // Must precede createSessionStore — boot syncs the USER Projects index.
  configureUserMemoryRoot(appDataRoot);
  void loadUserMemory();
  configureToolsConfigRoot(appDataRoot);
  // Host shell adapter — the Electron main implementation (locale, version,
  // renderer fan-out, task-done toasts, keep-awake guard). Headless entries
  // (Loops daemon, jellybot-agentd) configure their own.
  configureHostAdapter(createDesktopHost());
  const store = createSessionStore(appDataRoot);

  // ── Remote relay bridge (web console) ──────────────────────
  const REMOTE_RELAY_CREDENTIAL_ID = "remote-relay";
  const broadcastToRenderer = (
    channel: string,
    payload: unknown,
    options?: { exceptWebContentsId?: number },
  ): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      // Echo suppression: the window that originated a change (settings
      // save) already applies the authoritative state locally; rebroadcast
      // to it would trigger a full settings form reset.
      if (options?.exceptWebContentsId === win.webContents.id) continue;
      win.webContents.send(channel, payload);
    }
  };
  // NotificationCenter → renderer bridge: allowlisted events only, over the
  // single "nc:event" channel (see src/events/rendererBridge.ts).
  attachNotificationCenterRendererBridge((payload) =>
    broadcastToRenderer("nc:event", payload),
  );
  const cppSymbols = new CppSymbolIndexService((event) =>
    broadcastToRenderer(CPP_SYMBOL_PROGRESS_CHANNEL, event),
  );
  stopCppSymbolIndex = () => cppSymbols.stop();
  // Agent-side `symbols` tool reads the same index and can trigger builds.
  configureSymbolIndexService(cppSymbols);
  // VCS auth dialog broadcast — every window can show the prompt (Dev Mode
  // windows, main window; first to answer wins, others get a stale no-op).
  setVcsAuthBroadcastSink((payload) =>
    broadcastToRenderer("vcs:authRequest", payload),
  );
  const readRemoteSettings = async (): Promise<RemoteRelaySettings> => {
    const settings = (await readWorkspaceSettings(appDataRoot)) ?? ({} as WorkspaceSettings);
    const remote = settings.remote;
    return {
      enabled: remote?.enabled ?? false,
      // No default relay address: the user must enter their own server.
      serverUrl: remote?.serverUrl?.trim() ?? "",
      deviceId: ensureDeviceId(remote?.deviceId),
      deviceName: remote?.deviceName?.trim() || os.hostname(),
      mode: remote?.mode === "full" ? "full" : "readonly",
      pushActivity: remote?.pushActivity ?? "all",
      memorySync: remote?.memorySync ?? {
        enabled: false,
        sessionArchive: false,
        projectDocs: false,
      },
    };
  };
  let remoteSettingsCache: RemoteRelaySettings = {
    enabled: false,
    serverUrl: "",
    deviceId: "",
    deviceName: os.hostname(),
    mode: "readonly",
    pushActivity: "all",
  };
  // Remote maintenance (update / restart of the app itself). Desktops run as
  // the logged-in user — no root helper — so the swap is delegated to a
  // detached helper and the next process reports the outcome from pending.json.
  let remoteBridgeRef: { pushMaintenanceState(state: never): void } | null = null;
  const desktopMaintenance = createDesktopMaintenance({
    dataDir: resolveAppDataRoot(),
    appVersion: () => app.getVersion(),
    execPath: () => process.execPath,
    platform: process.platform,
    arch: process.arch,
    isBusy: () => {
      try {
        return store.listSessions().filter((session) => session.status === "running").length;
      } catch {
        return 0;
      }
    },
    relaunch: () => app.relaunch(),
    exit: () => {
      // app.exit() runs no quit handlers — stop CoCo first or its runtime
      // lease outlives this process and locks the freshly installed/relaunched
      // instance out ("running in another Larry Agent instance").
      try { cocoStartup.stop(); coco.stop(); } catch { /* exiting anyway */ }
      app.exit(0);
    },
    onStateChange: (state) => {
      // Local Settings → Update card live feed (throttled inside the engine).
      broadcastToRenderer("update:state", state);
      // Bridge may not exist yet during startup reconciliation — the
      // reconnect catch-up (bridge welcome → currentState) covers that case.
      try {
        remoteBridgeRef?.pushMaintenanceState(state as never);
      } catch {
        /* not connected — nothing to push to */
      }
    },
  });
  // Late-bound CoCo engine handle for the remote bridge (set once the service
  // starts below; requests only arrive after startup completes).
  let cocoRef: RemoteCocoEngine | null = null;
  const remoteBridge = createRemoteBridge({
    store,
    getSettings: () => remoteSettingsCache,
    getApiKey: () => readApiKeyFromStore(REMOTE_RELAY_CREDENTIAL_ID),
    appVersion: () => app.getVersion(),
    platform: () => `${process.platform} ${os.arch()}`,
    listHiddenToolCards: () => listHiddenToolCards(),
    // Desktop maintenance: update / restart the app process (no host reboot,
    // no remote shell — see execSupported in desktopMaintenance.ts).
    deviceMaintenance: desktopMaintenance,
    deviceCaps: ["maintenance", "coco"],
    // CoCo engine for the web console (cocoSnapshot / cocoCommand). The
    // service is created further down, so the dep resolves lazily; before it
    // starts the bridge answers "unknown action" and the console hides CoCo.
    getCoco: () => cocoRef,
    getComposerSnapshot: async () => {
      const settings = withSettingsDefaults(
        (await readWorkspaceSettings(resolveAppDataRoot())) ?? ({} as WorkspaceSettings),
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
      list: () => listSyncProviders(resolveAppDataRoot()),
      exportOne: (providerId) => exportSyncProvider(resolveAppDataRoot(), providerId),
      upsert: (transfer) => upsertSyncProvider(resolveAppDataRoot(), transfer),
      remove: (baseUrl, modelId) => removeSyncProvider(resolveAppDataRoot(), baseUrl, modelId),
      removeById: (providerId) => removeSyncProviderById(resolveAppDataRoot(), providerId),
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
        const safeBase = basename(name).replace(/[\u0000-\u001f/\\]/g, "") || "upload.bin";
        const filePath = join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeBase}`);
        const bytes = Buffer.from(contentBase64, "base64");
        if (bytes.byteLength === 0 || bytes.byteLength > 8 * 1024 * 1024) return null;
        await writeFile(filePath, bytes);
        // Reuse the desktop picker/drag-drop inference (kind + mime + size)
        // so remote attachments follow the exact Mac wire pipeline.
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
        broadcastToRenderer("remote:status", { status, detail });
      },
      // Streamed token deltas can reach dozens per second; coalesce the
      // indicator pulses to ≤ ~16/s — visually the same blink cadence, a
      // fraction of the IPC traffic.
      onActivity: (() => {
        let last = 0;
        return () => {
          const now = Date.now();
          if (now - last < 60) return;
          last = now;
          broadcastToRenderer("remote:activity", {});
        };
      })(),
      onProvidersChanged: (options) => {
        broadcastToRenderer("llm:providersChanged", {}, options);
      },
    },
  });
  remoteBridgeRef = remoteBridge as unknown as { pushMaintenanceState(state: never): void };
  const remoteStreamSink = (payload: { sessionId: string; event: unknown }) => {
    remoteBridge.handleStreamEvent(payload);
  };
  addAgentStreamSink(remoteStreamSink);
  // Report how the previous self-update ended (the helper restarted us, so
  // the version on disk is the only outcome signal). Runs before connecting:
  // the bridge's welcome catch-up then pushes the settled state.
  void desktopMaintenance.reconcile().finally(() => {
    // Async boot: load settings, persist the ensured deviceId, connect.
    void startRemoteBridgeBoot();
  });
  async function startRemoteBridgeBoot(): Promise<void> {
    remoteSettingsCache = await readRemoteSettings();
    // One-time migration: relay key used to live in macOS Keychain — move it
    // into the same encrypted store as LLM provider keys.
    if (!(await hasApiKeyInStore(REMOTE_RELAY_CREDENTIAL_ID))) {
      const legacy = await readApiKeyFromKeychain(REMOTE_RELAY_CREDENTIAL_ID);
      if (legacy) {
        await writeApiKeyToStore(legacy, REMOTE_RELAY_CREDENTIAL_ID);
        await deleteApiKeyFromKeychain(REMOTE_RELAY_CREDENTIAL_ID).catch(() => {});
      }
    }
    if (!remoteSettingsCache.deviceId) return;
    const persisted = ((await readWorkspaceSettings(appDataRoot)) ?? {}).remote;
    if (!persisted || persisted.deviceId !== remoteSettingsCache.deviceId) {
      await patchWorkspaceSettings(appDataRoot, { remote: { ...remoteSettingsCache } });
    }
    if (remoteSettingsCache.enabled) void remoteBridge.start();
  }
  app.on("before-quit", () => {
    removeAgentStreamSink(remoteStreamSink);
    remoteBridge.stop();
    store.memorySync.stop();
  });

  ipcMain.handle("remote:getConfig", async () => {
    const cfg = await readRemoteSettings();
    remoteSettingsCache = cfg;
    return { config: cfg, hasKey: await hasApiKeyInStore(REMOTE_RELAY_CREDENTIAL_ID) };
  });

  // ── Settings → Update card (local manual upgrade via desktopMaintenance) ─
  const UPDATE_MANIFEST_URL = "https://larryagent.online/download/downloads.json";
  const UPDATE_CHECK_TTL_MS = 5 * 60_000;
  type UpdateCheckEntry = { version: string; url: string; sha256?: string };
  let updateCheckCache: { at: number; entry: UpdateCheckEntry | null; upToDate: boolean } | null = null;
  const messageOf = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);
  const fetchUpdateEntry = async (
    force: boolean,
  ): Promise<{
    entry: UpdateCheckEntry | null;
    checkedAt: number;
    currentVersion: string;
    upToDate: boolean;
  }> => {
    const currentVersion = app.getVersion();
    const upToDated = (entry: UpdateCheckEntry | null): boolean =>
      !entry || compareVersions(entry.version, currentVersion) <= 0;
    if (!force && updateCheckCache && Date.now() - updateCheckCache.at < UPDATE_CHECK_TTL_MS) {
      const { entry, at } = updateCheckCache;
      return { entry, checkedAt: at, currentVersion, upToDate: upToDated(entry) };
    }
    const entry = (await desktopMaintenance.checkUpdate(UPDATE_MANIFEST_URL)) as UpdateCheckEntry | null;
    updateCheckCache = { at: Date.now(), entry, upToDate: upToDated(entry) };
    return {
      entry,
      checkedAt: updateCheckCache.at,
      currentVersion,
      upToDate: updateCheckCache.upToDate,
    };
  };
  ipcMain.handle("update:getState", () => ({
    currentVersion: app.getVersion(),
    platform: `${process.platform} ${os.arch()}`,
    maintenance: desktopMaintenance.currentState(),
    check: updateCheckCache,
  }));
  ipcMain.handle("update:check", async (_event, input: unknown) => {
    const force = (input as { force?: boolean } | undefined)?.force !== false;
    try {
      return { ok: true, ...(await fetchUpdateEntry(force)) };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });
  ipcMain.handle("update:run", async () => {
    try {
      const { entry } = await fetchUpdateEntry(false);
      if (!entry) return { ok: false, error: "no release channel exists for this platform" };
      if (compareVersions(entry.version, app.getVersion()) <= 0) {
        return { ok: false, error: "this app is already on the newest release" };
      }
      const queued = await desktopMaintenance.update({
        source: entry.url,
        ...(entry.sha256 ? { sha256: entry.sha256 } : {}),
        version: entry.version,
      });
      return { ok: true, queued };
    } catch (error) {
      return { ok: false, error: messageOf(error) };
    }
  });

  ipcMain.handle(
    "remote:setConfig",
    async (_event, patch: Record<string, unknown>) => {
      const current = await readRemoteSettings();
      const patchMemorySync = (patch: Record<string, unknown>) => {
        const ms = patch.memorySync;
        if (typeof ms !== "object" || ms === null) return current.memorySync;
        const m = ms as Record<string, unknown>;
        const prev = current.memorySync ?? { enabled: false, sessionArchive: false, projectDocs: false };
        return {
          enabled: typeof m.enabled === "boolean" ? m.enabled : prev.enabled,
          sessionArchive: typeof m.sessionArchive === "boolean" ? m.sessionArchive : prev.sessionArchive,
          projectDocs: typeof m.projectDocs === "boolean" ? m.projectDocs : prev.projectDocs,
        };
      };
      const next: RemoteRelaySettings = {
        enabled: typeof patch.enabled === "boolean" ? patch.enabled : current.enabled,
        serverUrl: typeof patch.serverUrl === "string" && patch.serverUrl.trim() ? patch.serverUrl.trim() : current.serverUrl,
        deviceId: current.deviceId,
        deviceName: typeof patch.deviceName === "string" ? patch.deviceName.trim() || current.deviceName : current.deviceName,
        mode: patch.mode === "full" || patch.mode === "readonly" ? patch.mode : current.mode,
        pushActivity:
          patch.pushActivity === "all" || patch.pushActivity === "active" || patch.pushActivity === "off"
            ? patch.pushActivity
            : current.pushActivity,
        memorySync: patchMemorySync(patch),
      };
      await patchWorkspaceSettings(appDataRoot, { remote: next });
      remoteSettingsCache = next;
      if (next.enabled) await remoteBridge.reconfigure();
      else remoteBridge.stop();
      return { config: next };
    },
  );

  // Fresh per-install identity. Escape hatch for two installs that ended up
  // sharing one deviceId (e.g. a settings backup traveled between machines):
  // the relay lets one identity hold one slot, so shared IDs kick each other
  // on every reconnect.
  ipcMain.handle("remote:regenerateDeviceId", async () => {
    const current = await readRemoteSettings();
    const next: RemoteRelaySettings = { ...current, deviceId: ensureDeviceId(undefined) };
    await patchWorkspaceSettings(appDataRoot, { remote: next });
    remoteSettingsCache = next;
    if (next.enabled) await remoteBridge.reconfigure();
    return { config: next };
  });

  ipcMain.handle("remote:saveKey", async (_event, key: unknown) => {
    if (typeof key !== "string" || !key.trim()) return { ok: false, error: "empty key" };
    await writeApiKeyToStore(key.trim(), REMOTE_RELAY_CREDENTIAL_ID);
    if (remoteSettingsCache.enabled) await remoteBridge.reconfigure();
    return { ok: true };
  });

  ipcMain.handle("remote:getStatus", () => ({
    status: remoteBridge.status(),
  }));

  // ── Memory sync (M2 archive channel) ────────────────────────
  ipcMain.handle("memorySync:syncNow", async () => {
    const outcome = await store.memorySync.syncOnce("manual");
    return { outcome, status: store.memorySync.status() };
  });
  ipcMain.handle("memorySync:fullResync", async () => {
    const outcome = await store.memorySync.fullResync();
    return { outcome, status: store.memorySync.status() };
  });
  ipcMain.handle("memorySync:getStatus", () => ({
    status: store.memorySync.status(),
  }));

  // before-quit snapshot: running turns hold their transcript in memory until
  // the turn ends; flush on quit so a mid-turn exit loses nothing. Boot
  // convergence then normalizes the persisted running rows (cancelled /
  // waiting-for-answer + orphan tool_call sealing).
  app.on("before-quit", () => {
    store.persistRunningSessionsOnQuit();
  });
  // Coco is application-owned on every platform. No independent scheduler.
  setLoopsToolPort(null);
  const coco = createCocoService(appDataRoot, store, (title, body) => appNotify({ title, body, inbox: true }), undefined, {
    onActivity: activity => broadcastToRenderer("coco:activity", activity),
    onChanged: () => broadcastToRenderer("coco:changed", null),
  });
  ipcMain.handle("coco:snapshot", () => coco.engine.snapshot());
  ipcMain.handle("coco:workResults", (_event, workId: string) => coco.workResults(workId));
  ipcMain.handle("coco:activity", () => coco.activity());
  ipcMain.handle("coco:history", (_event, request: { ruleId: string; cursor?: { at: number; id: string } }) => coco.engine.repository.history(request?.ruleId, request?.cursor));
  ipcMain.handle("coco:command", (_event, command: CocoCommand) => coco.engine.command(command));
  ipcMain.handle("coco:handoverSession", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return { ok: false, error: "Missing session id" };
    return coco.handoverSession(sessionId);
  });
  ipcMain.handle("coco:takeBackSession", (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) return { ok: false, error: "Missing session id" };
    // Store-level by design: taking a session back must work while CoCo is
    // disabled, blocked or still initializing (that's when you need it most).
    const result = store.reclaimCocoSession(sessionId);
    if (result.ok) coco.releaseSession(sessionId);
    return result;
  });
  cocoRef = {
    snapshot: () => coco.engine.snapshot(),
    command: (command) => coco.engine.command(command),
  };
  let cocoQuitting = false;
  const cocoStartup = new CocoStartup({
    verify: retireLoopsDaemon,
    blocked: message => coco.engine.setBlocked(message),
    start: () => { if (!cocoQuitting) coco.start(); },
  });
  coco.engine.setBlocked("Checking that the previous scheduler has stopped…");
  const startCoco = (): void => { void cocoStartup.run(); };
  let cocoDrained = false;
  app.on("before-quit", event => {
    if (cocoDrained) return;
    event.preventDefault();
    if (cocoQuitting) return;
    cocoQuitting = true; cocoStartup.stop(); coco.stop();
    void Promise.race([Promise.allSettled([coco.shutdown(), mcpManager.reconcile([])]), new Promise(resolve => setTimeout(resolve, 5000))]).finally(() => { cocoDrained = true; app.quit(); });
  });
  powerMonitor.on("shutdown", () => { cocoStartup.stop(); coco.stop(); void coco.shutdown(); });
  const hooksService = createHooksService(appDataRoot);

  async function resolveActiveWorkspacePath(): Promise<string> {
    const workspaceId = await store.getActiveWorkspaceId();
    if (!workspaceId) return "";
    const workspaces = store.listWorkspaces();
    return workspaces.find((w) => w.id === workspaceId)?.path ?? "";
  }
  setLocalFileDemoWorkspaceRootsResolver(async () => [
    ...store.listWorkspaces().map((w) => w.path),
    cocoHomePath(appDataRoot),
  ]);

  async function persistMcpServers(servers: McpServerConfig[]): Promise<void> {
    await patchToolsConfig({ mcpServers: servers });
    postToolsConfigChanged("mcpServers");
  }

  async function persistSkills(skills: SkillConfig[]): Promise<void> {
    await patchToolsConfig({ skills });
    postToolsConfigChanged("skills");
  }

  async function persistToolPermissionOverrides(): Promise<void> {
    await patchToolsConfig({
      toolPermissionOverrides: getAllToolPermissionOverrides(),
      toolOfferOverrides: getAllToolOfferOverrides(),
      toolDisplayOverrides: getAllToolDisplayOverrides(),
      toolOfferAutoBaseline: getToolOfferAutoBaseline() ?? [],
    });
  }

  async function persistToolOfferState(): Promise<void> {
    await patchToolsConfig({
      toolPermissionOverrides: getAllToolPermissionOverrides(),
      toolOfferOverrides: getAllToolOfferOverrides(),
      toolDisplayOverrides: getAllToolDisplayOverrides(),
      toolOfferAutoBaseline: getToolOfferAutoBaseline() ?? [],
    });
  }

  configureMcpPersistence(persistMcpServers);
  configureSkillsRoot(join(appDataRoot, "skills"));
  configureSkillPersistence(persistSkills);
  configureFsmGraphsRoot(join(appDataRoot, "fsm-graphs"));

  ipcMain.handle("settings:getWorkspace", async () => {
    const settings = await readWorkspaceSettings(appDataRoot);
    return withSettingsDefaults(settings);
  });

  ipcMain.handle("settings:getSnapshot", async () => {
    return buildSettingsSnapshot(appDataRoot);
  });

  ipcMain.handle(
    "settings:saveWorkspace",
    async (_event, raw: unknown) => {
      const rawRec =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const resolved = await patchWorkspaceSettings(appDataRoot, rawRec);
      setToolStatsEnabled(resolved.toolStatsEnabled);
      // Appearance (theme/accent/font scales) is cosmetic and each window
      // keeps its own <html> theme — push the new values to the OTHER
      // windows (subagents, changes, reader) so they follow live instead of
      // only bootstrapping at load. Cosmetic fields only; never the whole
      // settings object.
      if (
        "themeId" in rawRec ||
        "accentColor" in rawRec ||
        "uiFontScale" in rawRec ||
        "chatFontScale" in rawRec
      ) {
        broadcastToRenderer(
          "settings:appearanceChanged",
          {
            themeId: resolved.themeId,
            accentColor: resolved.accentColor ?? null,
            uiFontScale: resolved.uiFontScale,
            chatFontScale: resolved.chatFontScale,
          },
          { exceptWebContentsId: _event.sender.id },
        );
      }
      // Provider/model changes may unblock the delete-archive summarize
      // queue — force-retry so backed-off tasks digest immediately.
      store.retryArchiveQueue();
      // Locally edited providers must reach web consoles too — the Token
      // Hub sync path notifies on its own; settings saves previously didn't.
      // The saving window is excluded: it applies the resolved state itself
      // (applySaved) and must not take the external-change refresh path.
      if ("providers" in rawRec || "activeProviderId" in rawRec) {
        remoteBridge.notifyProvidersChanged({
          exceptWebContentsId: _event.sender.id,
        });
      }
      return resolved;
    },
  );

  // ---- Backup export / import (docs/plans/20260907-settings-export-import.md) ----

  ipcMain.handle(
    "settings:exportBackup",
    async (event, raw: unknown) => {
      const passphrase =
        raw &&
        typeof raw === "object" &&
        typeof (raw as { passphrase?: unknown }).passphrase === "string"
          ? (raw as { passphrase: string }).passphrase
          : "";
      if (!passphrase) {
        return { ok: false, error: "Passphrase is required." };
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const dialogOpts: Electron.SaveDialogOptions = {
        title: "Export settings backup",
        defaultPath: `jellybot-backup-${stamp}${BUNDLE_FILE_EXTENSION}`,
        filters: [{ name: "JellyBot backup", extensions: ["jbbundle"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, dialogOpts)
        : await dialog.showSaveDialog(dialogOpts);
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        const payload = await collectBackup({
          userDataRoot: appDataRoot,
          // CoCo panel settings live in sessions.sqlite (coco_meta) — read
          // via the live engine; collector strips machine-local fields.
          readCocoSettings: () => coco.engine.settings(),
        });
        const bytes = buildBackupBundle(payload, passphrase, app.getVersion());
        await writeFile(result.filePath, bytes);
        return {
          ok: true,
          path: result.filePath,
          sections: payloadSections(payload),
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "settings:importBackupSummary",
    async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const dialogOpts: Electron.OpenDialogOptions = {
        title: "Import settings backup",
        properties: ["openFile"],
        filters: [{ name: "JellyBot backup", extensions: ["jbbundle"] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true };
      }
      const backupPath = result.filePaths[0]!;
      try {
        const header = readBackupHeader(await readFile(backupPath));
        return {
          ok: true,
          path: backupPath,
          version: header.version,
          sections: header.sections,
          exportedAt: header.exportedAt,
          appVersion: header.appVersion,
        };
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle("settings:applyBackup", async (_event, raw: unknown) => {
    const input =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as { path?: unknown; passphrase?: unknown })
        : {};
    const backupPath = typeof input.path === "string" ? input.path.trim() : "";
    const passphrase =
      typeof input.passphrase === "string" ? input.passphrase : "";
    if (!backupPath || !passphrase) {
      return { ok: false, error: "Backup path and passphrase are required." };
    }
    try {
      const payload = openBackupPayload(
        await readFile(backupPath),
        passphrase,
      );
      const result = await applyBackup(payload, {
        userDataRoot: appDataRoot,
        // CoCo settings land in sessions.sqlite — no file to .bak, so the
        // previous value goes to a single-slot coco_meta key first. The
        // engine command path revalidates and applies live (same as the
        // panel's Save), broadcasting the refreshed snapshot.
        writeCocoSettings: async (settings) => {
          coco.engine.repository.setMeta(
            "settingsBackup",
            coco.engine.settings(),
          );
          coco.engine.command({
            type: "settings",
            settings: settings as CocoSettings,
          });
        },
      });
      // A backup restore replaces the whole settings file — the provider
      // list very likely moved, and listComposerOptions caches per device.
      remoteBridge.notifyProvidersChanged();

      // Re-sync runtime state from the replaced files (mirrors the startup
      // sequence in app.whenReady).
      const warnings: string[] = [];
      try {
        const settings = await readWorkspaceSettings(appDataRoot);
        if (settings) {
          setToolStatsEnabled(
            withSettingsDefaults(settings).toolStatsEnabled,
          );
        }
      } catch (err) {
        warnings.push(`settings re-sync failed: ${errText(err)}`);
      }
      try {
        const tools = await readToolsConfig();
        loadToolPermissionOverrides(tools.toolPermissionOverrides);
        loadToolOfferOverrides(tools.toolOfferOverrides);
        loadToolOfferAutoBaseline(tools.toolOfferAutoBaseline);
        loadToolDisplayOverrides(tools.toolDisplayOverrides);
        loadShellSafetyConfig(tools.shellSafety);
        await mcpManager.startFromSettings(tools.mcpServers);
        await skillManager.startFromSettings(tools.skills);
        try {
          await skillManager.reconcileOrphans();
        } catch (err) {
          warnings.push(`skills reconcile failed: ${errText(err)}`);
        }
      } catch (err) {
        warnings.push(`tools/mcp/skills re-sync failed: ${errText(err)}`);
      }

      return {
        ok: true,
        applied: result.applied,
        backups: result.backups,
        warnings,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle(
    "settings:setActiveProvider",
    async (_event, providerId: string) => {
      if (typeof providerId !== "string" || !providerId.trim()) {
        throw new Error("providerId is required");
      }
      const current = withSettingsDefaults(
        await readWorkspaceSettings(appDataRoot),
      );
      if (!current.providers.some((p) => p.id === providerId)) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      // Persists the default for *new* sessions only — does not change
      // existing sessions' providerId.
      return patchWorkspaceSettings(appDataRoot, {
        activeProviderId: providerId,
      });
    },
  );

  ipcMain.handle(
    "settings:setComposerRunMode",
    async (_event, runMode: unknown) => {
      if (runMode !== "agent" && runMode !== "ask" && runMode !== "plan") {
        throw new Error("composerRunMode must be agent, ask, or plan");
      }
      return patchWorkspaceSettings(appDataRoot, {
        composerRunMode: runMode,
      });
    },
  );

  ipcMain.handle(
    "settings:setComposerInfinite",
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("composerInfinite must be a boolean");
      }
      return patchWorkspaceSettings(appDataRoot, {
        composerInfinite: enabled,
      });
    },
  );

  ipcMain.handle(
    "settings:setReasoningEffort",
    async (_event, level: unknown) => {
      if (!isReasoningEffort(level)) {
        throw new Error("reasoningEffort must be off|low|medium|high|max");
      }
      return patchWorkspaceSettings(appDataRoot, {
        reasoningEffort: level,
      });
    },
  );

  /** Global composer voice-mode flag (⌥⌃); app-wide, restored on start. */
  ipcMain.handle(
    "settings:setComposerVoiceMode",
    async (_event, enabled: unknown) => {
      if (typeof enabled !== "boolean") {
        throw new Error("composerVoiceMode must be a boolean");
      }
      return patchWorkspaceSettings(appDataRoot, {
        composerVoiceMode: enabled,
      });
    },
  );

  /** Atomic Infinite + Reasoning Max combo (Cmd+Shift+M). */
  ipcMain.handle(
    "settings:setComposerPowerCombo",
    async (
      _event,
      raw: unknown,
    ) => {
      const rec =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as Record<string, unknown>)
          : {};
      const infinite = rec.composerInfinite;
      const reasoningEffort = rec.reasoningEffort;
      if (typeof infinite !== "boolean") {
        throw new Error("composerInfinite must be a boolean");
      }
      if (!isReasoningEffort(reasoningEffort)) {
        throw new Error("reasoningEffort must be off|low|medium|high|max");
      }
      return patchWorkspaceSettings(appDataRoot, {
        composerInfinite: infinite,
        reasoningEffort,
      });
    },
  );

  ipcMain.handle(
    "settings:setApiKey",
    async (
      _event,
      req: { providerId?: string; apiKey?: string; clear?: boolean },
    ) => {
      const settings = withSettingsDefaults(
        await readWorkspaceSettings(appDataRoot),
      );
      const providerId =
        typeof req.providerId === "string" && req.providerId.trim()
          ? req.providerId.trim()
          : settings.activeProviderId;
      const known =
        settings.imageGenProviders.some((p) => p.id === providerId) ||
        providerId === OBJECT_STORAGE_CREDENTIAL_ID ||
        settings.providers.some((p) => p.id === providerId);
      if (!known) {
        throw new Error(`Unknown provider: ${providerId}`);
      }
      if (req.clear === true) {
        await deleteApiKeyFromStore(providerId);
        return { apiKeyConfigured: false };
      }
      if (typeof req.apiKey !== "string") {
        throw new Error("API key is required");
      }
      await writeApiKeyToStore(req.apiKey, providerId);
      return { apiKeyConfigured: true };
    },
  );

  ipcMain.handle(
    "llm:checkHealth",
    async (_event, req: { providerId?: string }) => {
      const settings = withSettingsDefaults(
        await readWorkspaceSettings(appDataRoot),
      );
      const providerId =
        typeof req?.providerId === "string" && req.providerId.trim()
          ? req.providerId.trim()
          : settings.activeProviderId;
      const provider =
        settings.providers.find((p) => p.id === providerId) ??
        resolveActiveProvider(settings);
      const apiKey =
        (await readApiKeyFromStore(provider.id)) ??
        (isLocalLlmBaseUrl(provider.baseUrl) ? "local" : null);
      if (!apiKey) {
        return { ok: false, providerId: provider.id, reason: "missing_key" };
      }
      // Some gateways have no GET models route and require streaming model
      // requests. Use the configured protocol and no tools, then cancel the
      // body after status headers. Protocol detection itself is URL-only.
      const probeChatEndpoint = async (): Promise<
        { ok: true; providerId: string } | { ok: false; providerId: string; reason: string }
      > => {
        const protocol = resolveLlmApiProtocol(provider);
        const chatUrl = modelEndpoint(provider, protocol);
        const response = await fetch(chatUrl, {
          method: "POST",
          headers: withLlmUserAgent({
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          }),
          body: JSON.stringify(protocol === "responses" ? {
            model: provider.modelId,
            max_output_tokens: 16,
            stream: true,
            store: false,
            input: [{ role: "user", content: "ping" }],
          } : {
            model: provider.modelId,
            max_tokens: 1,
            stream: true,
            messages: [{ role: "user", content: "ping" }],
          }),
          signal: AbortSignal.timeout(8_000),
        });
        // Status headers are enough to judge auth + model + route validity;
        // cancel immediately so the server stops generating.
        try {
          await response.body?.cancel();
        } catch {
          // Body already closed — nothing to do.
        }
        if (!response.ok) {
          return {
            ok: false,
            providerId: provider.id,
            reason: `http_${response.status}`,
          };
        }
        return { ok: true, providerId: provider.id };
      };

      // Real LLM traffic (streamChatCompletion / chatCompletionOnce) records
      // endpoint activity on every successful response. Within the window the
      // gate answers healthy without a network request; otherwise in-flight /
      // just-finished probes are shared across all composer callers.
      const healthIdentity = llmEndpointKey({
        baseUrl: provider.baseUrl,
        apiKey,
        model: provider.modelId,
        ...(provider.apiProtocol ? { apiProtocol: provider.apiProtocol } : {}),
        ...(provider.rawEndpoint === true ? { rawEndpoint: true } : {}),
      });

      try {
        return await checkLlmHealthGated(
          { identity: healthIdentity },
          {
            probe: async () => {
              if (provider.rawEndpoint === true) {
                // An arbitrary full endpoint has no inferable models path.
                return await probeChatEndpoint();
              }
              const response = await fetch(
                providerApiEndpoint(provider.baseUrl, "models"),
                {
                  method: "GET",
                  headers: withLlmUserAgent({
                    Authorization: `Bearer ${apiKey}`,
                  }),
                  signal: AbortSignal.timeout(8_000),
                },
              );
              if (response.ok) {
                return { ok: true, providerId: provider.id };
              }
              if (response.status === 404 || response.status === 405) {
                // Gateway has no models route — fall back to a real chat probe.
                return await probeChatEndpoint();
              }
              return {
                ok: false,
                providerId: provider.id,
                reason: `http_${response.status}`,
              };
            },
          },
        );
      } catch {
        return { ok: false, providerId: provider.id, reason: "network" };
      }
    },
  );

  // Provider setup wizard: enumerate models on a gateway the wizard is
  // about to add — no providerId resolution (the profile does not exist
  // yet). Runs in main, so no renderer CORS concerns.
  ipcMain.handle(
    "llm:probeModels",
    async (
      _event,
      req: { baseUrl?: unknown; apiKey?: unknown },
    ): Promise<ProbeModelsResult> => {
      return probeLlmModels({
        baseUrl: typeof req?.baseUrl === "string" ? req.baseUrl : "",
        apiKey: typeof req?.apiKey === "string" ? req.apiKey : "",
      });
    },
  );

  // Startup onboarding gate — single source of truth for "no usable
  // provider": store key / local base URL / .env JELLYBOT_API_KEY (process
  // env first, then the active workspace's .env file).
  ipcMain.handle(
    "llm:hasUsableProvider",
    async (): Promise<{ usable: boolean }> => {
      const settings = withSettingsDefaults(
        await readWorkspaceSettings(appDataRoot),
      );
      let envApiKey = process.env.JELLYBOT_API_KEY?.trim() ?? "";
      if (!envApiKey) {
        try {
          const activeId = await store.getActiveWorkspaceId();
          const ws = activeId
            ? store.listWorkspaces().find((w) => w.id === activeId)
            : undefined;
          if (ws) {
            const raw = readFileSync(
              join(assertWorkspacePath(ws.path), ".env"),
              "utf8",
            );
            for (const line of raw.split("\n")) {
              const trimmed = line.trim();
              if (!trimmed || trimmed.startsWith("#")) continue;
              const eq = trimmed.indexOf("=");
              if (eq < 0) continue;
              if (trimmed.slice(0, eq) === "JELLYBOT_API_KEY") {
                const value = trimmed.slice(eq + 1).trim();
                if (value) envApiKey = value;
                break;
              }
            }
          }
        } catch {
          // optional
        }
      }
      return {
        usable: await hasUsableLlmProvider({
          providers: settings.providers,
          hasKeyInStore: (providerId) => hasApiKeyInStore(providerId),
          envApiKey: envApiKey || null,
        }),
      };
    },
  );

  ipcMain.handle(
    "llm:getProviderBalance",
    (_event, req: { providerId?: string }) =>
      getProviderBalance(
        appDataRoot,
        typeof req?.providerId === "string" ? req.providerId : undefined,
      ),
  );

  // Tray usage popup: the footer's Refresh passes { force: true } to bypass
  // the 60s cache.
  ipcMain.handle(
    "llm:getProviderUsage",
    (_event, req: { force?: boolean }) =>
      getProviderUsage(appDataRoot, { force: req?.force === true }),
  );

  // Composer `/opt` — one-shot prompt optimization before sending
  // (docs/plans/20260828-composer-prompt-optimizer.md). Provider resolution
  // follows llm:checkHealth (explicit providerId → session's provider →
  // active provider); inline on purpose — the turn runtime resolves clients
  // with a project path this process does not track, and the health-check
  // precedent skips the .env key fallback the same way.
  ipcMain.handle(
    "llm:optimizePrompt",
    async (
      _event,
      req: { text?: string; sessionId?: string; providerId?: string },
    ): Promise<{ text: string } | { error: string }> => {
      try {
        const text = typeof req?.text === "string" ? req.text : "";
        if (!text.trim()) return { error: "Empty prompt" };
        let providerId =
          typeof req?.providerId === "string" ? req.providerId.trim() : "";
        if (!providerId) {
          const sessionId =
            typeof req?.sessionId === "string" ? req.sessionId.trim() : "";
          const session = sessionId ? store.getSession(sessionId) : null;
          providerId = session?.providerId?.trim() ?? "";
        }
        const settings = withSettingsDefaults(
          await readWorkspaceSettings(appDataRoot),
        );
        const provider =
          (providerId
            ? settings.providers.find((p) => p.id === providerId)
            : undefined) ?? resolveActiveProvider(settings);
        const apiKey =
          (await readApiKeyFromStore(provider.id)) ??
          (isLocalLlmBaseUrl(provider.baseUrl) ? "local" : "");
        if (!apiKey) {
          return { error: `Missing API key for provider "${provider.name}"` };
        }
        const optimized = await optimizeUserPromptOnce({
          text,
          client: {
            baseUrl: provider.baseUrl,
            apiKey,
            model: provider.modelId,
            ...(provider.apiProtocol ? { apiProtocol: provider.apiProtocol } : {}),
            ...(provider.rawEndpoint === true ? { rawEndpoint: true } : {}),
          },
          ...(req?.sessionId ? { sessionId: req.sessionId } : {}),
        });
        if (!optimized) return { error: "Optimization failed" };
        return { text: optimized };
      } catch (err) {
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("agent:listSessions", async () => store.listSessions());

  ipcMain.handle("agent:getSession", async (_event, sessionId: string) => {
    return sessionForPresentation(store.getSession(sessionId));
  });

  ipcMain.handle("agent:downloadResponseFile", async (_event, request: ResponseFileDownloadRequest): Promise<ResponseFileDownloadResult> => {
    try {
      if (!request || typeof request.sessionId !== "string" || typeof request.messageId !== "string" || typeof request.fileId !== "string") {
        return { ok: false, error: "Invalid file reference" };
      }
      const current = store.getSession(request.sessionId);
      const reference = current ? findResponseFileReference(current, request) : null;
      if (!current || !reference) return { ok: false, error: "This file is not referenced by the selected response" };
      const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
      let sourceClient: import("../llm/types.js").OpenAiCompatibleClientConfig | undefined;
      for (const provider of settings.providers) {
        try {
          const candidate = await resolveLlmClientForWorkspace(current.workspacePath, provider.id);
          if (reference.model) candidate.model = reference.model;
          if (reasoningScopeForClient(candidate) === reference.providerScope) { sourceClient = candidate; break; }
        } catch { /* Another profile may own this response. */ }
      }
      if (!sourceClient) return { ok: false, error: "The original provider configuration is needed to download this file" };
      const filename = (reference.filename.replace(/\\/g, "/").split("/").at(-1) ?? "")
        .replace(/[\u0000-\u001f<>:"|?*]/g, "_").replace(/[. ]+$/, "").slice(0, 180) || "response-file";
      const save = await dialog.showSaveDialog({ title: "Save response file", defaultPath: join(app.getPath("downloads"), filename) });
      if (save.canceled || !save.filePath) return { ok: false, cancelled: true };
      const downloaded = await downloadResponseFile(sourceClient, reference);
      await writeFile(save.filePath, downloaded.bytes);
      return { ok: true, path: save.filePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  ipcMain.handle(
    "agent:getSessionTail",
    async (_event, sessionId: string, opts?: { turns?: number }) => {
      return sessionTailForPresentation(store.getSessionTail(sessionId, opts));
    },
  );

  ipcMain.handle(
    "agent:getMessagesBefore",
    async (
      _event,
      sessionId: string,
      beforeMessageId: string,
      opts?: { turns?: number },
    ) => {
      return messageWindowForPresentation(store.getMessagesBefore(sessionId, beforeMessageId, opts));
    },
  );

  /** Object Storage (S3/COS) connectivity probe: PUT + DELETE a probe object. */
  ipcMain.handle(
    "settings:testObjectStorage",
    async (
      _event,
      req?: { objectStorage?: ObjectStorageConfig },
    ): Promise<
      { ok: true; message: string } | { ok: false; message: string }
    > => {
      const settings = withSettingsDefaults(
        await readWorkspaceSettings(appDataRoot),
      );
      const candidate = normalizeObjectStorageConfig(
        req?.objectStorage ?? settings.objectStorage ?? null,
      );
      if (!candidate) {
        return { ok: false, message: "Object storage config is incomplete" };
      }
      const secretAccessKey = await readApiKeyFromStore(
        OBJECT_STORAGE_CREDENTIAL_ID,
      ).catch(() => null);
      if (!secretAccessKey) {
        return {
          ok: false,
          message:
            "Secret Access Key is not set — paste it in the card first",
        };
      }
      try {
        await testConnection({
          config: candidate,
          secretAccessKey,
        });
        return { ok: true, message: "Connection OK — bucket is writable" };
      } catch (err) {
        if (err instanceof S3Error) {
          const hint =
            err.status === 403
              ? " (check keys / bucket permissions)"
              : err.status === 404
                ? " (check bucket name / region / endpoint)"
                : "";
          return { ok: false, message: `${err.message}${hint}` };
        }
        return {
          ok: false,
          message: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "agent:getSubagent",
    async (_event, sessionId: string, subagentId: string) => {
      return subagentDetailForPresentation(store.getSubagent(sessionId, subagentId));
    },
  );

  ipcMain.handle(
    "agent:listRunningSubagents",
    async (_event, sessionId: string) => {
      return store.listRunningSubagents(sessionId);
    },
  );

  ipcMain.handle("agent:listSubagents", async (_event, sessionId: string) => {
    return store.listSubagents(sessionId);
  });

  ipcMain.handle(
    "agent:getSubagentTranscript",
    async (_event, sessionId: string, subagentId: string) => {
      const transcript = store.getSubagentTranscript(sessionId, subagentId);
      if (!transcript) return null;
      return {
        run: transcript.run,
        messages: messagesForPresentation(transcript.messages),
      };
    },
  );

  ipcMain.handle(
    "subagentsWindow:open",
    async (event, sessionId: unknown): Promise<{ ok: true }> => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        throw new Error("sessionId must be a non-empty string");
      }
      const owner = BrowserWindow.fromWebContents(event.sender);
      await openSubagentsWindow({
        sessionId,
        owner,
        iconPath: resolveAppIconPath(),
      });
      return { ok: true };
    },
  );

  ipcMain.handle("agent:searchSessions", async (_event, query: string) => {
    return store.searchSessions(typeof query === "string" ? query : "");
  });

  ipcMain.handle("fsm:graphConfig", (_event, mode: unknown) => {
    const parsed = parseFsmGraphMode(mode);
    return parsed ? fsmGraphViewForMode(parsed) : null;
  });

  ipcMain.handle("fsm:graphViewById", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) return null;
    const record = await getFsmGraph(id.trim());
    if (!record) return null;
    return {
      ...fsmGraphViewFromConfig(record.config),
      mode: "custom",
      graphId: record.id,
      name: record.name,
    };
  });

  ipcMain.handle("fsm:listGraphs", async () => listFsmGraphs());

  ipcMain.handle("fsm:listComposerGraphs", async () => listComposerGraphs());

  ipcMain.handle("fsm:getGraph", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) return null;
    return getFsmGraph(id.trim());
  });

  ipcMain.handle("fsm:saveGraph", async (_event, raw: unknown) => {
    try {
      return await saveFsmGraph(raw as Parameters<typeof saveFsmGraph>[0]);
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Failed to save FSM graph",
      );
    }
  });

  ipcMain.handle("fsm:deleteGraph", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) return;
    const graphId = id.trim();
    // Guard first: running sessions block deletion, idle ones switch to Auto.
    store.detachFsmGraphFromSessions(graphId);
    await deleteFsmGraph(graphId);
  });

  ipcMain.handle(
    "fsm:setGraphEnabled",
    async (_event, id: unknown, enabled: unknown) => {
      if (typeof id !== "string" || !id.trim()) return null;
      const graphId = id.trim();
      if (enabled !== true) {
        // Guard first: running sessions block disabling, idle ones flip to Auto.
        store.detachFsmGraphFromSessions(graphId);
      }
      try {
        return await setFsmGraphEnabled(graphId, enabled === true);
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Failed to update FSM graph",
        );
      }
    },
  );

  ipcMain.handle("fsm:createGraph", async (_event, name: unknown) => {
    const record = createNewGraphRecord(
      typeof name === "string" ? name : "Untitled graph",
    );
    try {
      return await saveFsmGraph(record);
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Failed to create graph",
      );
    }
  });

  ipcMain.handle(
    "fsm:forkBuiltinGraph",
    async (_event, mode: unknown, name: unknown) => {
      const parsed =
        mode === "react" ||
        mode === "react_v2" ||
        mode === "ask" ||
        mode === "plan_execute" ||
        mode === "subagent"
          ? mode
          : null;
      if (!parsed) {
        throw new Error("Invalid built-in graph mode");
      }
      const record = createForkFromBuiltin(
        parsed,
        typeof name === "string" ? name : undefined,
      );
      try {
        return await saveFsmGraph(record);
      } catch (err) {
        throw new Error(
          err instanceof Error ? err.message : "Failed to fork built-in graph",
        );
      }
    },
  );

  ipcMain.handle("fsm:builtinTemplates", () => listBuiltinTemplates());

  ipcMain.handle("fsm:validateGraph", (_event, config: unknown) => {
    try {
      validateGraphConfig(config as Parameters<typeof validateGraphConfig>[0]);
      return { ok: true as const };
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Graph validation failed",
      );
    }
  });

  ipcMain.handle("fsm:graphView", (_event, config: unknown) => {
    if (!config || typeof config !== "object") return null;
    return fsmGraphViewFromConfig(
      config as Parameters<typeof fsmGraphViewFromConfig>[0],
    );
  });

  ipcMain.handle("fsm:actionCatalog", () => listActionCatalog());

  ipcMain.handle(
    "agent:startTurn",
    async (
      _event,
      req: {
        sessionId?: string;
        workspaceId?: string;
        providerId?: string;
        userText: string;
        fullPermissions: boolean;
        autoSkillSummarize?: boolean;
        runMode?: "agent" | "ask" | "plan";
        planMode?: boolean;
        reasoningEffort?: ReasoningEffort;
        composerInfinite?: boolean;
        attachments?: AttachmentDraft[];
      },
    ) => {
      if ("cocoExecutionId" in req) throw new Error("Internal execution capability cannot be supplied through IPC");
      return store.startTurn(req);
    },
  );

  ipcMain.handle("agent:cancelTurn", async (_event, sessionId: string) => {
    return store.cancelTurn(sessionId);
  });

  // Take-once STOP-rollback prompt (cancel before any model content).
  ipcMain.handle(
    "agent:takePromptRestore",
    async (_event, sessionId: string) => {
      return store.takePromptRestore(sessionId);
    },
  );

  ipcMain.handle("agent:pauseTurn", async (_event, sessionId: string) => {
    return store.pauseTurn(sessionId);
  });

  ipcMain.handle(
    "agent:resumeTurn",
    async (
      _event,
      req: {
        sessionId: string;
        fullPermissions: boolean;
        autoSkillSummarize?: boolean;
      },
    ) => {
      return store.resumeTurn(req);
    },
  );

  ipcMain.handle(
    "agent:compactSession",
    async (
      _event,
      sessionId: string,
      options?: { protectTokenRatio?: number },
    ) => {
      return store.compactSession(sessionId, undefined, options);
    },
  );

  ipcMain.handle("agent:clearSession", async (_event, sessionId: string) => {
    return store.clearSession(sessionId);
  });

  ipcMain.handle("agent:endSession", async (_event, sessionId: string) => {
    return store.endSession(sessionId);
  });

  ipcMain.handle(
    "agent:abortToolCall",
    async (
      _event,
      req: { sessionId: string; toolCallId: string },
    ): Promise<{ stopped: boolean }> => {
      return {
        stopped: abortToolCall(req.sessionId, req.toolCallId),
      };
    },
  );

  ipcMain.handle(
    "agent:enqueuePrompt",
    async (
      _event,
      req: {
        sessionId: string;
        userText: string;
        attachments?: AttachmentDraft[];
        mode?: "deferred" | "interrupt";
      },
    ) => store.enqueuePrompt(req),
  );

  ipcMain.handle("agent:listPromptQueue", async (_event, sessionId: string) => {
    return store.listPromptQueue(sessionId);
  });

  ipcMain.handle(
    "agent:removeQueuedPrompt",
    async (_event, sessionId: string, promptId: string) => {
      return store.removeQueuedPrompt(sessionId, promptId);
    },
  );

  ipcMain.handle(
    "agent:updateQueuedPromptText",
    async (_event, sessionId: string, promptId: string, text: string) => {
      return store.updateQueuedPromptText(sessionId, promptId, text);
    },
  );

  ipcMain.handle(
    "agent:removeTurnError",
    async (_event, sessionId: string, messageId: string) => {
      return store.removeTurnError(sessionId, messageId);
    },
  );

  ipcMain.handle(
    "agent:promoteQueuedPrompt",
    async (_event, sessionId: string, promptId: string) => {
      return store.promoteQueuedPrompt(sessionId, promptId);
    },
  );

  ipcMain.handle(
    "agent:deferQueuedPrompt",
    async (_event, sessionId: string, promptId: string) => {
      return store.deferQueuedPrompt(sessionId, promptId);
    },
  );

  ipcMain.handle(
    "agent:moveQueuedPromptToFront",
    async (_event, sessionId: string, promptId: string) => {
      return store.moveQueuedPromptToFront(sessionId, promptId);
    },
  );

  ipcMain.handle(
    "agent:setSessionProvider",
    async (_event, sessionId: string, providerId: string) => {
      return sessionForPresentation(await store.setSessionProvider(sessionId, providerId));
    },
  );

  ipcMain.handle(
    "agent:setComposerPrefs",
    async (
      _event,
      sessionId: string,
      patch: {
        runMode?: "agent" | "ask" | "plan" | "custom" | null;
        fsmGraphId?: string | null;
        infinite?: boolean | null;
        reasoningEffort?: ReasoningEffort | null;
        handoffEnabled?: boolean | null;
      },
    ) => {
      return sessionForPresentation(await store.setComposerPrefs(sessionId, patch ?? {}));
    },
  );

  ipcMain.handle("agent:deleteSession", async (_event, sessionId: string) => {
    return store.deleteSession(sessionId);
  });

  ipcMain.handle(
    "session:setArchived",
    async (
      _event,
      req: { sessionId: string; archived: boolean },
    ) => {
      if (
        !req ||
        typeof req.sessionId !== "string" ||
        typeof req.archived !== "boolean"
      ) {
        throw new Error("session:setArchived requires {sessionId, archived}");
      }
      return store.setSessionArchived(req.sessionId, req.archived);
    },
  );

  ipcMain.handle(
    "agent:respondToolApproval",
    async (
      _event,
      req: { requestId: string; approved: boolean },
    ) => {
      return store.respondToolApproval(req);
    },
  );

  // ── VCS credential prompt (annotate / push / svn update) ──
  // Mirrors the tool-approval request/respond pattern: the main process
  // broadcasts `vcs:authRequest`, the renderer shows the dialog and answers
  // via `vcs:authRespond`; vcsAuth routes the response to the awaiting waiter.
  ipcMain.handle("vcs:authRespond", async (_event, req: VcsAuthResponse) => {
    if (!req || typeof req.requestId !== "string" || !req.requestId) {
      throw new Error("vcs:authRespond requires {requestId, credentials}");
    }
    const accepted = resolveVcsAuthResponse(req);
    return { ok: accepted };
  });

  ipcMain.handle(
    "agent:respondUserAsk",
    async (
      _event,
      req: import("../agent/ipcTypes.js").UserAskResponseRequest,
    ) => {
      return store.respondUserAsk(req);
    },
  );

  ipcMain.handle(
    "agent:approvePlan",
    async (_event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return { ok: false as const, error: "Missing session id." };
      }
      return store.approvePlan(sessionId.trim());
    },
  );

  ipcMain.handle(
    "agent:discardPlan",
    async (_event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) {
        return { ok: false as const, error: "Missing session id." };
      }
      return store.discardPlan(sessionId.trim());
    },
  );

  ipcMain.handle(
    "agent:listPendingToolApprovals",
    async (_event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) return [];
      return store.listPendingToolApprovals(sessionId.trim());
    },
  );

  ipcMain.handle(
    "agent:listPendingUserAsks",
    async (_event, sessionId: string) => {
      if (typeof sessionId !== "string" || !sessionId.trim()) return [];
      return store.listPendingUserAsks(sessionId.trim());
    },
  );

  ipcMain.handle("workspace:list", async () => store.listWorkspaces());

  ipcMain.handle(
    "workspace:create",
    async (_event, req: { name: string; path: string }) => {
      // origin is CoCo-internal provenance; renderer requests cannot set it.
      return store.createWorkspace({ name: req.name, path: req.path });
    },
  );

  // New-workspace template flow (menu → scaffold → progress → register).
  ipcMain.handle("workspace:listTemplates", async () =>
    store.listWorkspaceTemplates(),
  );

  ipcMain.handle(
    "workspace:inspectTemplateInit",
    async (
      _event,
      req: { path: string; templateId: WorkspaceTemplateId },
    ) => {
      if (
        !req ||
        typeof req.path !== "string" ||
        !req.path.trim() ||
        !isWorkspaceTemplateId(req.templateId)
      ) {
        throw new Error(
          "workspace:inspectTemplateInit requires {path, templateId}",
        );
      }
      return store.inspectWorkspaceInit(req);
    },
  );

  ipcMain.handle("workspace:createFromTemplate", (event, req: unknown) =>
    store.createWorkspaceFromTemplate(req, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("workspace:initProgress", progress);
      }
    }),
  );

  ipcMain.handle("workspace:cancelTemplateInit", (_event, runId: unknown) => {
    if (typeof runId !== "string" || !runId) {
      throw new Error("workspace:cancelTemplateInit requires a runId");
    }
    return cancelWorkspaceTemplateInit(runId);
  });

  ipcMain.handle(
    "workspace:update",
    async (_event, req: { id: string; name?: string; path?: string }) => {
      return store.updateWorkspace(req);
    },
  );

  ipcMain.handle("workspace:delete", async (_event, workspaceId: string) => {
    return store.deleteWorkspace(workspaceId);
  });

  ipcMain.handle("workspace:listArchived", async () =>
    store.listArchivedWorkspaces(),
  );

  ipcMain.handle(
    "workspace:setArchived",
    async (
      _event,
      req: { workspaceId: string; archived: boolean },
    ) => {
      if (
        !req ||
        typeof req.workspaceId !== "string" ||
        typeof req.archived !== "boolean"
      ) {
        throw new Error("workspace:setArchived requires {workspaceId, archived}");
      }
      return store.setWorkspaceArchived(req.workspaceId, req.archived);
    },
  );

  ipcMain.handle("workspace:getActive", async () => {
    return store.getActiveWorkspaceId();
  });

  ipcMain.handle(
    "workspace:setActive",
    async (_event, workspaceId: string) => {
      return store.setActiveWorkspaceId(workspaceId);
    },
  );

  ipcMain.handle("workspace:pickFolder", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }
    return result.filePaths[0] ?? null;
  });

  // Old clients receive an explicit migration response and cannot resurrect launchd.
  for (const channel of ["list", "listRuns", "create", "update", "delete", "setEnabled", "daemonStatus", "installDaemon", "ensureDaemon", "repairDaemon", "stopDaemon", "uninstallDaemon"]) {
    ipcMain.handle(`loops:${channel}`, () => { throw new Error("Loops has been upgraded to Coco. Open Coco to manage your work and rules."); });
  }

  /** Native confirm — window.confirm is unreliable in Electron. */
  ipcMain.handle(
    "dialog:confirm",
    async (
      event,
      req: { message?: unknown; detail?: unknown; title?: unknown },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const message =
        typeof req?.message === "string" && req.message.trim()
          ? req.message.trim()
          : "Are you sure?";
      const detail =
        typeof req?.detail === "string" && req.detail.trim()
          ? req.detail.trim()
          : undefined;
      const title =
        typeof req?.title === "string" && req.title.trim()
          ? req.title.trim()
          : "Confirm";
      const options: Electron.MessageBoxOptions = {
        type: "warning",
        buttons: ["Cancel", "Delete"],
        defaultId: 0,
        cancelId: 0,
        title,
        message,
      };
      if (detail) options.detail = detail;
      const result = win
        ? await dialog.showMessageBox(win, options)
        : await dialog.showMessageBox(options);
      return result.response === 1;
    },
  );

  /** Native alert — prefer over window.alert for focus safety. */
  ipcMain.handle(
    "dialog:alert",
    async (
      event,
      req: { message?: unknown; title?: unknown; type?: unknown },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const message =
        typeof req?.message === "string" && req.message.trim()
          ? req.message.trim()
          : "";
      const title =
        typeof req?.title === "string" && req.title.trim()
          ? req.title.trim()
          : "Notice";
      const type =
        req?.type === "error" || req?.type === "info" || req?.type === "warning"
          ? req.type
          : "info";
      const options: Electron.MessageBoxOptions = {
        type,
        buttons: ["OK"],
        defaultId: 0,
        title,
        message: message || "Something went wrong.",
      };
      if (win) {
        await dialog.showMessageBox(win, options);
      } else {
        await dialog.showMessageBox(options);
      }
    },
  );

  ipcMain.handle("tools:list", async () => {
    registerBuiltins();
    return listToolCatalogGrouped();
  });

  ipcMain.handle(
    "tools:setPermissionLevel",
    async (
      _event,
      req: { name?: unknown; level?: unknown },
    ) => {
      registerBuiltins();
      if (typeof req?.name !== "string" || !req.name.trim()) {
        throw new Error("tool name is required");
      }
      const level = req.level;
      if (level !== 0 && level !== 1 && level !== 2) {
        throw new Error("permission level must be 0, 1, or 2");
      }
      const updated = setToolCatalogPermission(
        req.name,
        level as PermissionLevel,
      );
      await persistToolPermissionOverrides();
      return updated;
    },
  );

  ipcMain.handle("tools:getShellSafety", () => {
    return getToolsConfigCached().shellSafety;
  });

  ipcMain.handle(
    "tools:setShellSafety",
    async (
      _event,
      req: { enabled?: unknown; fatalPolicy?: unknown },
    ) => {
      const patch: ShellSafetyOptions = {
        ...getToolsConfigCached().shellSafety,
      };
      if (req?.enabled !== undefined) {
        if (typeof req.enabled !== "boolean") {
          throw new Error("enabled must be a boolean");
        }
        patch.enabled = req.enabled;
      }
      if (req?.fatalPolicy !== undefined) {
        if (req.fatalPolicy !== "ask" && req.fatalPolicy !== "block") {
          throw new Error("fatalPolicy must be \"ask\" or \"block\"");
        }
        patch.fatalPolicy = req.fatalPolicy;
      }
      const updated = await patchToolsConfig({ shellSafety: patch });
      loadShellSafetyConfig(updated.shellSafety);
      return updated.shellSafety;
    },
  );

  ipcMain.handle(
    "tools:setOffer",
    async (
      _event,
      req: { name?: unknown; include?: unknown },
    ) => {
      registerBuiltins();
      if (typeof req?.name !== "string" || !req.name.trim()) {
        throw new Error("tool name is required");
      }
      if (typeof req?.include !== "boolean") {
        throw new Error("include must be a boolean");
      }
      const updated = setToolCatalogOffer(req.name.trim(), req.include);
      await persistToolOfferState();
      return updated;
    },
  );

  ipcMain.handle("tools:autoOrganizeOffers", async () => {
    registerBuiltins();
    const result = autoOrganizeToolOffers();
    await persistToolOfferState();
    return result;
  });

  ipcMain.handle(
    "tools:setDisplay",
    async (
      _event,
      req: { name?: unknown; visible?: unknown },
    ) => {
      registerBuiltins();
      if (typeof req?.name !== "string" || !req.name.trim()) {
        throw new Error("tool name is required");
      }
      if (typeof req?.visible !== "boolean") {
        throw new Error("visible must be a boolean");
      }
      const updated = setToolCatalogDisplay(req.name.trim(), req.visible);
      await patchToolsConfig({
        toolDisplayOverrides: getAllToolDisplayOverrides(),
      });
      return updated;
    },
  );

  ipcMain.handle("tools:hiddenCards", async () => {
    return listHiddenToolCards();
  });

  ipcMain.handle("mcp:list", async () => {
    return mcpManager.listRuntime();
  });

  ipcMain.handle(
    "mcp:upsert",
    async (_event, raw: unknown) => {
      const input = raw as McpServerUpsertInput;
      if (!input || typeof input !== "object") {
        throw new Error("MCP server payload is required");
      }
      if (typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("MCP server name is required");
      }
      if (!input.transport || typeof input.transport !== "object") {
        throw new Error("MCP transport is required");
      }
      registerBuiltins();
      const upsert: McpServerUpsertInput = {
        name: input.name,
        enabled: input.enabled !== false,
        transport: input.transport,
      };
      if (typeof input.id === "string" && input.id.trim()) {
        upsert.id = input.id.trim();
      }
      const runtime = await mcpManager.upsertServer(upsert);
      return runtime;
    },
  );

  ipcMain.handle(
    "mcp:remove",
    async (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("serverId is required");
      }
      const id = serverId.trim();
      await mcpManager.removeServer(id);
      const prefix = mcpToolNamePrefixForServer(id);
      const removedPerm = clearToolPermissionOverridesWithPrefix(prefix);
      const removedOffer = clearToolOfferOverridesWithPrefix(prefix);
      if (removedPerm.length > 0 || removedOffer.length > 0) {
        await persistToolOfferState();
      }
      return true;
    },
  );

  ipcMain.handle(
    "mcp:setEnabled",
    async (
      _event,
      req: { id?: unknown; enabled?: unknown },
    ) => {
      if (typeof req?.id !== "string" || !req.id.trim()) {
        throw new Error("id is required");
      }
      if (typeof req.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      registerBuiltins();
      const runtime = await mcpManager.setEnabled(req.id.trim(), req.enabled);
      return runtime;
    },
  );

  ipcMain.handle(
    "mcp:reconnect",
    async (_event, serverId: unknown) => {
      if (typeof serverId !== "string" || !serverId.trim()) {
        throw new Error("serverId is required");
      }
      registerBuiltins();
      return mcpManager.reconnect(serverId.trim());
    },
  );

  ipcMain.handle("mcp:reload", async () => {
    registerBuiltins();
    await mcpManager.reloadFromDisk();
    return mcpManager.listRuntime();
  });

  ipcMain.handle("skills:list", async () => {
    return skillManager.listRecords();
  });

  ipcMain.handle(
    "skills:upsert",
    async (_event, raw: unknown) => {
      const input = raw as SkillUpsertInput;
      if (!input || typeof input !== "object") {
        throw new Error("Skill payload is required");
      }
      if (typeof input.name !== "string" || !input.name.trim()) {
        throw new Error("Skill name is required");
      }
      if (typeof input.description !== "string" || !input.description.trim()) {
        throw new Error("Skill description is required");
      }
      const upsert: SkillUpsertInput = {
        name: input.name,
        description: input.description,
        body: typeof input.body === "string" ? input.body : "",
        enabled: input.enabled !== false,
      };
      if (typeof input.id === "string" && input.id.trim()) {
        upsert.id = input.id.trim();
      }
      return skillManager.upsertSkill(upsert);
    },
  );

  ipcMain.handle(
    "skills:remove",
    async (_event, skillId: unknown) => {
      if (typeof skillId !== "string" || !skillId.trim()) {
        throw new Error("skillId is required");
      }
      await skillManager.removeSkill(skillId.trim());
      return true;
    },
  );

  ipcMain.handle(
    "skills:setEnabled",
    async (
      _event,
      req: { id?: unknown; enabled?: unknown },
    ) => {
      if (typeof req?.id !== "string" || !req.id.trim()) {
        throw new Error("id is required");
      }
      if (typeof req.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      return skillManager.setEnabled(req.id.trim(), req.enabled);
    },
  );

  ipcMain.handle(
    "skills:installZip",
    async (
      event,
      raw?: { overwrite?: unknown },
    ) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const dialogOpts: Electron.OpenDialogOptions = {
        title: "Install skill package",
        properties: ["openFile"],
        filters: [{ name: "Skill package", extensions: ["zip"] }],
      };
      const result = win
        ? await dialog.showOpenDialog(win, dialogOpts)
        : await dialog.showOpenDialog(dialogOpts);
      if (result.canceled || result.filePaths.length === 0) {
        return null;
      }
      const zipPath = result.filePaths[0]!;
      let overwrite = raw?.overwrite === true;
      try {
        return await skillManager.installFromZip(zipPath, {
          overwrite,
          enabled: true,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to install skill.";
        if (!overwrite && /already installed|already exists/i.test(message)) {
          const confirmOpts: Electron.MessageBoxOptions = {
            type: "warning",
            buttons: ["Cancel", "Overwrite"],
            defaultId: 1,
            cancelId: 0,
            title: "Replace existing skill?",
            message: message,
            detail:
              "Overwrite will replace the existing skill package(s) with the same name.",
          };
          const confirm = win
            ? await dialog.showMessageBox(win, confirmOpts)
            : await dialog.showMessageBox(confirmOpts);
          if (confirm.response !== 1) {
            return null;
          }
          overwrite = true;
          return await skillManager.installFromZip(zipPath, {
            overwrite: true,
            enabled: true,
          });
        }
        throw err;
      }
    },
  );

  ipcMain.handle("hooks:list", async () => {
    const workspacePath = await resolveActiveWorkspacePath();
    return hooksService.list(workspacePath);
  });

  ipcMain.handle("hooks:reload", async () => {
    const workspacePath = await resolveActiveWorkspacePath();
    return hooksService.reload(workspacePath);
  });

  ipcMain.handle("memory:get", async (): Promise<UserMemorySnapshot> => {
    return loadUserMemory();
  });

  ipcMain.handle(
    "memory:save",
    async (_event, raw: unknown): Promise<UserMemorySnapshot> => {
      const profile =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? (raw as { profile?: unknown }).profile
          : undefined;
      if (typeof profile !== "string") {
        throw new Error("profile must be a string");
      }
      return setUserMemoryProfile(profile);
    },
  );

  ipcMain.handle("memory:clear", async (): Promise<UserMemorySnapshot> => {
    return clearUserMemory();
  });

  async function resolveProjectMemoryWorkspacePath(
    raw: unknown,
  ): Promise<string> {
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      const rec = raw as { workspacePath?: unknown; workspaceId?: unknown };
      if (typeof rec.workspacePath === "string" && rec.workspacePath.trim()) {
        return assertWorkspacePath(rec.workspacePath);
      }
      if (typeof rec.workspaceId === "string" && rec.workspaceId.trim()) {
        const workspaceId = rec.workspaceId.trim();
        const ws = store.listWorkspaces().find((w) => w.id === workspaceId);
        if (!ws) throw new Error(`Unknown workspace: ${workspaceId}`);
        return assertWorkspacePath(ws.path);
      }
    }
    const activeId = await store.getActiveWorkspaceId();
    if (!activeId) throw new Error("No active workspace");
    const ws = store.listWorkspaces().find((w) => w.id === activeId);
    if (!ws) throw new Error("Active workspace not found");
    return assertWorkspacePath(ws.path);
  }

  ipcMain.handle(
    "projectMemory:get",
    async (_event, raw: unknown): Promise<ProjectMemorySnapshot> => {
      const workspacePath = await resolveProjectMemoryWorkspacePath(raw ?? {});
      return loadProjectMemory(workspacePath);
    },
  );

  ipcMain.handle(
    "projectMemory:save",
    async (_event, raw: unknown): Promise<ProjectMemorySnapshot> => {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("Invalid project memory save payload");
      }
      const rec = raw as { body?: unknown; workspacePath?: unknown; workspaceId?: unknown };
      if (typeof rec.body !== "string") {
        throw new Error("body must be a string");
      }
      const workspacePath = await resolveProjectMemoryWorkspacePath(rec);
      // Never clamps: over-target bodies are stored as-is (soft target only).
      return setProjectMemoryBody(workspacePath, rec.body);
    },
  );

  ipcMain.handle(
    "projectMemory:clear",
    async (_event, raw: unknown): Promise<ProjectMemorySnapshot> => {
      const workspacePath = await resolveProjectMemoryWorkspacePath(raw ?? {});
      return clearProjectMemory(workspacePath);
    },
  );

  function assertWorkspacePath(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) {
      throw new Error("workspacePath is required");
    }
    const cwd = raw.trim();
    if (!isAbsolute(cwd)) {
      throw new Error("workspacePath must be absolute");
    }
    return cwd;
  }

  /**
   * Workspace-relative pathspec for a scoped commit. Undefined means the whole
   * working tree (the Conversation footer's Commit).
   */
  function normalizeCommitPaths(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const paths = raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith("-"));
    return paths.length > 0 ? paths : undefined;
  }

  async function resolveLlmClientForWorkspace(
    workspacePath: string,
    providerId?: string,
  ): Promise<import("../llm/types.js").OpenAiCompatibleClientConfig> {
    const settings = withSettingsDefaults(
      await readWorkspaceSettings(appDataRoot),
    );
    // Prefer the caller's (session) provider when it still exists in
    // settings; fall back to the global active provider.
    const wanted = providerId?.trim();
    const fromSession = wanted
      ? settings.providers.find((p) => p.id === wanted)
      : undefined;
    const provider = fromSession ?? resolveActiveProvider(settings);
    let envKey: string | null = null;
    try {
      const raw = readFileSync(join(workspacePath, ".env"), "utf8");
      for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eq = trimmed.indexOf("=");
        if (eq < 0) continue;
        if (trimmed.slice(0, eq) === "JELLYBOT_API_KEY") {
          const value = trimmed.slice(eq + 1).trim();
          envKey = value.length > 0 ? value : null;
          break;
        }
      }
    } catch {
      // optional
    }
    const apiKey =
      (await readApiKeyFromStore(provider.id)) ??
      envKey ??
      process.env.JELLYBOT_API_KEY?.trim() ??
      "";
    if (!apiKey) {
      throw new Error(
        `Missing API key for provider "${provider.name}". Add it in Setting.`,
      );
    }
    return {
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.modelId,
      ...(provider.apiProtocol ? { apiProtocol: provider.apiProtocol } : {}),
      ...(provider.rawEndpoint === true ? { rawEndpoint: true } : {}),
    };
  }

  ipcMain.handle(
    "git:workingTreeStats",
    async (_event, workspacePath: unknown): Promise<WorkingTreeStats> => {
      const cwd = assertWorkspacePath(workspacePath);
      return getWorkingTreeStats(cwd);
    },
  );

  ipcMain.handle(
    "git:pathsDiffStats",
    async (_event, paths: unknown): Promise<PathDiffStats[]> => {
      if (!Array.isArray(paths)) return [];
      const absolutePaths = paths.filter(
        (p): p is string => typeof p === "string" && p.trim().length > 0,
      );
      return getPathsDiffStats(absolutePaths);
    },
  );

  ipcMain.handle(
    "git:listChanges",
    async (_event, workspacePath: unknown): Promise<WorkingTreeChangesResult> => {
      const cwd = assertWorkspacePath(workspacePath);
      return listWorkingTreeChanges(cwd);
    },
  );

  ipcMain.handle(
    "git:pathDiff",
    async (
      _event,
      workspacePath: unknown,
      relativePath: unknown,
    ): Promise<WorkingTreePathDiff> => {
      const cwd = assertWorkspacePath(workspacePath);
      if (typeof relativePath !== "string" || !relativePath.trim()) {
        throw new Error("relativePath must be a non-empty string");
      }
      return getWorkingTreePathDiff(cwd, relativePath);
    },
  );

  ipcMain.handle(
    "workspaceChanges:open",
    async (event, workspacePath: unknown): Promise<{ ok: true }> => {
      const cwd = assertWorkspacePath(workspacePath);
      const owner = BrowserWindow.fromWebContents(event.sender);
      openWorkspaceChangesWindow({
        workspacePath: cwd,
        owner,
        iconPath: resolveAppIconPath(),
      });
      return { ok: true };
    },
  );

  ipcMain.handle("workspaceChanges:close", async (): Promise<{ ok: true }> => {
    closeWorkspaceChangesWindow();
    return { ok: true };
  });

  ipcMain.handle(
    "fileReader:open",
    async (event, targetPath: unknown): Promise<{ ok: true }> => {
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        throw new Error("targetPath must be a non-empty string");
      }
      const owner = BrowserWindow.fromWebContents(event.sender);
      openFileReaderWindow({
        path: targetPath,
        owner,
        iconPath: resolveAppIconPath(),
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "git:prepareCommit",
    async (
      _event,
      workspacePath: unknown,
      providerId: unknown,
      paths: unknown,
    ): Promise<PrepareCommitResult> => {
      const cwd = assertWorkspacePath(workspacePath);
      const scope = normalizeCommitPaths(paths);
      const context = await collectCommitContext(cwd, scope);
      if (!context) {
        throw new Error("No changes to commit");
      }
      const stats: WorkingTreeStats = {
        isRepo: true,
        insertions: context.insertions,
        deletions: context.deletions,
        dirtyFileCount: context.dirtyFileCount,
        // Unused by the popover display; satisfies the shared stats shape.
        aheadCount: 0,
      };
      try {
        const client = await resolveLlmClientForWorkspace(
          cwd,
          typeof providerId === "string" ? providerId : undefined,
        );
        const generated = await generateCommitMessage({
          workspacePath: cwd,
          context,
          client,
        });
        return {
          draftMessage: generated.message,
          messageSource: generated.source,
          stats,
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        agentLogWarn("git.commit_message.unavailable", {
          workspacePath: cwd,
          message,
        });
        return {
          draftMessage: fallbackCommitMessage(stats),
          messageSource: "fallback",
          stats,
        };
      }
    },
  );

  ipcMain.handle(
    "git:commit",
    async (_event, req: unknown): Promise<CommitResult> => {
      if (!req || typeof req !== "object" || Array.isArray(req)) {
        throw new Error("Invalid commit request");
      }
      const body = req as {
        workspacePath?: unknown;
        message?: unknown;
        paths?: unknown;
      };
      const cwd = assertWorkspacePath(body.workspacePath);
      if (typeof body.message !== "string") {
        throw new Error("message must be a string");
      }
      const scope = normalizeCommitPaths(body.paths);
      const created = await commitPaths(cwd, body.message, scope);
      // A commit only touches .git (invisible to the fs watcher) — drop the
      // status cache and nudge the renderer so badges/gutters refresh now.
      invalidateVcsStatusCache(cwd);
      broadcastToRenderer("vcs:changed", { rootPath: cwd });
      return {
        ok: true,
        hash: created.hash,
        shortHash: created.shortHash,
        message: created.message,
        subject: created.subject,
        vcs: created.vcs,
      };
    },
  );

  ipcMain.handle(
    "git:push",
    async (
      _event,
      workspacePath: unknown,
    ): Promise<{ ok: boolean; message?: string; output?: string }> => {
      const cwd = assertWorkspacePath(workspacePath);
      const result = await pushToRemote(cwd);
      if (result.ok) {
        // Push only moves refs inside .git (invisible to the fs watcher) —
        // nudge the renderer so any open footer's Push (ahead count) resets.
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return result;
    },
  );

  ipcMain.handle(
    "attachments:pickFiles",
    async (
      _event,
      mode: "images" | "files" = "files",
    ): Promise<AttachmentDraft[]> => {
      const pickMode = mode === "images" ? "images" : "files";
      const filters =
        pickMode === "images"
          ? [
              {
                name: "Images",
                extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"],
              },
            ]
          : [
              { name: "All Files", extensions: ["*"] },
              {
                name: "Documents",
                extensions: ["pdf", "txt", "md", "csv", "json", "xml"],
              },
              {
                name: "Source",
                extensions: [
                  "ts",
                  "tsx",
                  "js",
                  "jsx",
                  "py",
                  "rs",
                  "go",
                  "java",
                  "c",
                  "cpp",
                  "h",
                  "swift",
                  "kt",
                ],
              },
            ];
      const result = await dialog.showOpenDialog({
        properties: ["openFile", "multiSelections"],
        filters,
      });
      if (result.canceled || result.filePaths.length === 0) {
        return [];
      }

      let drafts: AttachmentDraft[] = [];
      try {
        drafts = await buildAttachmentDrafts(result.filePaths);
        if (pickMode === "images") {
          drafts = drafts.filter((draft) => draft.kind === "image");
        }
      } catch {
        drafts = [];
      }
      return drafts;
    },
  );

  ipcMain.handle(
    "attachments:resolvePaths",
    async (_event, rawPaths: unknown): Promise<AttachmentDraft[]> => {
      if (!Array.isArray(rawPaths)) return [];
      const paths = rawPaths.filter(
        (item): item is string => typeof item === "string" && !!item.trim(),
      );
      if (paths.length === 0) return [];
      try {
        return await buildAttachmentDrafts(paths);
      } catch {
        return [];
      }
    },
  );

  ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      return "Invalid path";
    }
    return shell.openPath(targetPath.trim());
  });

  ipcMain.handle(
    "shell:saveFileAs",
    async (
      _event,
      sourcePath: unknown,
    ): Promise<{
      ok: boolean;
      canceled?: boolean;
      path?: string;
      error?: string;
    }> => {
      if (typeof sourcePath !== "string" || !sourcePath.trim()) {
        return { ok: false, error: "Invalid source path." };
      }
      const source = sourcePath.trim();
      try {
        const info = await stat(source);
        if (!info.isFile()) {
          return { ok: false, error: "Source is not a file." };
        }
      } catch {
        return { ok: false, error: "Source file not found." };
      }
      const name = basename(source);
      const ext = extname(name).replace(/^\./, "").toLowerCase();
      const filters = ext
        ? [
            { name: "Files", extensions: [ext] },
            { name: "All Files", extensions: ["*"] },
          ]
        : [{ name: "All Files", extensions: ["*"] }];
      const result = await dialog.showSaveDialog({
        title: "Save File",
        defaultPath: name,
        filters,
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        await mkdir(dirname(result.filePath), { recursive: true });
        await copyFile(source, result.filePath);
        return { ok: true, path: result.filePath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle("shell:openExternal", async (_event, url: unknown) => {
    if (typeof url !== "string" || !isSafeExternalHttpUrl(url)) {
      return false;
    }
    openExternalHttpUrl(url);
    return true;
  });

  ipcMain.handle("shell:showItemInFolder", async (_event, targetPath: string) => {
    if (typeof targetPath !== "string" || !targetPath.trim()) {
      return false;
    }
    shell.showItemInFolder(targetPath.trim());
    return true;
  });

  ipcMain.handle(
    "shell:trashItem",
    async (
      _event,
      targetPath: string,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (typeof targetPath !== "string" || !targetPath.trim()) {
        return { ok: false, message: "Invalid path" };
      }
      try {
        await shell.trashItem(targetPath.trim());
        return { ok: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message };
      }
    },
  );

  ipcMain.handle(
    "fs:readTextFile",
    (_event, targetPath: string): Promise<TextFilePreviewResult> =>
      readTextFilePreview(targetPath),
  );

  ipcMain.handle(
    "fs:filterExistingFiles",
    (_event, paths: unknown): Promise<string[]> =>
      filterExistingFilePaths(paths),
  );

  // ------------------------------------------------------------- Dev Mode
  ipcMain.handle("devmode:listDir", (_event, targetPath: unknown) =>
    listDevModeDir(targetPath),
  );

  ipcMain.handle("devmode:runExecutable", (_event, targetPath: unknown) =>
    runDevModeExecutable(targetPath),
  );

  ipcMain.handle("devmode:readProjectFile", (_event, targetPath: unknown) =>
    readProjectFile(targetPath),
  );

  // Unreal engine source root for a workspace (local / sibling / registry).
  // The outline needs it to point the engine's own project at the engine
  // tree instead of the game root UBT's project layout implies.
  ipcMain.handle(
    "devmode:engineRoot",
    async (_event, rootPath: unknown): Promise<string | null> => {
      if (typeof rootPath !== "string" || !rootPath.trim()) return null;
      try {
        return await resolveUeEngineSourceRoot(rootPath.trim());
      } catch {
        return null;
      }
    },
  );

  ipcMain.handle(
    "devmode:resolveSourcePath",
    (_event, rootPath: unknown, sourcePath: unknown) =>
      resolveDevModeSourcePath(rootPath, sourcePath),
  );

  ipcMain.handle(
    "devmode:searchFiles",
    (
      _event,
      rootPath: unknown,
      query: unknown,
      options?: DevModeSearchOptions | null,
    ) => searchDevModeFiles(rootPath, query, options ?? undefined),
  );

  /**
   * Streaming file index for Quick Open. The engine tree is far too big to
   * hand over in one reply, so batches are pushed on `devmode:indexChunk` as
   * the walk produces them and the renderer's index grows live.
   *
   * Completion rides the same channel (`done: true`) rather than the invoke
   * reply: cross-channel delivery order is not guaranteed, so resolving the
   * promise separately could report "finished" ahead of the last batch.
   *
   * One walk per window — the cancel key omits the request id so starting a
   * new index (workspace switch) supersedes the previous one automatically.
   */
  ipcMain.handle(
    "devmode:indexFiles",
    async (
      event,
      rootPath: unknown,
      requestId: unknown,
      options?: DevModeSearchOptions | null,
    ): Promise<{ ok: boolean; message?: string }> => {
      if (typeof rootPath !== "string" || !rootPath.trim()) {
        return { ok: false, message: "Invalid path" };
      }
      if (!Number.isInteger(requestId)) {
        return { ok: false, message: "A request id is required" };
      }
      const sender = event.sender;
      const id = requestId as number;
      const cancelKey = `devmode-index:${sender.id}`;
      const post = (payload: {
        requestId: number;
        files: Array<{ path: string; rel: string }>;
        done: boolean;
        truncated: boolean;
      }): void => {
        if (sender.isDestroyed()) return;
        sender.send("devmode:indexChunk", payload);
      };
      const result = await searchDevModeFiles(
        rootPath,
        "",
        { ...(options ?? {}), listAll: true },
        {
          cancelKey,
          onBatch: (files) =>
            post({ requestId: id, files, done: false, truncated: false }),
        },
      );
      if (!result.ok) return { ok: false, message: result.message };
      post({ requestId: id, files: [], done: true, truncated: result.truncated });
      return { ok: true };
    },
  );

  ipcMain.handle("devmode:indexCancel", (event) => {
    cancelDevModeWalk(`devmode-index:${event.sender.id}`);
  });

  ipcMain.handle("devmode:watch", (_event, rootPath: unknown) => {
    const result = startDevModeWatch(rootPath, (payload) => {
      broadcastToRenderer("devmode:fsEvent", payload);
      cppSymbols.onFsEvents(payload);
    });
    // .git/.svn sit behind the fs watcher's dot-dir filter — a commit only
    // touches those, so the badges need this dedicated metadata watcher.
    if (result.ok && typeof rootPath === "string" && rootPath.trim()) {
      cppSymbols.start(rootPath);
      startVcsChangeWatch(rootPath, (root) =>
        broadcastToRenderer("vcs:changed", { rootPath: root }),
      );
    }
    return result;
  });

  ipcMain.handle("devmode:unwatch", (_event, rootPath: unknown) => {
    stopDevModeWatch(rootPath);
    if (typeof rootPath === "string" && rootPath.trim()) {
      stopVcsChangeWatch(rootPath);
      cppSymbols.stopIfRoot(rootPath);
      clangd.stopIfRoot(rootPath);
    }
    return { ok: true };
  });

  ipcMain.handle(
    CPP_SYMBOL_LOOKUP_CHANNEL,
    (_event, rootPath: unknown, word: unknown) => {
      if (typeof rootPath !== "string" || typeof word !== "string") return [];
      return cppSymbols.lookup(rootPath, word);
    },
  );
  ipcMain.handle(
    CPP_SYMBOL_COMPLETE_CHANNEL,
    (_event, rootPath: unknown, request: unknown) => {
      if (typeof rootPath !== "string" || !request || typeof request !== "object") return [];
      const req = request as Record<string, unknown>;
      if (typeof req.prefix !== "string") return [];
      const str = (value: unknown) =>
        typeof value === "string" && /^[A-Za-z_]\w*$/.test(value) ? value : undefined;
      const container = str(req.container);
      const memberOf = str(req.memberOf);
      const receiver = str(req.receiver);
      const chain = parseCompletionChain(req.chain);
      return cppSymbols.complete(rootPath, {
        prefix: req.prefix,
        ...(container ? { container } : {}),
        ...(memberOf ? { memberOf } : {}),
        ...(receiver ? { receiver } : {}),
        ...(chain ? { chain } : {}),
        ...(typeof req.limit === "number" ? { limit: req.limit } : {}),
      });
    },
  );
  ipcMain.handle(
    CPP_USAGE_SEARCH_CHANNEL,
    (
      _event,
      rootPath: unknown,
      request: CppUsageSearchRequest | null,
    ) => {
      if (
        typeof rootPath !== "string" ||
        !request ||
        typeof request.queryId !== "string" ||
        typeof request.word !== "string"
      ) {
        return {
          queryId: request?.queryId ?? "",
          matches: [],
          scannedFiles: 0,
          truncated: false,
        };
      }
      return cppSymbols.findUsages(rootPath, request);
    },
  );
  ipcMain.handle(CPP_USAGE_CANCEL_CHANNEL, (_event, queryId: unknown) => {
    if (typeof queryId === "string") cppSymbols.cancelFindUsages(queryId);
    return { ok: true };
  });

  // User-added symbol-index roots (engine source directories, …).
  ipcMain.handle(
    CPP_SYMBOL_ROOTS_CHANNEL,
    (_event, rootPath: unknown) => {
      if (typeof rootPath !== "string") {
        return { ok: false as const, message: "Missing workspace path." };
      }
      return cppSymbols.extraRootsOf(rootPath);
    },
  );
  ipcMain.handle(
    CPP_SYMBOL_ADD_ROOT_CHANNEL,
    (_event, rootPath: unknown, dir: unknown) => {
      if (typeof rootPath !== "string" || typeof dir !== "string") {
        return {
          ok: false as const,
          message: "Expected workspace and directory paths.",
        };
      }
      return cppSymbols.addExtraRoot(rootPath, dir);
    },
  );
  ipcMain.handle(
    CPP_SYMBOL_REMOVE_ROOT_CHANNEL,
    (_event, rootPath: unknown, dir: unknown) => {
      if (typeof rootPath !== "string" || typeof dir !== "string") {
        return {
          ok: false as const,
          message: "Expected workspace and directory paths.",
        };
      }
      return cppSymbols.removeExtraRoot(rootPath, dir);
    },
  );

  ipcMain.handle("fs:readFileForEditor", (_event, targetPath: unknown) =>
    readFileForEditor(targetPath),
  );

  ipcMain.handle(
    "fs:writeTextFile",
    async (
      _event,
      raw: unknown,
    ): Promise<{ ok: true } | { ok: false; message: string }> => {
      if (!raw || typeof raw !== "object") {
        return { ok: false, message: "Invalid request" };
      }
      const req = raw as {
        path?: unknown;
        content?: unknown;
        addBom?: unknown;
      };
      return writeTextFileGuarded(
        req.path,
        req.content,
        req.addBom === true,
        store.listWorkspaces().map((w) => w.path),
      );
    },
  );

  ipcMain.handle("diagnostics:getProcessMetrics", async (): Promise<ProcessMetrics> => {
    return readProcessMetrics();
  });

  ipcMain.handle("diagnostics:getRecentLogs", async (): Promise<LogEntry[]> => {
    return mainLogBuffer.snapshot();
  });

  /** Loose parse for optional sessionId filters on toolStats handlers. */
  const sessionIdFromRaw = (raw: unknown): string | undefined =>
    raw &&
    typeof raw === "object" &&
    "sessionId" in raw &&
    typeof (raw as { sessionId?: unknown }).sessionId === "string" &&
    (raw as { sessionId: string }).sessionId.trim()
      ? (raw as { sessionId: string }).sessionId.trim()
      : undefined;

  ipcMain.handle("toolStats:getSummary", async (_event, raw?: unknown) => {
    const sessionId = sessionIdFromRaw(raw);
    return getToolStatsSummary(sessionId ? { sessionId } : undefined);
  });

  ipcMain.handle(
    "toolStats:listFailures",
    async (
      _event,
      raw?: { name?: string; limit?: number; offset?: number },
    ) => {
      const name =
        raw && typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : undefined;
      const limit =
        raw && typeof raw.limit === "number" ? Math.floor(raw.limit) : 50;
      const offset =
        raw && typeof raw.offset === "number" ? Math.floor(raw.offset) : 0;
      const sessionId = sessionIdFromRaw(raw);
      return listToolStatsInvocations({
        status: "failure",
        ...(name ? { name } : {}),
        ...(sessionId ? { sessionId } : {}),
        limit,
        offset,
      });
    },
  );

  ipcMain.handle(
    "toolStats:listInvocations",
    async (
      _event,
      raw?: { name?: string; limit?: number; offset?: number },
    ) => {
      const name =
        raw && typeof raw.name === "string" && raw.name.trim()
          ? raw.name.trim()
          : undefined;
      const limit =
        raw && typeof raw.limit === "number" ? Math.floor(raw.limit) : 100;
      const offset =
        raw && typeof raw.offset === "number" ? Math.floor(raw.offset) : 0;
      const sessionId = sessionIdFromRaw(raw);
      return listToolStatsInvocations({
        ...(name ? { name } : {}),
        ...(sessionId ? { sessionId } : {}),
        limit,
        offset,
      });
    },
  );

  ipcMain.handle(
    "toolStats:getInvocation",
    async (_event, id: unknown) => {
      if (typeof id !== "string" || !id.trim()) return null;
      return getToolStatsInvocation(id.trim());
    },
  );

  ipcMain.handle("toolStats:getEnabled", async () => {
    return isToolStatsEnabled();
  });

  ipcMain.handle("toolStats:reset", async () => {
    const removed = resetToolStats();
    console.log(`[tool-stats] reset removed ${removed} invocation rows`);
    return removed;
  });

  ipcMain.handle("llmTimeline:list", async (_event, sessionId: unknown) => {
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      return { records: [], truncatedCount: 0 };
    }
    return listLlmTimeline(sessionId.trim());
  });

  subscribeLlmTimeline((sessionId) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("llmTimeline:updated", { sessionId });
    }
  });

  ipcMain.handle(
    "diagnostics:getFullRequestLog",
    async (): Promise<boolean> => {
      return isFullLlmRequestLogEnabled();
    },
  );

  ipcMain.handle(
    "diagnostics:setFullRequestLog",
    async (_event, enabled: unknown): Promise<boolean> => {
      setFullLlmRequestLog(enabled === true);
      return isFullLlmRequestLogEnabled();
    },
  );

  ipcMain.handle(
    "diagnostics:openLogsFolder",
    async (): Promise<{ ok: boolean; path?: string; error?: string }> => {
      const logsDir = getAgentLogsDir();
      if (!logsDir) {
        return { ok: false, error: "Log directory is not configured." };
      }
      try {
        await mkdir(logsDir, { recursive: true });
        const openError = await shell.openPath(logsDir);
        if (openError) {
          return { ok: false, path: logsDir, error: openError };
        }
        return { ok: true, path: logsDir };
      } catch (err) {
        return {
          ok: false,
          path: logsDir,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

  ipcMain.handle(
    "diagnostics:saveLogs",
    async (
      _event,
      content: unknown,
    ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }> => {
      if (typeof content !== "string") {
        return { ok: false, error: "Invalid log content." };
      }
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const result = await dialog.showSaveDialog({
        title: "Save Logs",
        defaultPath: `app-logs-${stamp}.log`,
        filters: [
          { name: "Log files", extensions: ["log", "txt"] },
          { name: "All Files", extensions: ["*"] },
        ],
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        await writeFile(result.filePath, content, "utf8");
        return { ok: true, path: result.filePath };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: message };
      }
    },
  );

  ipcMain.handle(
    "storage:getUsage",
    async (): Promise<StorageUsage> => {
      return scanStorageUsage(resolveAppDataRoot());
    },
  );

  ipcMain.handle(
    "storage:cleanup",
    async (): Promise<CleanupResult> => {
      // Release Chromium's in-memory HTTP cache first; the disk cache dirs
      // (Cache / Code Cache / …) are removed by cleanupStorage and rebuilt
      // on demand.
      try {
        await session.defaultSession.clearCache();
      } catch (err) {
        console.warn("[storage-cleanup] clearCache failed", err);
      }
      return cleanupStorage(resolveAppDataRoot());
    },
  );

  return startCoco;
}

/**
 * Staging directory for web-console composer uploads. Remote startTurn
 * attachments must resolve inside this directory (prefix-checked in the
 * remote bridge) so the console can never attach arbitrary device files.
 */
function remoteUploadDir(): string {
  return join(app.getPath("temp"), "jellybot-remote-uploads");
}

/** http(s) only — used for conversation / markdown links opened in the browser. */
function isSafeExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Defer Launch Services handoff so setWindowOpenHandler / will-navigate
 * return immediately (sync openExternal can stall the main process on macOS).
 */
function openExternalHttpUrl(url: string): void {
  if (!isSafeExternalHttpUrl(url)) return;
  setImmediate(() => {
    void shell.openExternal(url).catch((err) => {
      console.error("[shell] openExternal failed", err);
    });
  });
}

/** Navigations that must stay inside our BrowserWindow. */
function isAllowedInAppNavigation(url: string): boolean {
  if (url === "about:blank") return true;
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "file:") return true;
    if (parsed.protocol === "jellybot-file:") return true;
    const dev = process.env.ELECTRON_RENDERER_URL;
    if (dev) {
      const allowed = new URL(dev);
      if (parsed.origin === allowed.origin) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Windows resident-mode state. `mainWindow` backs the tray's show action
 * (and stays accurate across recreate paths); `residentTrayReady` arms
 * close-to-tray only after the tray icon exists (a hidden app with no tray
 * icon would be unreachable); `isQuitting` marks real quit paths (tray
 * Quit, app.quit, OS shutdown) so the close interceptor steps aside.
 */
let mainWindow: BrowserWindow | undefined;
let residentTrayReady = false;
let isQuitting = false;

async function createWindow(iconPath: string | undefined): Promise<void> {
  const isMac = process.platform === "darwin";
  // Translucent renderer surfaces composite over the native background, so
  // it must follow the persisted theme (see windowTheme.ts).
  const backgroundColor = await resolveWindowBackground();

  const win = new BrowserWindow({
    width: 1400,
    height: 930,
    minWidth: 800,
    minHeight: 560,
    title: "Larry Agent",
    ...(iconPath ? { icon: iconPath } : {}),
    show: false,
    backgroundColor: isMac ? "#00000000" : backgroundColor,
    // trafficLightPosition is macOS-only (ignored on Windows, where TitleBarView
    // draws its own caption buttons — see windowControls.ts).
    titleBarStyle: "hidden",
    // 12px traffic lights vertically centered in the 32px title bar:
    // (32 - 12) / 2 = 10 — Electron accepts fractional offsets.
    trafficLightPosition: { x: 14, y: 10 },
    roundedCorners: true,
    ...(isMac
      ? {
          vibrancy: "sidebar" as const,
          visualEffectState: "active" as const,
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  // Push maximize state to the renderer's caption buttons (Windows only).
  attachWindowControlsEvents(win);
  mainWindow = win;

  // Windows resident mode: the close button hides to the tray instead of
  // quitting (both the native title bar and the self-drawn TitleBarView
  // button end up here). Real quits set isQuitting first; if the tray
  // failed to create, keep plain close-to-quit.
  win.on("close", (event) => {
    if (!residentTrayReady || isQuitting) return;
    event.preventDefault();
    win.hide();
    notifyHiddenToTrayOnce();
  });

  const reveal = (): void => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  };
  win.once("ready-to-show", reveal);
  // Failsafe if ready-to-show never fires (e.g. load edge cases).
  setTimeout(reveal, 2500);

  // F12 is parked here so Chromium never opens DevTools (use Cmd+Opt+I /
  // Ctrl+Shift+I). Plain F12 → Go to Definition; Shift+F12 → Find Usages.
  win.webContents.on("before-input-event", (event, input) => {
    const action = classifyF12Shortcut(input);
    if (!action) return;
    event.preventDefault();
    if (input.isAutoRepeat || win.isDestroyed()) return;
    if (action === "find-usages") {
      win.webContents.send(EDITOR_FIND_USAGES_CHANNEL);
      return;
    }
    win.webContents.send(EDITOR_GO_TO_DEFINITION_CHANNEL);
  });

  // Dev Mode close-tab chord: ⌘W on macOS (the default menu's Close Window
  // accelerator would otherwise quit the window outright) and Ctrl+F4 on
  // Windows. Main only parks the keystroke — the renderer closes one file
  // tab per press and asks for a real window close through `window:close`
  // once no tabs remain (AppShellController decides).
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    const matches =
      process.platform === "darwin"
        ? input.meta &&
          !input.control &&
          !input.alt &&
          !input.shift &&
          input.key.toLowerCase() === "w"
        : input.control &&
          !input.meta &&
          !input.alt &&
          !input.shift &&
          input.key === "F4";
    if (!matches) return;
    // Swallow the keystroke either way — this also stops the menu
    // accelerator and held-key repeats (holding ⌘W must not close every
    // tab or the window at once).
    event.preventDefault();
    if (input.isAutoRepeat || win.isDestroyed()) return;
    win.webContents.send(WINDOW_CLOSE_REQUEST_CHANNEL);
  });

  const loadRenderer = (): void => {
    if (win.isDestroyed()) return;
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL);
    } else {
      void win.loadFile(join(__dirname, "../renderer/index.html"));
    }
  };

  // A rebuild of this app empties out/renderer, so a load that lands mid-build
  // finds no index.html. Retry with backoff instead of leaving a blank window.
  let loadAttempts = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  win.webContents.on("did-finish-load", () => {
    loadAttempts = 0;
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    console.error("[window] did-fail-load", { code, desc, url });
    reveal();
    // -3 is ERR_ABORTED, which a superseded navigation reports normally.
    if (!isMainFrame || code === -3) return;
    if (loadAttempts >= 5) {
      console.error("[window] giving up reloading renderer");
      return;
    }
    loadAttempts += 1;
    clearTimeout(retryTimer);
    retryTimer = setTimeout(loadRenderer, 400 * 2 ** (loadAttempts - 1));
  });

  win.webContents.on("render-process-gone", (_e, details) => {
    console.error("[window] render-process-gone", details);
    if (details.reason === "clean-exit") return;
    loadAttempts = 0;
    loadRenderer();
  });

  win.webContents.on("unresponsive", () => {
    console.error("[window] renderer unresponsive");
  });

  win.on("closed", () => {
    clearTimeout(retryTimer);
    if (mainWindow === win) mainWindow = undefined;
  });

  // Never navigate the app BrowserWindow to remote pages (looks like a freeze).
  win.webContents.on("will-navigate", (event, url) => {
    if (isAllowedInAppNavigation(url)) return;
    event.preventDefault();
    openExternalHttpUrl(url);
  });
  win.webContents.on("will-redirect", (event, url) => {
    if (isAllowedInAppNavigation(url)) return;
    event.preventDefault();
    openExternalHttpUrl(url);
  });

  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternalHttpUrl(url);
    return { action: "deny" };
  });

  loadRenderer();
}

// Keep Application Support dir stable when packaged productName is branded.
// A debug launch (JELLYBOT_DEBUGGEE) must not share that folder or the
// Windows single-instance lock with the debugger host — otherwise the
// debuggee quits immediately and never shows a window.
const isDebuggee = process.env.JELLYBOT_DEBUGGEE === "1";
app.setPath(
  "userData",
  join(app.getPath("appData"), isDebuggee ? "jellybot-debug" : "jellybot"),
);
app.setName("Larry Agent");

// Windows: a second launch focuses the running instance instead of spawning a
// second app (macOS keeps its conventional activate path — untouched).
if (IS_WINDOWS && !isDebuggee && !app.requestSingleInstanceLock()) {
  app.quit();
} else if (IS_WINDOWS && !isDebuggee) {
  app.on("second-instance", () => {
    const [existing] = BrowserWindow.getAllWindows();
    if (!existing || existing.isDestroyed()) return;
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
  });
}

app.whenReady().then(async () => {
  installConsoleCapture(mainLogBuffer, "main", (entry) => {
    broadcastDiagnosticLog(entry);
  });
  installLocalFileProtocolHandler();
  const startCoco = registerIpc();

  registerBuiltins();
  try {
    const tools = await migrateToolsConfigFromSettings();
    loadToolPermissionOverrides(tools.toolPermissionOverrides);
    loadToolOfferOverrides(tools.toolOfferOverrides);
    loadToolOfferAutoBaseline(tools.toolOfferAutoBaseline);
    loadToolDisplayOverrides(tools.toolDisplayOverrides);
    loadShellSafetyConfig(tools.shellSafety);
    await mcpManager.startFromSettings(tools.mcpServers);
    await skillManager.startFromSettings(tools.skills);
    try {
      const recovered = await skillManager.reconcileOrphans();
      if (recovered.length > 0) {
        console.warn(
          `[skills] re-registered ${recovered.length} orphaned skill package(s): ${recovered
            .map((s) => s.name)
            .join(", ")}`,
        );
      }
    } catch (err) {
      console.error("[skills] orphan reconciliation failed", err);
    }
  } catch (err) {
    console.error("[tools-config] failed to migrate/start MCP/skills", err);
  }

  const iconPath = resolveAppIconPath();

  // Packaged macOS builds resolve to undefined and keep the bundle's `icon.icns`.
  if (process.platform === "darwin" && iconPath) {
    try {
      app.dock?.setIcon(iconPath);
    } catch (err) {
      console.error("[app] dock.setIcon failed", err);
    }
  }

  await createWindow(iconPath);

  // Shared by concurrent callers of revealMainWindow — rapid repeat clicks
  // must not each spawn a window (the same race exists on the activate path).
  let recreateMainWindowIfNeeded: Promise<void> | null = null;

  /**
   * Bring the main window back for a popup/footer action: show + focus the
   * existing window (Windows close-to-tray hides rather than destroys), or
   * recreate it when it was closed (macOS red button / crash). A recreated
   * renderer drops IPC sent before it is up, so `deliver` waits for
   * ready-to-show on that path.
   */
  const revealMainWindow = async (
    deliver?: (win: BrowserWindow) => void,
  ): Promise<void> => {
    let win = mainWindow;
    const recreated = !win || win.isDestroyed();
    if (recreated) {
      recreateMainWindowIfNeeded ??= createWindow(iconPath).finally(() => {
        recreateMainWindowIfNeeded = null;
      });
      try {
        await recreateMainWindowIfNeeded;
      } catch (err) {
        // Callers fire-and-forget — never surface as an unhandled rejection.
        console.error("[window] recreate failed", err);
        return;
      }
      win = mainWindow;
    }
    if (!win || win.isDestroyed()) return;
    const target = win;
    if (target.isMinimized()) target.restore();
    if (!target.isVisible()) target.show();
    target.focus();
    if (!deliver) return;
    if (recreated) {
      target.once("ready-to-show", () => deliver(target));
    } else {
      deliver(target);
    }
  };

  // Tray click routing: "open" means visible to the user — hidden-to-tray
  // (Windows) and a hidden app (macOS Cmd+H) count as closed, so the first
  // click reopens the window; a minimized window stays "open" and gets the
  // usage popup instead.
  const isMainWindowOpen = (): boolean => {
    const win = mainWindow;
    return !!win && !win.isDestroyed() && win.isVisible();
  };
  const openMainWindow = (): void => {
    void revealMainWindow();
  };

  // Foreground check for the Windows tray's middle click tier: a window can
  // be visible yet buried under other apps (or minimized to the taskbar —
  // Windows keeps taskbar-only windows "visible" to Electron). isFocused()
  // covers both; show-if-needed is the other tiers' job, not this one.
  const isMainWindowForeground = (): boolean => {
    const win = mainWindow;
    return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  };
  // Foreground restore for that tier. Plain focus() can leave the window
  // above the caller but below whatever sits on top of the z-order, so
  // mirror debugAdapterIpc.ts: a brief always-on-top pulse lifts the
  // window over every stack, then the level is settled back to normal.
  const focusMainWindow = (): void => {
    const win = mainWindow;
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (process.platform === "win32") win.setAlwaysOnTop(true);
    win.show();
    win.focus();
    win.moveTop();
    if (process.platform === "darwin") app.focus({ steal: true });
    if (process.platform === "win32") {
      setTimeout(() => {
        if (!win.isDestroyed()) win.setAlwaysOnTop(false);
      }, 0);
    }
  };

  // Tray usage popup (CursorUsage-style subscription usage on icon click;
  // docs/plans/20261013-usage-popup-tray-icon.md). Shared by the macOS menu
  // bar item and the Windows resident tray; its footer reuses the
  // menubar:action channel for New Task / Settings (opening the window
  // first when it is closed), Quit runs the normal before-quit chain.
  const usagePopup = setupUsagePopup({
    getMainWindow: () => mainWindow,
    onNewTask: () => {
      void revealMainWindow((win) =>
        win.webContents.send(MENUBAR_ACTION_CHANNEL, { action: "new-task" }),
      );
    },
    onSettings: () => {
      void revealMainWindow((win) =>
        win.webContents.send(MENUBAR_ACTION_CHANNEL, { action: "settings" }),
      );
    },
    onQuit: () => app.quit(),
  });

  // Windows resident mode: create the tray first, then arm close-to-tray
  // (setupResidentTray gates itself to win32). OS shutdown must bypass the
  // hide interceptor, or a hidden-not-closed window would block Windows
  // logout.
  const trayDeps: TrayHostDeps = {
    isMainWindowOpen,
    openMainWindow,
    isMainWindowForeground,
    focusMainWindow,
  };
  residentTrayReady = setupResidentTray(trayDeps, iconPath, usagePopup);

  // macOS menu bar brand item — dog head; left click routes by main-window
  // state, right click opens the usage popup (the former New Task / Loops /
  // Settings / Quit menu is removed). The module gates itself to darwin —
  // other platforms are a no-op.
  setupMenuBarBrandItem(trayDeps, usagePopup);

  // Pre-warm the resident usage popup (hidden) so tray right-click reveals
  // instantly on Windows too — the per-click renderer spawn + page load
  // moved to startup, deliberately past the main window's first paint.
  setTimeout(() => usagePopup.prewarm(), 2_000);

  // Self-owned notification hub (bell inbox ledger + corner popups);
  // replaces every system Notification use (task-done / tray-hidden).
  setupAppNotify(() => mainWindow);
  // Daemon-safe wiring: the hub reaches daemon-bundled modules only
  // through these registrations (sessionRuntime / desktopNotify never
  // import appNotify statically — the loops shim lacks ipcMain/screen).
  setNotifyToolPort(appNotify);
  setDesktopNotifySink(appNotify);
  // Tool configuration, permissions and notification ports are ready before dispatch.
  startCoco();

  powerMonitor.on("shutdown", () => {
    isQuitting = true;
  });

  // Dock click. Keyed on the main window itself: the pre-warmed usage popup
  // and notification windows stay alive hidden, so a window count never
  // reaches zero after the main window closes.
  app.on("activate", () => {
    const win = mainWindow;
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) return;
    void revealMainWindow();
  });
});

app.on("before-quit", () => {
  // Real quit path (tray Quit / app.quit): let windows actually close
  // instead of hiding to the tray.
  isQuitting = true;
  stopCppSymbolIndex?.();
  stopClangd?.();
  stopAllDevModeWatches();
});

app.on("window-all-closed", () => {
  // Windows resident mode owns its lifecycle via the tray — never auto-quit.
  if (residentTrayReady) return;
  if (process.platform !== "darwin") {
    app.quit();
  }
});
