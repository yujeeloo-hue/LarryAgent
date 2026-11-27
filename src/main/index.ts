import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
} from "electron";
import { basename, dirname, extname, isAbsolute, join } from "node:path";
import { configureKnowledgeBase, knowledgeBase } from "../knowledge/store.js";
import { toKnowledgeDocView, type KnowledgeDocView } from "../knowledge/views.js";
import type { KnowledgeListSnapshot } from "../knowledge/types.js";
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
import { createHandoffLoginStore, createSafeStorageHandoffCipher } from "./handoffLoginStore.js";
import type { HandoffPasswordSubmission } from "../shared/askUser.js";
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
  agentLogInfo,
  agentLogWarn,
  configureAgentLog,
  getAgentLogsDir,
  setFullLlmRequestLog,
  isFullLlmRequestLogEnabled,
} from "../logging/agentLog.js";
import type { LogEntry, ProcessMetrics } from "../logging/types.js";
import {
  dumpMemoryGraphs,
  formatDumpStamp,
  formatMemoryDumpLog,
  withHeapSnapshotExtension,
  type HeapDebugger,
  type RendererHeapTarget,
} from "./memoryDump.js";
import {
  getToolStatsInvocation,
  getToolStatsSummary,
  getToolStatsDaily,
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
import { runInlineCompletion } from "../llm/runInlineCompletion.js";
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
  JEV_PROVIDER_ID,
  configurePromptDefaults,
  getPromptDefaults,
  normalizeObjectStorageConfig,
  readWorkspaceSettings,
  resolveActiveProvider,
  resolveJevProvider,
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
import { installUnrealEditorMcp } from "../unreal/editorInstall.js";
import { isUnrealEditorMcpConnected, onUnrealEditorBindingsChanged } from "../unreal/editorBinding.js";
import type { McpServerUpsertInput } from "../mcp/types.js";
import {
  skillManager,
  configureSkillPersistence,
  configureSkillsRoot,
} from "../skills/index.js";
import type {
  SkillInstallConflict,
  SkillInstallResult,
  SkillUpsertInput,
} from "../skills/types.js";
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
import { registerUnrealWorkspaceIpc } from "./unrealWorkspaceIpc.js";
import { createDevTaskRunnerPort } from "./devTaskRunner.js";
import { configureDevTaskRunner } from "../tools/devTaskRunnerPort.js";
import { createWorkspaceManagerPort } from "./workspaceManagerToolPort.js";
import { configureWorkspaceManager } from "../tools/workspaceManagerPort.js";
import { registerDebugAdapterIpc, getDebugSessionManager } from "./debugAdapterIpc.js";
import { createDebugToolPort, isSessionAwaitingDebugTool } from "./debugToolPort.js";
import {
  armBreakpointCallbackWatcher,
  formatBreakpointHit,
  unbindBreakpointCallbacksForOwner,
} from "./debugBreakpointCallback.js";
import {
  armStartCallbackWatcher,
  formatLifecycleNotice,
  unbindStartCallbacksForOwner,
} from "./debugLifecycleCallback.js";
import { registerDevModeReplyChannel } from "./devModeRequestBridge.js";
import { registerCollaborativeIpc } from "./collaborativeIpc.js";
import { configureDebugControl } from "../tools/debugControlPort.js";
import { configureComputerUseCache } from "../tools/computerUse/cache.js";
import { configureComputerUseJev } from "../tools/computerUse/jevAccess.js";
import { askJev } from "../llm/jevClient.js";
import { configureComputerUseWindows } from "../tools/computerUse/windowAvoidance.js";
import { configureComputerUseSoundPublisher } from "../tools/computerUse/sound.js";
import {
  configureCursorOverlay,
  configureOverlayChannel,
  cursorOverlay,
  disposeCursorOverlay,
  disposeTipsOverlay,
  setCursorOverlayEnabled,
  setCursorOverlayTheme,
  DEFAULT_CURSOR_THEME,
} from "../tools/computerUse/cursorOverlay.js";
import { createComputerUseWindowHost } from "./computerUseWindowHost.js";
import { createElectronOverlayChannel } from "./computerUseOverlay/electronOverlayChannel.js";
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
import { listGraphDrafts, getGraphDraft, saveGraphDraftFromEditor, discardGraphDraft } from "../agent/fsm/authoring/contexts.js";
import { analyzeGraph } from "../agent/fsm/authoring/diagnostics.js";
import { registerSpeechTranscriptionIpc } from "./speechTranscription.js";
import {
  cleanupStorage,
  scanStorageUsage,
  type CleanupResult,
  type StorageUsage,
} from "./storageCleanup.js";
import { createSessionStore, resolveClient } from "./sessionRuntime.js";
import { createSkillCuration, type SkillCuration } from "./skillCuration.js";
import {
  describeSkillProposal,
  listSkillProposals,
  resolveSkillProposal,
} from "../skills/proposals.js";
import { getSkillUsageStats } from "../skills/usage.js";

let skillCuration: SkillCuration | null = null;

function startSkillCuration(): void {
  if (skillCuration) return;
  const root = resolveAppDataRoot();
  skillCuration = createSkillCuration({
    skillsRoot: join(root, "skills"),
    isEnabled: async () => (await readWorkspaceSettings(root))?.autoSkillSummarizeDefault === true,
    resolveClient: () => resolveClient(root, "", undefined, { fallbackIfMissing: true }),
  });
  skillCuration.start();
}
import { configureHostAdapter } from "../host/adapter.js";
import { createDesktopHost } from "../host/desktop.js";
import { createCocoService } from "./cocoService.js";
import { CocoStartup } from "../coco/startup.js";
import { retireLoopsDaemon } from "./loops/daemonControl.js";
import type { CocoCommand, CocoSettings } from "../coco/types.js";
import { setLoopsToolPort } from "./loops/toolAccess.js";
import { createHooksService } from "../hooks/index.js";
import {
  abortMerge,
  backgroundFetch,
  fallbackCommitMessage,
  finishMerge,
  generateCommitMessage,
  getBranchInfo,
  getGitBehindCount,
  getPullPreview,
  pullLatest,
  pushToRemote,
  resolveMergeConflict,
  type BranchInfo,
  type CommitResult,
  type FinishMergeResult,
  type GitAbortMergeResult,
  type GitPullResult,
  type PathDiffStats,
  type PrepareCommitResult,
  type PullPreview,
  type ResolveConflictResult,
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
import { resolveFooterVcsTargets } from "../vcs/footerTargets.js";
import { isSvnUpdateAvailable, resolveSvnConflict, startSvnUpdate } from "../svn/index.js";
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
import { cancelDevModeTextSearch, startDevModeTextSearch } from "./devModeTextSearch.js";
import {
  DEVMODE_TEXT_SEARCH_CANCEL_CHANNEL,
  DEVMODE_TEXT_SEARCH_CHANNEL,
  DEVMODE_TEXT_SEARCH_CHUNK_CHANNEL,
  type DevModeTextSearchOptions,
} from "./devModeTextSearchTypes.js";
import { runDevModeExecutable } from "./devmodeRun.js";
import { CppSymbolIndexService } from "./cppSymbols/service.js";
import { ClangdService } from "./clangd/service.js";
import { registerClangdIpc } from "./clangd/clangdIpc.js";
import { LuaLanguageService } from "./luaLs/service.js";
import { findLuaServer } from "./luaLs/locate.js";
import { registerLuaLsIpc } from "./luaLs/luaLsIpc.js";
import { LANGUAGE_SERVER_PROGRESS_CHANNEL } from "./lsp/progressTypes.js";
import { TypeScriptLanguageService } from "./tsLs/service.js";
import { findTypeScriptServer } from "./tsLs/locate.js";
import { registerTsLsIpc } from "./tsLs/tsLsIpc.js";
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
  CPP_SYMBOL_SEARCH_CHANNEL,
  parseCompletionChain,
} from "./cppSymbols/types.js";
import {
  attachWindowControlsEvents,
  bringWindowToFront,
  focusWebContents,
  registerWindowControlsIpc,
  showWhenReady,
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

applyScrollbarPresentationSwitches();

const mainLogBuffer = new LogBuffer(500);

function ignoreBrokenStdioPipe(): void {
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {
    });
  }
}

