
export interface HostTaskDoneNotification {
  title: string;
  body: string;
  sessionId?: string;
  celebrate?: boolean;
}

export interface HostAdapter {
  getPreferredSystemLanguages(): string[];
  getSystemLocale(): string;
  getLocale(): string;
  appVersion(): string;
  broadcastToUiWindows(channel: string, payload: unknown): void;
  notifyTaskDone(input: HostTaskDoneNotification): void;
  powerGuard: {
    acquire(owner: string): void;
    release(owner: string): void;
  };
}

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
  version: string;
  notifyTaskDone?: (input: HostTaskDoneNotification) => void;
  powerGuard?: {
    acquire(owner: string): void;
    release(owner: string): void;
  };
}

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
