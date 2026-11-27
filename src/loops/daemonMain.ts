import { mkdirSync, existsSync, watch, type FSWatcher } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { configureKnowledgeBase } from "../knowledge/store.js";
import { createSessionStore } from "../main/sessionRuntime.js";
import { configureHostAdapter, createHeadlessHost } from "../host/adapter.js";
import { notifyTaskDone } from "../main/desktopNotify.js";
import {
  acquirePowerGuard,
  releasePowerGuard,
} from "../main/powerGuard.js";
import { buildLlmUserAgent, configureLlmUserAgent } from "../llm/userAgent.js";
import { configurePromptDefaults } from "../settings/promptDefaults.js";
import { configureAgentLog } from "../logging/agentLog.js";
import { configureComputerUseCache } from "../tools/computerUse/cache.js";
import {
  configureUserMemoryRoot,
  loadUserMemory,
} from "../memory/store.js";
import {
  configureToolsConfigRoot,
  migrateToolsConfigFromSettings,
} from "../toolsConfig/store.js";
import {
  loadToolPermissionOverrides,
  loadToolOfferOverrides,
  loadToolOfferAutoBaseline,
  loadToolDisplayOverrides,
  registerBuiltins,
} from "../tools/index.js";
import { loadShellSafetyConfig } from "../tools/policy/shellSafetyConfig.js";
import { configureSkillsRoot, skillManager } from "../skills/index.js";
import { mcpManager } from "../mcp/index.js";
import { installUnrealEditorMcp } from "../unreal/editorInstall.js";
import {
  LOOPS_DB_FILENAME,
  nextEnabledRunAt,
  openLoopsDb,
  updateDaemonHeartbeat,
} from "./db.js";
import {
  reclaimStaleRuns,
  runSchedulerPass,
  type LoopExecutor,
} from "./daemonCore.js";
import { createSessionExecutor } from "./sessionExecutor.js";
import {
  createHandoffExecutor,
  createSocketHandoffClient,
  loopsHandoffSocketPath,
} from "./appHandoff.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const MAX_TIMER_MS = 2_147_483_647;
const STOP_GRACE_MS = 20_000;

const LOOPS_DAEMON_VERSION = "0.0.1";

const APP_VERSION = process.env.JELLYBOT_APP_VERSION?.trim() || "dev";

function log(message: string): void {
  process.stdout.write(`[loops-daemon] ${new Date().toISOString()} ${message}\n`);
}

function logError(message: string, error: unknown): void {
  const detail = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`[loops-daemon] ${new Date().toISOString()} ${message}: ${detail}\n`);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export function resolveDaemonAppDataRoot(): string {
  const env = process.env.JELLYBOT_APP_DATA;
  if (env && env.trim()) return env.trim();
  return join(homedir(), "Library", "Application Support", "jellybot");
}

export function resolveDaemonPromptsDir(): string {
  const env = process.env.JELLYBOT_RESOURCES_DIR;
  if (env && env.trim()) {
    const candidate = join(env.trim(), "prompts");
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "resources", "prompts");
}

async function bootstrapRuntime(appDataRoot: string): Promise<void> {
  configureLlmUserAgent(buildLlmUserAgent("OctoBot", APP_VERSION));
  configurePromptDefaults(resolveDaemonPromptsDir());
  configureAgentLog(appDataRoot);
  configureComputerUseCache(appDataRoot);
  configureUserMemoryRoot(appDataRoot);
  void loadUserMemory();
  configureToolsConfigRoot(appDataRoot);
  configureSkillsRoot(join(appDataRoot, "skills"));
  configureKnowledgeBase({
    builtinDir: join(dirname(resolveDaemonPromptsDir()), "knowledge"),
    userDir: join(appDataRoot, "knowledge"),
  });
  registerBuiltins();

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
  installUnrealEditorMcp();
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
}

type SessionStore = ReturnType<typeof createSessionStore>;

export async function runDaemonMain(
  appDataRoot = resolveDaemonAppDataRoot(),
): Promise<void> {
  mkdirSync(appDataRoot, { recursive: true });
  await bootstrapRuntime(appDataRoot);
  const db = openLoopsDb(appDataRoot);
  configureHostAdapter(
    createHeadlessHost({
      version: APP_VERSION,
      notifyTaskDone: (input) => notifyTaskDone(input),
      powerGuard: {
        acquire: (owner) => acquirePowerGuard(owner),
        release: (owner) => releasePowerGuard(owner),
      },
    }),
  );
  const store = createSessionStore(appDataRoot);
  const executor: LoopExecutor = createHandoffExecutor(
    createSessionExecutor(store),
    createSocketHandoffClient(loopsHandoffSocketPath(appDataRoot)),
    { log },
  );

  const reclaimed = reclaimStaleRuns(db);
  if (reclaimed > 0) {
    log(`reclaimed ${reclaimed} stale run(s) left running by a previous daemon`);
  }
  updateDaemonHeartbeat(db, process.pid, LOOPS_DAEMON_VERSION);
  log(`started pid=${process.pid} version=${LOOPS_DAEMON_VERSION} appData=${appDataRoot}`);

  let stopping = false;
  let inFlight: Promise<void> | null = null;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let stuckDueAt: number | null = null;
  let dbWatcher: FSWatcher | null = null;

  const heartbeatTimer = setInterval(() => {
    try {
      updateDaemonHeartbeat(db, process.pid, LOOPS_DAEMON_VERSION);
    } catch (error) {
      logError("heartbeat failed", error);
    }
  }, HEARTBEAT_INTERVAL_MS);

  const scan = async (): Promise<void> => {
    if (stopping) return;
    try {
      const result = await runSchedulerPass(db, executor);
      const total = result.ran + result.skipped + result.failed;
      if (total > 0) {
        log(
          `pass: ${total} due loop(s) — ok=${result.ran} skipped=${result.skipped} failed=${result.failed}`,
        );
      }
    } catch (error) {
      logError("scheduler pass failed", error);
    }
  };

  const scheduleScan = (): void => {
    if (stopping) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      return;
    }
    const next = nextEnabledRunAt(db);
    if (next == null) {
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      stuckDueAt = null;
      return;
    }
    const delay = Math.min(MAX_TIMER_MS, Math.max(0, next - Date.now()));
    if (delay === 0 && stuckDueAt === next) return;
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(() => {
      scanTimer = null;
      if (stopping || inFlight) return;
      inFlight = scan().finally(() => {
        inFlight = null;
        const after = nextEnabledRunAt(db);
        stuckDueAt = delay === 0 && after === next ? next : null;
        scheduleScan();
      });
    }, delay);
    scanTimer.unref?.();
  };

  dbWatcher = watch(appDataRoot, { persistent: true }, (_event, filename) => {
    if (stopping) return;
    if (filename && !String(filename).startsWith(LOOPS_DB_FILENAME)) return;
    scheduleScan();
  });

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = null;
    dbWatcher?.close();
    dbWatcher = null;
    clearInterval(heartbeatTimer);
    void (async () => {
      if (inFlight) {
        await Promise.race([inFlight, sleep(STOP_GRACE_MS)]);
      }
      try {
        db.close();
      } catch {
      }
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  inFlight = scan().finally(() => {
    inFlight = null;
    scheduleScan();
  });
}

if (process.argv[1] && process.argv[1].endsWith("loops-daemon.mjs")) {
  runDaemonMain().catch((error) => {
    logError("fatal", error);
    process.exit(1);
  });
}
