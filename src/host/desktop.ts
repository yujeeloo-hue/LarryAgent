/**
 * Desktop host adapter — Electron main-process implementation of the
 * HostAdapter facade (see ./adapter.ts).
 *
 * Only the desktop shell imports this module (src/main/index.ts). The
 * headless agentd bundle must never reach it — its build asserts zero
 * electron imports across the whole graph.
 */
import { app, BrowserWindow } from "electron";
import { notifyTaskDone } from "../main/desktopNotify.js";
import { acquirePowerGuard, releasePowerGuard } from "../main/powerGuard.js";
import type { HostAdapter } from "./adapter.js";

export function createDesktopHost(): HostAdapter {
  return {
    getPreferredSystemLanguages: () => app.getPreferredSystemLanguages?.() ?? [],
    getSystemLocale: () => app.getSystemLocale?.() ?? "",
    getLocale: () => app.getLocale?.() ?? "",
    appVersion: () => app.getVersion(),
    broadcastToUiWindows: (channel, payload) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(channel, payload);
      }
    },
    notifyTaskDone: (input) => notifyTaskDone(input),
    powerGuard: {
      acquire: (owner) => acquirePowerGuard(owner),
      release: (owner) => releasePowerGuard(owner),
    },
  };
}
