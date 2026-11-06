/**
 * Electron API shim for the Loops daemon bundle.
 *
 * The daemon runs the app's Electron binary with ELECTRON_RUN_AS_NODE=1, so
 * the real "electron" module is unavailable (it resolves to the binary path
 * string). The daemon bundle aliases `electron` to this module at build time
 * (build-loops-daemon.mjs). Only the API surface reachable from the bundled
 * graph is provided; everything degrades to inert no-ops:
 *
 * - sessionRuntime: BrowserWindow.getAllWindows (broadcast → no windows),
 *   app.getPreferredSystemLanguages/getSystemLocale/getLocale (env context).
 * - desktopNotify: Notification backed by /usr/bin/osascript (`display
 *   notification`) — the only toast channel from a bare Node process. The
 *   toast is attributed to osascript by Notification Center (a RUN_AS_NODE
 *   process has no bundle to own it), and click/close are inert: osascript
 *   toasts carry no activation callback back into this process.
 * - powerGuard: powerSaveBlocker.start → -1 (never blocks sleep).
 * - printHtmlToPdf: BrowserWindow constructor throws (unused headless).
 * - prepareVisionImage: nativeImage.createFromPath → empty image (falls back
 *   to raw file bytes).
 */

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

/** macOS `display notification` runner used by the daemon shim. */
const OSASCRIPT_PATH = "/usr/bin/osascript";
/** Hard stop for a wedged osascript; a toast normally lands in <1s. */
const OSASCRIPT_TIMEOUT_MS = 10_000;

/** Escape a value for use inside an AppleScript string literal. */
export function escapeAppleScriptString(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\r", "\\r")
    .replaceAll("\n", "\\n");
}

/** The `osascript -e` script for one toast (title optional). */
export function buildDisplayNotificationScript(
  title: string,
  body: string,
): string {
  const escapedBody = escapeAppleScriptString(body);
  return title
    ? `display notification "${escapedBody}" with title "${escapeAppleScriptString(title)}"`
    : `display notification "${escapedBody}"`;
}

/**
 * RUN_AS_NODE stand-in for Electron's Notification. Matches the surface the
 * bundled code uses (isSupported / new({title, body}) / on / show / close);
 * show() fires one osascript and never throws — daemon toasts are
 * best-effort, failures are logged to stderr (daemon err log).
 */
export class Notification {
  private readonly title: string;
  private readonly body: string;

  constructor(options: { title?: string; body?: string } = {}) {
    this.title = typeof options.title === "string" ? options.title : "";
    this.body = typeof options.body === "string" ? options.body : "";
  }

  /** Accepted for Electron API parity; osascript toasts have no callbacks. */
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
    /* osascript toasts cannot be dismissed programmatically. */
  }

  static isSupported(): boolean {
    return process.platform === "darwin" && existsSync(OSASCRIPT_PATH);
  }
}

/** Inert constructor — desktopNotify guards on isSupported(), this is a
 *  safety net if any other code path constructs one headlessly. */
export { Notification as NotificationConstructor };

export const powerSaveBlocker = {
  start(_type: string): number {
    return -1;
  },
  isStarted(_id: number): boolean {
    return false;
  },
  stop(_id: number): void {
    /* no-op */
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