ignoreBrokenStdioPipe();

function broadcastDiagnosticLog(entry: LogEntry): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    const wc = win.webContents;
    if (wc.isDestroyed()) continue;
    try {
      wc.send("diagnostics:log", entry);
    } catch {
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


function resolveAppIconPath(): string | undefined {
  if (app.isPackaged && process.platform === "darwin") return undefined;
  const base = app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
  return join(base, process.platform === "win32" ? "icon.ico" : "icon.png");
}

function resolvePromptsDir(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, "prompts");
  }
  return join(app.getAppPath(), "resources", "prompts");
}

function resolveAppDataRoot(): string {
  return app.getPath("userData");
}

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
  apiKeyConfiguredByProviderId[JEV_PROVIDER_ID] =
    await hasApiKeyInStore(JEV_PROVIDER_ID);
  return {
    settings: resolved,
    promptDefaults: getPromptDefaults(),
    apiKeyConfiguredByProviderId,
    appVersion: app.getVersion(),
  };
}

let stopCppSymbolIndex: (() => void) | null = null;
let stopClangd: (() => void) | null = null;

function registerIpc(): () => void {
  registerTerminalIpc();
  registerDevTaskIpc();
  registerUnrealWorkspaceIpc();
  configureDevTaskRunner(createDevTaskRunnerPort());
  registerDebugAdapterIpc();
  registerDevModeReplyChannel((channel, handler) => {
    ipcMain.on(channel, (event, payload) => handler(event.sender.id, payload));
  });
  configureDebugControl(createDebugToolPort());
  configureComputerUseWindows(createComputerUseWindowHost(() => mainWindow ?? null));
  configureComputerUseSoundPublisher((sound) => {
    const win = mainWindow;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("computer-use:sound", sound);
    }
  });
  if (IS_WINDOWS) configureOverlayChannel(createElectronOverlayChannel());
  configureCursorOverlay(null);
  ipcMain.on("appearance:report", (_event, raw: unknown) => {
    const payload = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
    const hex = (value: unknown, fallback: string) =>
      typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value) ? value.toLowerCase() : fallback;
    setCursorOverlayTheme({
      dark: payload.dark !== false,
      accent: hex(payload.accent, DEFAULT_CURSOR_THEME.accent),
      onAccent: hex(payload.onAccent, DEFAULT_CURSOR_THEME.onAccent),
    });
  });
  registerSpeechTranscriptionIpc();
  const clangd = new ClangdService((event) =>
    broadcastToRenderer(CLANGD_PROGRESS_CHANNEL, event),
  );
  const languageServerBundle = {
    packaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    devRoots: [app.getAppPath(), process.cwd()],
  };
  const broadcastLanguageServerProgress = (event: unknown) =>
    broadcastToRenderer(LANGUAGE_SERVER_PROGRESS_CHANNEL, event);
  const luaLs = new LuaLanguageService(
    () => findLuaServer(languageServerBundle),
    undefined,
    broadcastLanguageServerProgress,
  );
  const tsLs = new TypeScriptLanguageService(
    () => findTypeScriptServer(languageServerBundle),
    broadcastLanguageServerProgress,
  );
  stopClangd = () => {
    clangd.stop();
    luaLs.stop();
    tsLs.stop();
  };
  registerClangdIpc(clangd);
  registerLuaLsIpc(luaLs);
  registerTsLsIpc(tsLs);
  configureClangdService(clangd);
  registerWindowControlsIpc();
  registerVcsIpc({
    onTreeChanged: (root) => broadcastToRenderer("vcs:changed", { rootPath: root }),
  });
  const appDataRoot = resolveAppDataRoot();
  configureComputerUseCache(appDataRoot);
  configureComputerUseJev(async () => {
    const provider = resolveJevProvider(await readWorkspaceSettings(appDataRoot));
    if (!provider) return null;
    const apiKey = await readApiKeyFromStore(JEV_PROVIDER_ID);
    return apiKey ? { baseUrl: provider.baseUrl, apiKey, model: provider.modelId } : null;
  });
  void readWorkspaceSettings(appDataRoot)
    .then((stored) => setCursorOverlayEnabled(withSettingsDefaults(stored).virtualCursorEnabled))
    .catch(() => setCursorOverlayEnabled(true));
  configureLlmUserAgent(buildLlmUserAgent("OctoBot", app.getVersion()));
  configurePromptDefaults(resolvePromptsDir());
  configureAgentLog(appDataRoot);
  migrateLegacyCwdData(appDataRoot, process.cwd());
  configureCredentialsRoot(appDataRoot);
  void deleteApiKeyFromStore("summary").catch(() => {});
  configureUserMemoryRoot(appDataRoot);
  void loadUserMemory();
  configureToolsConfigRoot(appDataRoot);
  configureHostAdapter(createDesktopHost());
  const handoffLogins = createHandoffLoginStore(appDataRoot, createSafeStorageHandoffCipher(safeStorage));
  const store = createSessionStore(appDataRoot, { handoffLogins });
  configureWorkspaceManager(createWorkspaceManagerPort(store));
  const resumeSessionWith = (sessionId: string, userText: string): void => {
    const live = store.getSession(sessionId);
    if (!live) return;
    try {
      if (live.status === "running") {
        store.enqueuePrompt({ sessionId, userText, mode: "interrupt" });
      } else {
        // Callback turns never escalate permissions: the session keeps whatever
        // the user granted; debug_inspect / debug_step need no approval anyway.
        void store
          .startTurn({ sessionId, userText, fullPermissions: false })
          .catch(() => {});
      }
    } catch {
    }
  };
  const debugManager = getDebugSessionManager();
  if (debugManager) {
    armBreakpointCallbackWatcher({
      manager: debugManager,
      isSessionAwaitingDebugTool,
      notify: ({ sessionId, hit, disarmed }) => {
        resumeSessionWith(sessionId, formatBreakpointHit(hit, { disarmed }));
      },
    });
    armStartCallbackWatcher({
      manager: debugManager,
      isSessionAwaitingDebugTool,
      notify: ({ sessionId, notice, disarmed }) => {
        resumeSessionWith(sessionId, formatLifecycleNotice(notice, { disarmed }));
      },
    });
  }
  registerCollaborativeIpc(appDataRoot, workspace => resolveLlmClientForWorkspace(workspace), workspace => {
    const normalize = (path: string): string => {
      const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
      return process.platform === "win32" ? normalized.toLowerCase() : normalized;
    };
    return store.listWorkspaces().find(item => normalize(item.path) === normalize(workspace))?.id;
  });

  const REMOTE_RELAY_CREDENTIAL_ID = "remote-relay";
  const broadcastToRenderer = (
    channel: string,
    payload: unknown,
    options?: { exceptWebContentsId?: number },
  ): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (options?.exceptWebContentsId === win.webContents.id) continue;
      win.webContents.send(channel, payload);
    }
  };
  attachNotificationCenterRendererBridge((payload) =>
    broadcastToRenderer("nc:event", payload),
  );
  ipcMain.handle("unreal:editorMcpConnected", (_event, workspaceId: unknown) => {
    if (typeof workspaceId !== "string") return false;
    const workspace = store.listWorkspaces().find((item) => item.id === workspaceId);
    return workspace ? isUnrealEditorMcpConnected(workspace.path) : false;
  });
  onUnrealEditorBindingsChanged(() => {
    const win = mainWindow;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send("unreal:editorMcpChanged");
    }
  });
  const cppSymbols = new CppSymbolIndexService((event) =>
    broadcastToRenderer(CPP_SYMBOL_PROGRESS_CHANNEL, event),
  );
  stopCppSymbolIndex = () => cppSymbols.stop();
  configureSymbolIndexService(cppSymbols);
  setVcsAuthBroadcastSink((payload) =>
    broadcastToRenderer("vcs:authRequest", payload),
  );
  const readRemoteSettings = async (): Promise<RemoteRelaySettings> => {
    const settings = (await readWorkspaceSettings(appDataRoot)) ?? ({} as WorkspaceSettings);
    const remote = settings.remote;
    return {
      enabled: remote?.enabled ?? false,
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
      try { cocoStartup.stop(); coco.stop(); } catch {  }
      app.exit(0);
    },
    onStateChange: (state) => {
      broadcastToRenderer("update:state", state);
      try {
        remoteBridgeRef?.pushMaintenanceState(state as never);
      } catch {
      }
    },
  });
  let cocoRef: RemoteCocoEngine | null = null;
  const remoteBridge = createRemoteBridge({
    store,
    getSettings: () => remoteSettingsCache,
    getApiKey: () => readApiKeyFromStore(REMOTE_RELAY_CREDENTIAL_ID),
    appVersion: () => app.getVersion(),
    platform: () => `${process.platform} ${os.arch()}`,
    listHiddenToolCards: () => listHiddenToolCards(),
    deviceMaintenance: desktopMaintenance,
    deviceCaps: ["maintenance", "coco"],
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
  void desktopMaintenance.reconcile().finally(() => {
    void startRemoteBridgeBoot();
  });
  async function startRemoteBridgeBoot(): Promise<void> {
    remoteSettingsCache = await readRemoteSettings();
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

  app.on("before-quit", () => {
    store.persistRunningSessionsOnQuit();
  });
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
  installUnrealEditorMcp();
  configureSkillsRoot(join(appDataRoot, "skills"));
  configureKnowledgeBase({
    builtinDir: join(dirname(resolvePromptsDir()), "knowledge"),
    userDir: join(appDataRoot, "knowledge"),
  });
  configureSkillPersistence(persistSkills);
  configureFsmGraphsRoot(join(appDataRoot, "fsm-graphs"));

  ipcMain.handle("settings:getWorkspace", async () => {
    const settings = await readWorkspaceSettings(appDataRoot);
    return withSettingsDefaults(settings);
  });

  ipcMain.handle("settings:getSnapshot", async () => {
    return buildSettingsSnapshot(appDataRoot);
  });

  const canManageComputerLogins = (event: Electron.IpcMainInvokeEvent): boolean =>
    event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame;
  ipcMain.handle("settings:listComputerLogins", async (event) => {
    if (!canManageComputerLogins(event) || !(await handoffLogins.available())) return { available: false, entries: [] };
    return { available: true, entries: await handoffLogins.list() };
  });
  ipcMain.handle("settings:saveComputerLogin", async (event, origin: unknown, account: unknown, password: unknown, previous: unknown) => {
    if (!canManageComputerLogins(event) || typeof origin !== "string" || origin.length > 2048 ||
        typeof account !== "string" || account.length > 512 || typeof password !== "string") return false;
    if (previous === undefined) return handoffLogins.remember(origin, account.trim(), password, false);
    if (!previous || typeof previous !== "object") return false;
    const old = previous as Record<string, unknown>;
    if (typeof old.origin !== "string" || old.origin.length > 2048 || typeof old.account !== "string" || old.account.length > 512) return false;
    const nextAccount = account === old.account ? account : account.trim();
    if (old.origin === origin && old.account === nextAccount) {
      return (await handoffLogins.accounts(origin)).includes(nextAccount) && await handoffLogins.remember(origin, nextAccount, password);
    }
    if (!(await handoffLogins.remember(origin, nextAccount, password, false))) return false;
    if (await handoffLogins.remove(old.origin, old.account)) return true;
    await handoffLogins.remove(origin, nextAccount);
    return false;
  });
  ipcMain.handle("settings:removeComputerLogin", async (event, origin: unknown, account: unknown) => {
    return canManageComputerLogins(event) && typeof origin === "string" && origin.length <= 2048 &&
      typeof account === "string" && account.length <= 512 && await handoffLogins.remove(origin, account);
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
      setCursorOverlayEnabled(resolved.virtualCursorEnabled);
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
      store.retryArchiveQueue();
      if ("providers" in rawRec || "activeProviderId" in rawRec) {
        remoteBridge.notifyProvidersChanged({
          exceptWebContentsId: _event.sender.id,
        });
      }
      return resolved;
    },
  );


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
      remoteBridge.notifyProvidersChanged();

      const warnings: string[] = [];
      try {
        const settings = await readWorkspaceSettings(appDataRoot);
        if (settings) {
          const resolved = withSettingsDefaults(settings);
          setToolStatsEnabled(resolved.toolStatsEnabled);
          setCursorOverlayEnabled(resolved.virtualCursorEnabled);
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
        providerId === JEV_PROVIDER_ID ||
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
    "settings:testJev",
    async (): Promise<{ ok: boolean; message: string }> => {
      const provider = resolveJevProvider(await readWorkspaceSettings(appDataRoot));
      if (!provider) return { ok: false, message: "Add a decision model first." };
      const apiKey = await readApiKeyFromStore(JEV_PROVIDER_ID).catch(() => null);
      if (!apiKey) return { ok: false, message: "API key is not set — paste it in the card first." };
      try {
        const result = await askJev(
          { baseUrl: provider.baseUrl, apiKey, model: provider.modelId },
          {
            state: "A dialog shows one button labeled Save.",
            questions: { save: { type: "noul", instructions: "Does the dialog show a Save button?" } },
          },
          { purpose: "settings_test" },
        );
        if (!result.answers.save) return { ok: false, message: "The model answered, but not with a typed decision." };
        return { ok: true, message: `Connected — ${result.model} answered in ${result.elapsedMs} ms` };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
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
        try {
          await response.body?.cancel();
        } catch {
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

  ipcMain.handle(
    "llm:getProviderUsage",
    (_event, req: { force?: boolean }) =>
      getProviderUsage(appDataRoot, { force: req?.force === true }),
  );

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

  async function resolveInlineClient(providerId: string) {
    const settings = withSettingsDefaults(await readWorkspaceSettings(appDataRoot));
    const provider =
      (providerId
        ? settings.providers.find((item) => item.id === providerId)
        : undefined) ?? resolveActiveProvider(settings);
    const apiKey =
      (await readApiKeyFromStore(provider.id)) ??
      (isLocalLlmBaseUrl(provider.baseUrl) ? "local" : "");
    if (!apiKey) {
      throw new Error(`Missing API key for provider "${provider.name}"`);
    }
    return {
      baseUrl: provider.baseUrl,
      apiKey,
      model: provider.modelId,
      ...(provider.apiProtocol ? { apiProtocol: provider.apiProtocol } : {}),
      ...(provider.rawEndpoint === true ? { rawEndpoint: true } : {}),
    };
  }
  const inlineCompleteAborts = new Map<string, AbortController>();
  ipcMain.on("llm:inlineCompleteCancel", (_event, requestId: unknown) => {
    if (typeof requestId !== "string" || !requestId) return;
    inlineCompleteAborts.get(requestId)?.abort();
  });
  ipcMain.handle(
    "llm:inlineComplete",
    async (
      _event,
      req: {
        requestId?: string;
        sessionId?: string;
        providerId?: string;
        workspacePath?: string;
        languageId?: string;
        fileName?: string;
        prefix?: string;
        suffix?: string;
      },
    ): Promise<{ text: string }> => {
      const requestId =
        typeof req?.requestId === "string" && req.requestId.trim()
          ? req.requestId.trim()
          : randomUUID();
      const abort = new AbortController();
      inlineCompleteAborts.set(requestId, abort);
      try {
        if (typeof req?.prefix !== "string" || typeof req?.suffix !== "string") {
          return { text: "" };
        }
        const sessionId =
          typeof req.sessionId === "string" ? req.sessionId.trim() : "";
        const settings = withSettingsDefaults(
          await readWorkspaceSettings(appDataRoot),
        );
        const providerId = settings.inlineCompletionProviderId ?? "";
        const workspacePath =
          typeof req.workspacePath === "string" ? req.workspacePath.trim() : "";
        const client =
          workspacePath && isAbsolute(workspacePath)
            ? providerId
              ? await resolveLlmClientForWorkspace(workspacePath, providerId)
              : await resolveLlmClientForWorkspace(workspacePath)
            : await resolveInlineClient(providerId);
        if (abort.signal.aborted) return { text: "" };
        const text = await runInlineCompletion({
          client,
          prefix: req.prefix,
          suffix: req.suffix,
          languageId: typeof req.languageId === "string" ? req.languageId : "",
          fileName: typeof req.fileName === "string" ? req.fileName : "",
          signal: abort.signal,
          ...(sessionId ? { sessionId } : {}),
        });
        return { text: text ?? "" };
      } catch (err) {
        agentLogWarn("inlineCompletion.error", {
          message: err instanceof Error ? err.message : String(err),
        });
        return { text: "" };
      } finally {
        if (inlineCompleteAborts.get(requestId) === abort) {
          inlineCompleteAborts.delete(requestId);
        }
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
        } catch {  }
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

  ipcMain.handle("fsm:listGraphs", async () => {
    const graphs = await listFsmGraphs();
    for (const graph of graphs) if (!graph.enabled) store.detachFsmGraphFromSessions(graph.id);
    return [...graphs, ...await listGraphDrafts()];
  });

  ipcMain.handle("fsm:listComposerGraphs", async () => {
    for (const graph of await listFsmGraphs()) if (!graph.enabled) store.detachFsmGraphFromSessions(graph.id);
    return listComposerGraphs();
  });

  ipcMain.handle("fsm:getGraph", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) return null;
    return id.startsWith("draft:") ? getGraphDraft(id) : getFsmGraph(id.trim());
  });

  ipcMain.handle("fsm:saveGraph", async (_event, raw: unknown) => {
    try {
      const input = raw as import("../agent/fsm/graphLibrary/types.js").FsmGraphLibraryRecord;
      if (input.id?.startsWith("draft:")) return await saveGraphDraftFromEditor(input);
      const saved = await saveFsmGraph(input);
      if (!saved.enabled) store.detachFsmGraphFromSessions(saved.id);
      return saved;
    } catch (err) {
      throw new Error(
        err instanceof Error ? err.message : "Failed to save FSM graph",
      );
    }
  });

  ipcMain.handle("fsm:deleteGraph", async (_event, id: unknown) => {
    if (typeof id !== "string" || !id.trim()) return;
    const graphId = id.trim();
    if (graphId.startsWith("draft:")) return discardGraphDraft(graphId);
    store.detachFsmGraphFromSessions(graphId);
    await deleteFsmGraph(graphId);
  });

  ipcMain.handle(
    "fsm:setGraphEnabled",
    async (_event, id: unknown, enabled: unknown) => {
      if (typeof id !== "string" || !id.trim()) return null;
      const graphId = id.trim();
      if (enabled !== true) {
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

  ipcMain.handle("fsm:analyzeGraph", (_event, config: unknown) => analyzeGraph(config));
  ipcMain.handle("fsm:commitDraft", async (_event, record: import("../agent/fsm/graphLibrary/types.js").FsmGraphLibraryRecord) => saveGraphDraftFromEditor(record, true));

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
      event,
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
      return store.startTurn(req, {
        desktopInitiated: event.sender === mainWindow?.webContents && event.senderFrame === event.sender.mainFrame,
      });
    },
  );

  ipcMain.handle("agent:cancelTurn", async (_event, sessionId: string) => {
    return store.cancelTurn(sessionId);
  });

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

  ipcMain.handle("agent:respondHandoffPassword", async (event, requestId: unknown, raw: unknown) => {
    if (
      event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame ||
      typeof requestId !== "string" || !raw || typeof raw !== "object"
    ) return "expired";
    const value = raw as Record<string, unknown>;
    let submission: HandoffPasswordSubmission;
    if (value.kind === "saved" && typeof value.account === "string") {
      submission = { kind: "saved", account: value.account };
    } else if (value.kind === "manual" && typeof value.password === "string" &&
               (value.rememberAccount === undefined || typeof value.rememberAccount === "string")) {
      submission = {
        kind: "manual", password: value.password,
        ...(typeof value.rememberAccount === "string" ? { rememberAccount: value.rememberAccount } : {}),
      };
    } else return "unavailable";
    const status = await store.respondHandoffPassword(requestId, submission);
    if (status === "filled_not_saved") {
      appNotify({ title: "Password filled", body: "The password could not be saved on this device.", inbox: false });
    }
    return status;
  });

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
      return store.createWorkspace({ name: req.name, path: req.path });
    },
  );

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

  for (const channel of ["list", "listRuns", "create", "update", "delete", "setEnabled", "daemonStatus", "installDaemon", "ensureDaemon", "repairDaemon", "stopDaemon", "uninstallDaemon"]) {
    ipcMain.handle(`loops:${channel}`, () => { throw new Error("Loops has been upgraded to Coco. Open Coco to manage your work and rules."); });
  }

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

  ipcMain.handle("skills:usageStats", async () => getSkillUsageStats());

  ipcMain.handle("skills:listRevisions", async (_event, skillId: unknown) => {
    if (typeof skillId !== "string" || !skillId.trim()) throw new Error("skillId is required");
    return skillManager.listRevisions(skillId.trim());
  });

  ipcMain.handle(
    "skills:readRevision",
    async (_event, req: { id?: unknown; revision?: unknown }) => {
      if (typeof req?.id !== "string" || typeof req.revision !== "number") {
        throw new Error("id and revision are required");
      }
      return skillManager.readRevision(req.id, req.revision);
    },
  );

  ipcMain.handle(
    "skills:restoreRevision",
    async (_event, req: { id?: unknown; revision?: unknown }) => {
      if (typeof req?.id !== "string" || typeof req.revision !== "number") {
        throw new Error("id and revision are required");
      }
      return skillManager.restoreRevision(req.id, req.revision);
    },
  );

  ipcMain.handle(
    "skills:setDeprecated",
    async (_event, req: { id?: unknown; deprecated?: unknown }) => {
      if (typeof req?.id !== "string" || typeof req.deprecated !== "boolean") {
        throw new Error("id and deprecated are required");
      }
      return req.deprecated
        ? skillManager.deprecateSkill(req.id, {})
        : skillManager.reactivateSkill(req.id);
    },
  );

  ipcMain.handle("skills:listProposals", async () => {
    const pending = await listSkillProposals({ status: "pending" });
    return pending.map((p) => describeSkillProposal(p, skillManager));
  });

  ipcMain.handle(
    "skills:resolveProposal",
    async (_event, req: { id?: unknown; decision?: unknown }) => {
      if (typeof req?.id !== "string" || (req.decision !== "accept" && req.decision !== "reject")) {
        throw new Error("id and decision (accept | reject) are required");
      }
      const result = await resolveSkillProposal(req.id, req.decision, skillManager);
      return { status: result.proposal.status, applied: result.applied.length };
    },
  );

  ipcMain.handle("skills:curationStatus", async () => {
    return skillCuration ? skillCuration.status() : { running: false };
  });

  ipcMain.handle("skills:curateNow", async () => {
    if (!skillCuration) throw new Error("Skill curation is not available.");
    const result = await skillCuration.runNow();
    return skillCuration.status().then((status) => ({ ...status, ran: result !== null }));
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
      if (typeof input.project === "string") {
        upsert.project = input.project.trim();
      }
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

  const pendingSkillZipOverwrites = new Map<string, string>();
  ipcMain.handle(
    "skills:installZip",
    async (
      event,
      raw?: { overwriteToken?: unknown },
    ): Promise<SkillInstallResult | SkillInstallConflict | null> => {
      const token =
        typeof raw?.overwriteToken === "string" ? raw.overwriteToken : "";
      if (token) {
        const pendingPath = pendingSkillZipOverwrites.get(token);
        pendingSkillZipOverwrites.delete(token);
        if (!pendingPath) throw new Error("The skill package is no longer pending. Choose it again.");
        return skillManager.installFromZip(pendingPath, { overwrite: true, enabled: true });
      }
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
      try {
        return await skillManager.installFromZip(zipPath, {
          overwrite: false,
          enabled: true,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to install skill.";
        if (!/already installed|already exists/i.test(message)) throw err;
        pendingSkillZipOverwrites.clear();
        const conflictToken = randomUUID();
        pendingSkillZipOverwrites.set(conflictToken, zipPath);
        return {
          conflict: true,
          token: conflictToken,
          message: message.replace(/\s*Pass overwrite=true to replace\.?$/, ""),
        };
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

  ipcMain.handle("knowledge:list", async (): Promise<KnowledgeListSnapshot> => knowledgeBase.snapshot());

  ipcMain.handle("knowledge:read", async (_event, raw: unknown): Promise<KnowledgeDocView | null> => {
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== "string") throw new Error("id must be a string");
    const doc = knowledgeBase.getDoc(id);
    return doc ? toKnowledgeDocView(doc) : null;
  });

  ipcMain.handle("knowledge:revert", async (_event, raw: unknown): Promise<KnowledgeListSnapshot> => {
    const id = raw && typeof raw === "object" ? (raw as { id?: unknown }).id : undefined;
    if (typeof id !== "string") throw new Error("id must be a string");
    const result = knowledgeBase.revertToBuiltin(id);
    if (!result.ok) throw new Error(result.message);
    return knowledgeBase.snapshot();
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
    async (
      event,
      workspacePath: unknown,
      relativePath?: unknown,
    ): Promise<{ ok: true }> => {
      const cwd = assertWorkspacePath(workspacePath);
      const owner = BrowserWindow.fromWebContents(event.sender);
      openWorkspaceChangesWindow({
        workspacePath: cwd,
        relativePath:
          typeof relativePath === "string" && relativePath.trim()
            ? relativePath.trim()
            : undefined,
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
        aheadCount: 0,
        behindCount: 0,
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
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return result;
    },
  );

  ipcMain.handle(
    "git:pull",
    async (_event, workspacePath: unknown): Promise<GitPullResult> => {
      const cwd = assertWorkspacePath(workspacePath);
      const result = await pullLatest(cwd);
      if (result.ok || "conflicts" in result) {
        invalidateVcsStatusCache(cwd);
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return result;
    },
  );

  ipcMain.handle(
    "git:abortMerge",
    async (
      _event,
      workspacePath: unknown,
    ): Promise<GitAbortMergeResult> => {
      const cwd = assertWorkspacePath(workspacePath);
      const result = await abortMerge(cwd);
      if (result.ok) {
        invalidateVcsStatusCache(cwd);
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return result;
    },
  );

  ipcMain.handle(
    "git:branchInfo",
    async (_event, workspacePath: unknown): Promise<BranchInfo> => {
      const cwd = assertWorkspacePath(workspacePath);
      return getBranchInfo(cwd);
    },
  );

  ipcMain.handle(
    "git:pullPreview",
    async (_event, workspacePath: unknown): Promise<PullPreview> => {
      const cwd = assertWorkspacePath(workspacePath);
      return getPullPreview(cwd);
    },
  );

  ipcMain.handle(
    "git:resolveConflict",
    async (
      _event,
      req: unknown,
    ): Promise<ResolveConflictResult> => {
      if (!req || typeof req !== "object" || Array.isArray(req)) {
        throw new Error("Invalid conflict request");
      }
      const body = req as {
        workspacePath?: unknown;
        path?: unknown;
        choice?: unknown;
      };
      const cwd = assertWorkspacePath(body.workspacePath);
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw new Error("path must be a non-empty string");
      }
      const choice = body.choice;
      if (choice !== "mine" && choice !== "theirs" && choice !== "both") {
        throw new Error("choice must be mine, theirs or both");
      }
      const result = await resolveMergeConflict(cwd, body.path, choice);
      invalidateVcsStatusCache(cwd);
      broadcastToRenderer("vcs:changed", { rootPath: cwd });
      return result;
    },
  );

  ipcMain.handle(
    "git:finishMerge",
    async (_event, workspacePath: unknown): Promise<FinishMergeResult> => {
      const cwd = assertWorkspacePath(workspacePath);
      const result = await finishMerge(cwd);
      if (result.ok) {
        invalidateVcsStatusCache(cwd);
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return result;
    },
  );

  ipcMain.handle(
    "git:backgroundFetch",
    async (_event, workspacePath: unknown): Promise<{ ok: boolean }> => {
      const cwd = assertWorkspacePath(workspacePath);
      const ok = await backgroundFetch(cwd);
      if (ok) {
        invalidateVcsStatusCache(cwd);
        broadcastToRenderer("vcs:changed", { rootPath: cwd });
      }
      return { ok };
    },
  );

  ipcMain.handle(
    "vcs:footerTargets",
    async (
      _event,
      workspacePath: unknown,
    ): Promise<{ svn: boolean; gitRoot: string | null }> => {
      const cwd = assertWorkspacePath(workspacePath);
      return resolveFooterVcsTargets(cwd);
    },
  );

  ipcMain.handle(
    "git:behindCount",
    async (
      _event,
      workspacePath: unknown,
    ): Promise<{ behindCount: number }> => {
      const cwd = assertWorkspacePath(workspacePath);
      return { behindCount: await getGitBehindCount(cwd) };
    },
  );

  ipcMain.handle(
    "svn:updateAvailable",
    async (
      _event,
      workspacePath: unknown,
    ): Promise<{ available: boolean }> => {
      const cwd = assertWorkspacePath(workspacePath);
      return { available: await isSvnUpdateAvailable(cwd) };
    },
  );

  /**
   * Streaming `svn update`: progress is pushed on SVN_UPDATE_EVENT so the panel
   * can list every path as it lands, and Stop can kill the child mid-run.
   */
  const SVN_UPDATE_EVENT = "vcs:svnUpdate:event";
  const activeSvnUpdates = new Map<string, { cancel: () => void }>();

  const normalizeSvnUpdatePaths = (raw: unknown): string[] => {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0 && !entry.startsWith("-"));
  };

  ipcMain.handle(
    "vcs:svnUpdate:start",
    async (
      _event,
      req: unknown,
    ): Promise<{ ok: boolean; message?: string }> => {
      const body = req as {
        rootPath?: unknown;
        runId?: unknown;
        paths?: unknown;
      };
      const cwd = assertWorkspacePath(body.rootPath);
      const runId = typeof body.runId === "string" ? body.runId.trim() : "";
      if (!runId) throw new Error("runId must be a non-empty string");
      if (activeSvnUpdates.has(runId)) {
        return { ok: false, message: "This update is already running." };
      }

      const run = startSvnUpdate({
        root: cwd,
        paths: normalizeSvnUpdatePaths(body.paths),
        onEvent: (event) => {
          broadcastToRenderer(SVN_UPDATE_EVENT, { runId, event });
          if (event.type === "done" || event.type === "error" || event.type === "stopped") {
            invalidateVcsStatusCache(cwd);
            broadcastToRenderer("vcs:changed", { rootPath: cwd });
          }
        },
      });
      activeSvnUpdates.set(runId, { cancel: run.cancel });
      void run.finished.then(() => {
        activeSvnUpdates.delete(runId);
      });
      return { ok: true };
    },
  );

  ipcMain.handle(
    "vcs:svnUpdate:cancel",
    async (_event, runId: unknown): Promise<{ ok: boolean }> => {
      if (typeof runId !== "string" || !runId.trim()) return { ok: false };
      const active = activeSvnUpdates.get(runId.trim());
      if (!active) return { ok: false };
      active.cancel();
      return { ok: true };
    },
  );

  ipcMain.handle(
    "vcs:svnUpdate:resolveConflict",
    async (
      _event,
      req: unknown,
    ): Promise<{ ok: true; remaining: string[] } | { ok: false; message: string }> => {
      const body = req as {
        rootPath?: unknown;
        path?: unknown;
        choice?: unknown;
      };
      const cwd = assertWorkspacePath(body.rootPath);
      if (typeof body.path !== "string" || !body.path.trim()) {
        throw new Error("path must be a non-empty string");
      }
      const choice = body.choice;
      if (
        choice !== "mine" &&
        choice !== "theirs" &&
        choice !== "both" &&
        choice !== "working"
      ) {
        throw new Error("choice must be mine, theirs, both or working");
      }
      const result = await resolveSvnConflict(cwd, body.path, choice);
      invalidateVcsStatusCache(cwd);
      broadcastToRenderer("vcs:changed", { rootPath: cwd });
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

  ipcMain.handle("devmode:listDir", (_event, targetPath: unknown) =>
    listDevModeDir(targetPath),
  );

  ipcMain.handle("devmode:runExecutable", (_event, targetPath: unknown) =>
    runDevModeExecutable(targetPath),
  );

  ipcMain.handle("devmode:readProjectFile", (_event, targetPath: unknown) =>
    readProjectFile(targetPath),
  );

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

  ipcMain.handle(
    DEVMODE_TEXT_SEARCH_CHANNEL,
    (
      event,
      rootPath: unknown,
      requestId: unknown,
      query: unknown,
      options?: DevModeTextSearchOptions | null,
    ) => {
      const sender = event.sender;
      return startDevModeTextSearch({
        ownerId: sender.id,
        rootPath,
        requestId,
        query,
        options: options ?? null,
        post: (chunk) => {
          if (!sender.isDestroyed()) sender.send(DEVMODE_TEXT_SEARCH_CHUNK_CHANNEL, chunk);
        },
      });
    },
  );

  ipcMain.handle(DEVMODE_TEXT_SEARCH_CANCEL_CHANNEL, (event) => {
    cancelDevModeTextSearch(event.sender.id);
  });

  ipcMain.handle("devmode:watch", (_event, rootPath: unknown) => {
    const result = startDevModeWatch(rootPath, (payload) => {
      broadcastToRenderer("devmode:fsEvent", payload);
      cppSymbols.onFsEvents(payload);
    });
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
      luaLs.stopIfRoot(rootPath);
      tsLs.stopIfRoot(rootPath);
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
    CPP_SYMBOL_SEARCH_CHANNEL,
    (_event, rootPath: unknown, query: unknown, limit: unknown) => {
      if (typeof rootPath !== "string" || typeof query !== "string") return [];
      const max = typeof limit === "number" && Number.isFinite(limit) ? Math.min(Math.max(1, limit), 2000) : 500;
      return cppSymbols.search(rootPath, query, max);
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

  ipcMain.on("diagnostics:editorContextMenu", (_event, raw: unknown) => {
    if (!raw || typeof raw !== "object") return;
    const fields: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(raw).slice(0, 24)) {
      if (
        value === null ||
        typeof value === "number" ||
        typeof value === "boolean"
      ) {
        fields[key] = value;
      } else if (typeof value === "string") {
        fields[key] = value.slice(0, 120);
      }
    }
    const log =
      fields.menuExpected === true &&
      (fields.menuShown === false || fields.menuHiddenAfterMs !== null)
        ? agentLogWarn
        : agentLogInfo;
    log("devmode.editor_contextmenu", fields);
  });

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

  ipcMain.handle("toolStats:getDaily", async (_event, raw?: unknown) => {
    const name =
      raw &&
      typeof raw === "object" &&
      typeof (raw as { name?: unknown }).name === "string" &&
      (raw as { name: string }).name.trim()
        ? (raw as { name: string }).name.trim()
        : undefined;
    const sessionId = sessionIdFromRaw(raw);
    return getToolStatsDaily({
      ...(name ? { name } : {}),
      ...(sessionId ? { sessionId } : {}),
    });
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

  let memoryDumpInFlight = false;
  ipcMain.handle("diagnostics:dumpMemory", async (event) => {
    if (memoryDumpInFlight) {
      return {
        ok: false,
        files: [],
        errors: ["A memory snapshot is already being saved."],
      };
    }
    memoryDumpInFlight = true;
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options = {
        title: "Save Heap Snapshot",
        defaultPath: `heap-${formatDumpStamp(new Date())}.heapsnapshot`,
        filters: [
          { name: "Heap snapshot", extensions: ["heapsnapshot"] },
          { name: "All Files", extensions: ["*"] },
        ],
      };
      const picked =
        owner && !owner.isDestroyed()
          ? await dialog.showSaveDialog(owner, options)
          : await dialog.showSaveDialog(options);
      if (picked.canceled || !picked.filePath) {
        return { ok: false, canceled: true, files: [], errors: [] };
      }
      const renderers: RendererHeapTarget[] = [];
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        const contents = win.webContents;
        if (contents.isDestroyed()) continue;
        renderers.push({
          id: contents.id,
          title: win.getTitle(),
          debugger: contents.debugger as unknown as HeapDebugger,
        });
      }
      const result = await dumpMemoryGraphs({
        filePath: withHeapSnapshotExtension(picked.filePath),
        renderers,
      });
      const line = formatMemoryDumpLog(result);
      if (result.ok) console.info(line);
      else console.error(line);
      if (result.ok) {
        for (const error of result.errors) console.warn(`[memory] ${error}`);
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[memory] Heap snapshot failed. ${message}`);
      return { ok: false, files: [], errors: [message] };
    } finally {
      memoryDumpInFlight = false;
    }
  });

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

function remoteUploadDir(): string {
  return join(app.getPath("temp"), "jellybot-remote-uploads");
}

function isSafeExternalHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function openExternalHttpUrl(url: string): void {
  if (!isSafeExternalHttpUrl(url)) return;
  setImmediate(() => {
    void shell.openExternal(url).catch((err) => {
      console.error("[shell] openExternal failed", err);
    });
  });
}

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

let mainWindow: BrowserWindow | undefined;
let residentTrayReady = false;
let isQuitting = false;

async function createWindow(iconPath: string | undefined): Promise<void> {
  const isMac = process.platform === "darwin";
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
    titleBarStyle: "hidden",
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
  const webContentsId = win.webContents.id;
  attachWindowControlsEvents(win);
  mainWindow = win;

  // Windows: after an external process dialog (Unreal/UBT error boxes, etc.) closes, the window can land in
  // a state where the OS considers it active but webContents still reports unfocused — clicks dispatch normally
  // (buttons react), but text fields cannot receive focus or accept typing until a real activation cycle
  // (Alt+Tab / opening DevTools) restores it. Hand focus back to the page on every window focus event.
  const reassertPageFocus = (): void => {
    focusWebContents(win);
  };
  win.on("focus", reassertPageFocus);
  win.on("show", reassertPageFocus);
  win.on("restore", reassertPageFocus);
  win.webContents.on("did-finish-load", reassertPageFocus);

  win.on("close", (event) => {
    if (!residentTrayReady || isQuitting) return;
    event.preventDefault();
    win.hide();
    notifyHiddenToTrayOnce();
  });

  const reveal = showWhenReady(win);

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

  let loadAttempts = 0;
  let retryTimer: NodeJS.Timeout | undefined;

  win.webContents.on("did-finish-load", () => {
    loadAttempts = 0;
  });

  win.webContents.on("did-fail-load", (_e, code, desc, url, isMainFrame) => {
    console.error("[window] did-fail-load", { code, desc, url });
    reveal();
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
    unbindBreakpointCallbacksForOwner(webContentsId);
    unbindStartCallbacksForOwner(webContentsId);
    if (mainWindow === win) mainWindow = undefined;
  });

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

const isDebuggee = process.env.JELLYBOT_DEBUGGEE === "1";
app.setPath(
  "userData",
  join(app.getPath("appData"), isDebuggee ? "jellybot-debug" : "jellybot"),
);
app.setName("Larry Agent");

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
    try {
      const pruned = await skillManager.pruneDeletedHistory();
      if (pruned.length > 0) {
        console.log(`[skills] pruned history of ${pruned.length} deleted skill(s)`);
      }
    } catch (err) {
      console.warn("[skills] history pruning failed", err);
    }
    startSkillCuration();
  } catch (err) {
    console.error("[tools-config] failed to migrate/start MCP/skills", err);
  }

  const iconPath = resolveAppIconPath();

  if (process.platform === "darwin" && iconPath) {
    try {
      app.dock?.setIcon(iconPath);
    } catch (err) {
      console.error("[app] dock.setIcon failed", err);
    }
  }

  await createWindow(iconPath);

  let recreateMainWindowIfNeeded: Promise<void> | null = null;

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

  const isMainWindowOpen = (): boolean => {
    const win = mainWindow;
    return !!win && !win.isDestroyed() && win.isVisible();
  };
  const openMainWindow = (): void => {
    void revealMainWindow();
  };

  const isMainWindowForeground = (): boolean => {
    const win = mainWindow;
    return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
  };
  const focusMainWindow = (): void => {
    if (mainWindow) bringWindowToFront(mainWindow);
  };

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

  const trayDeps: TrayHostDeps = {
    isMainWindowOpen,
    openMainWindow,
    isMainWindowForeground,
    focusMainWindow,
  };
  residentTrayReady = setupResidentTray(trayDeps, iconPath, usagePopup);

  setupMenuBarBrandItem(trayDeps, usagePopup);

  setTimeout(() => usagePopup.prewarm(), 2_000);

  setupAppNotify(() => mainWindow);
  setNotifyToolPort(appNotify);
  setDesktopNotifySink(appNotify);
  startCoco();

  powerMonitor.on("shutdown", () => {
    isQuitting = true;
  });

  app.on("activate", () => {
    const win = mainWindow;
    if (win && !win.isDestroyed() && win.isVisible() && !win.isMinimized()) return;
    void revealMainWindow();
  });
});

app.on("before-quit", () => {
  isQuitting = true;
  configureComputerUseSoundPublisher(null);
  disposeCursorOverlay();
  disposeTipsOverlay();
  stopCppSymbolIndex?.();
  stopClangd?.();
  stopAllDevModeWatches();
});

app.on("window-all-closed", () => {
  if (residentTrayReady) return;
  if (process.platform !== "darwin") {
    app.quit();
  }
});
