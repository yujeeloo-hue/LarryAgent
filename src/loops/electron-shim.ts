
import { execFile, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

function envLocale(): string {
  return (
    process.env.LANG?.split(".")[0] ??
    Intl.DateTimeFormat().resolvedOptions().locale ??
    "en-US"
  );
}

export const app = {
  getAppPath(): string {
    return process.cwd();
  },
  getPath(_name: string): string {
    throw new Error("app.getPath unavailable in Loops daemon");
  },
  getLocale(): string {
    return envLocale();
  },
  getSystemLocale(): string {
    return envLocale();
  },
  getPreferredSystemLanguages(): string[] {
    const locale = envLocale();
    return locale ? [locale] : [];
  },
};

class ShimBrowserWindow {
  static getAllWindows(): ShimBrowserWindow[] {
    return [];
  }
  isFocused(): boolean {
    return false;
  }
}

export const BrowserWindow = ShimBrowserWindow;

const OSASCRIPT_PATH = "/usr/bin/osascript";
const OSASCRIPT_TIMEOUT_MS = 10_000;

export function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

export function buildDisplayNotificationScript(
  title: string,
  body: string,
): string {
  const escapedBody = escapeAppleScriptString(body);
  return title
    ? `display notification "${escapedBody}" with title "${escapeAppleScriptString(title)}"`
    : `display notification "${escapedBody}"`;
}

export class Notification {
  private readonly title: string;
  private readonly body: string;

  constructor(options: { title?: string; body?: string } = {}) {
    this.title = typeof options.title === "string" ? options.title : "";
    this.body = typeof options.body === "string" ? options.body : "";
  }

  on(_event: string, _handler: () => void): this {
    return this;
  }

  show(): void {
    if (process.platform !== "darwin") return;
    const script = buildDisplayNotificationScript(this.title, this.body);
    let proc: ChildProcess;
    try {
      proc = execFile(OSASCRIPT_PATH, ["-e", script], {
        timeout: OSASCRIPT_TIMEOUT_MS,
      });
    } catch (err) {
      console.warn(
        "[loops-shim] osascript notification spawn failed:",
        err instanceof Error ? err.message : err,
      );
      return;
    }
    proc.on("error", (err) => {
      console.warn("[loops-shim] osascript notification failed:", err.message);
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        console.warn(`[loops-shim] osascript exited with code ${code}`);
      }
    });
  }

  close(): void {
  }

  static isSupported(): boolean {
    return process.platform === "darwin" && existsSync(OSASCRIPT_PATH);
  }
}

export { Notification as NotificationConstructor };

export const powerSaveBlocker = {
  start(_type: string): number {
    return -1;
  },
  isStarted(_id: number): boolean {
    return false;
  },
  stop(_id: number): void {
  },
};

type ShimImage = {
  isEmpty(): boolean;
  getSize(): { width: number; height: number };
  resize(): ShimImage;
  toJPEG(_quality: number): Buffer;
};

const emptyImage: ShimImage = {
  isEmpty(): boolean {
    return true;
  },
  getSize(): { width: number; height: number } {
    return { width: 0, height: 0 };
  },
  resize(): ShimImage {
    return emptyImage;
  },
  toJPEG(_quality: number): Buffer {
    return Buffer.alloc(0);
  },
};

export const nativeImage = {
  createFromPath(_path: string): ShimImage {
    return emptyImage;
  },
};
