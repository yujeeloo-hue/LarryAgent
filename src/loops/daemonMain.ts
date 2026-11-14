/**
 * Loops daemon entry — runs under the app's Electron binary with
 * ELECTRON_RUN_AS_NODE=1, managed by launchd (Label com.jellybot.app.loops).
 *
 * Responsibilities: scan loops.db every 20s, execute due loops serially via
 * the headless session store, heartbeat every 30s, exit cleanly on SIGTERM.
 */
import { mkdirSync } from "node:fs";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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
import {
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

const SCAN_INTERVAL_MS = 20_000;
const HEARTBEAT_INTERVAL_MS = 30_000;
/** How long SIGTERM waits for an in-flight pass (launchd ExitTimeOut=30s). */
const STOP_GRACE_MS = 20_000;

/** Loops daemon's own version — independent of the app version it ships with. */
const LOOPS_DAEMON_VERSION = "0.0.1";

/** App version injected by the plist env (used for the LLM user agent only). */
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

/** Default app data root mirrors the app's userData (set via plist env). */
export function resolveDaemonAppDataRoot(): string {
  const env = process.env.JELLYBOT_APP_DATA;
  if (env && env.trim()) return env.trim();
  return join(homedir(), "Library", "Application Support", "jellybot");
}

/**
 * Role prompts dir. Packaged daemon: plist injects JELLYBOT_RESOURCES_DIR
 * (→ `{resources}/prompts`). Dev: fallback to the repo's resources/prompts.
 */
export function resolveDaemonPromptsDir(): string {
  const env = process.env.JELLYBOT_RESOURCES_DIR;
  if (env && env.trim()) {
    const candidate = join(env.trim(), "prompts");
    if (existsSync(candidate)) return candidate;
  }
  return join(process.cwd(), "resources", "prompts");
}

/**
 * Mirror the app's boot configuration (index.ts registerIpc/whenReady) so a
 * headless turn sees the same tool catalog, permissions, prompts, memory and
 * skills as the app. launchd cwd is "/", so every root must be explicit.
 */
async function bootstrapRuntime(appDataRoot: string): Promise<void> {
  configureLlmUserAgent(buildLlmUserAgent("OctoBot", APP_VERSION));
  configurePromptDefaults(resolveDaemonPromptsDir());
  configureAgentLog(appDataRoot);
  configureUserMemoryRoot(appDataRoot);
  void loadUserMemory();
  configureToolsConfigRoot(appDataRoot);
  configureSkillsRoot(join(appDataRoot, "skills"));
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
  // Host adapter — daemon flavor: env locale, plist-provided version, and
  // the shim-backed notification/power modules so daemon behavior matches
  // the pre-adapter wiring exactly (osascript banner, no sleep blocking).
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
  // App-first execution: when JellyBot is running, due-loop turns are handed
  // off over the unix socket so they stream in the app UI; otherwise the
  // daemon-local headless executor below runs them (unchanged behavior).
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
      // Single-pass failures must never take the daemon down.
      logError("scheduler pass failed", error);
    }
  };

  const scanTimer = setInterval(() => {
    inFlight = scan().finally(() => {
      inFlight = null;
    });
  }, SCAN_INTERVAL_MS);

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log(`received ${signal}, shutting down`);
    clearInterval(scanTimer);
    clearInterval(heartbeatTimer);
    void (async () => {
      // Let an in-flight pass settle within the launchd ExitTimeOut budget.
      if (inFlight) {
        await Promise.race([inFlight, sleep(STOP_GRACE_MS)]);
      }
      try {
        db.close();
      } catch {
        /* already closed */
      }
      // Exit 0: KeepAlive {SuccessfulExit: false} must not restart us.
      process.exit(0);
    })();
  };

  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));

  // First pass immediately on start (boot catch-up).
  inFlight = scan().finally(() => {
    inFlight = null;
  });
}

// Direct execution (not imported by tests): run the daemon loop.
if (process.argv[1] && process.argv[1].endsWith("loops-daemon.mjs")) {
  runDaemonMain().catch((error) => {
    logError("fatal", error);
    process.exit(1);
  });
}
