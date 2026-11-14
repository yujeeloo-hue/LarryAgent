/**
 * Host adapter — the session runtime's narrow view of its host shell.
 *
 * The runtime (src/main/sessionRuntime.ts) must stay loadable outside the
 * Electron main process (the Loops daemon today, the headless
 * `jellybot-agentd` node next), so every host-shell capability it needs
 * funnels through this facade instead of importing `electron` directly:
 *
 * - locale snapshot (environment context)  → Electron app.getLocale*() / env
 * - app version (memory sync, archive rows) → app.getVersion() / build version
 * - UI fan-out (agent:stream, approvals)   → BrowserWindow fan-out / inert
 * - task-done notification                 → desktop toast / inert
 * - keep-awake guard while work runs       → powerSaveBlocker / inert
 *
 * Implementations: src/host/desktop.ts (Electron main wrapper),
 * createHeadlessHost below (jellybot-agentd, Loops daemon). Configure once
 * at process boot (configureSymbolIndexService pattern). The default is an
 * inert env-based host so unit tests and partial boots never touch Electron.
 */

export interface HostTaskDoneNotification {
  title: string;
  body: string;
  /** Session the notification jumps to when clicked (toast/popup/bell). */
  sessionId?: string;
  celebrate?: boolean;
}

export interface HostAdapter {
  /** Electron app.getPreferredSystemLanguages() equivalent. */
  getPreferredSystemLanguages(): string[];
  /** Electron app.getSystemLocale() equivalent. */
  getSystemLocale(): string;
  /** Electron app.getLocale() equivalent. */
  getLocale(): string;
  /** Desktop: app.getVersion(); headless: the bundled build version. */
  appVersion(): string;
  /**
   * Fan an IPC payload out to renderer windows. Headless hosts are inert —
   * agent streams reach consumers through the explicit agentStreamSinks
   * registry (remote relay bridge) instead.
   */
  broadcastToUiWindows(channel: string, payload: unknown): void;
  /** Task-done desktop notification. Headless: inert unless injected. */
  notifyTaskDone(input: HostTaskDoneNotification): void;
  /**
   * Ref-counted keep-awake guard held while agent work runs: per turn, plus
   * the whole supervised CoCo run (execution / conversation brackets).
   * Desktop: powerSaveBlocker (see src/main/powerGuard.ts). Headless: inert
   * unless injected (the Loops daemon injects the same module, which its
   * Electron shim degrades to a no-op).
   */
  powerGuard: {
    acquire(owner: string): void;
    release(owner: string): void;
  };
}

/** Locale from POSIX env ("en_US.UTF-8" → "en-US") with Intl fallback. */
function envLocale(): string {
  const raw =
    process.env.LC_ALL || process.env.LC_MESSAGES || process.env.LANG || "";
  const first = raw.split(":")[0]?.split(".")[0]?.trim();
  if (first) return first.replace(/_/g, "-");
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || "en-US";
  } catch {
    return "en-US";
  }
}

export interface HeadlessHostOptions {
  /** Build/install version string reported as the app version. */
  version: string;
  /** Optional task-done sink (daemon: osascript banner; agentd: none). */
  notifyTaskDone?: (input: HostTaskDoneNotification) => void;
  /** Optional keep-awake guard (daemon: shim-backed powerGuard module). */
  powerGuard?: {
    acquire(owner: string): void;
    release(owner: string): void;
  };
}

/**
 * Adapter for non-Electron hosts (jellybot-agentd, the Loops daemon):
 * locale from the environment, explicit version, inert UI fan-out.
 */
export function createHeadlessHost(options: HeadlessHostOptions): HostAdapter {
  return {
    getPreferredSystemLanguages: () => {
      const locale = envLocale();
      return locale ? [locale] : [];
    },
    getSystemLocale: () => envLocale(),
    getLocale: () => envLocale(),
    appVersion: () => options.version,
    broadcastToUiWindows: () => {},
    notifyTaskDone: (input) => {
      options.notifyTaskDone?.(input);
    },
    powerGuard: options.powerGuard ?? {
      acquire: () => {},
      release: () => {},
    },
  };
}

let active: HostAdapter = createHeadlessHost({ version: "dev" });

export function configureHostAdapter(host: HostAdapter): void {
  active = host;
}

export function hostAdapter(): HostAdapter {
  return active;
}
