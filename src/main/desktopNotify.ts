import { BrowserWindow, Notification } from "electron";

/**
 * Dual-environment task-done notification (daemon-safe).
 *
 * This module is reachable from BOTH the Electron main process and the
 * Loops daemon bundle (build-loops-daemon.mjs aliases `electron` to a shim
 * that only exports app / BrowserWindow / Notification / …). It therefore
 * must never statically import the notification hub (src/main/appNotify.ts
 * — needs ipcMain + screen, absent from the shim). Delivery instead routes
 * through a registered sink:
 *
 * - main process: main/index.ts registers the appNotify hub at boot
 *   (self-owned toast / corner popup / bell inbox, plan 2026-10-08);
 * - daemon: no sink registered → the shim's Notification runs the
 *   osascript banner path (exactly the pre-hub daemon behaviour).
 */

/** Renderer channel that triggers the celebration confetti overlay. */
export const CELEBRATION_CHANNEL = "agent:celebrate";

/** F12 manual test: delay before the toast so the confetti plays out first. */
export const F12_NOTIFY_TEST_DELAY_MS = 5_000;

/** Delivery sink registered by the main process (appNotify hub). */
let sink:
  | ((input: {
      title: string;
      body: string;
      sessionId?: string;
      inbox?: boolean;
    }) => void)
  | undefined;

/** Main-process boot: route task-done notifications to the hub. */
export function setDesktopNotifySink(
  next:
    | ((input: {
        title: string;
        body: string;
        sessionId?: string;
        inbox?: boolean;
      }) => void)
    | null,
): void {
  sink = next ?? undefined;
}

/** True when any JellyBot window holds keyboard focus (app frontmost). */
export function isAppForeground(): boolean {
  return BrowserWindow.getAllWindows().some((win) => win.isFocused());
}

let f12NotifyTestTimer: ReturnType<typeof setTimeout> | undefined;

function sendCelebration(source: "task" | "f12"): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(CELEBRATION_CHANNEL, { source });
  }
}

/**
 * Task-done notification. Never throws: effects must not affect the
 * finished turn.
 * - main process (sink registered): self-owned hub — foreground toast /
 *   background corner popup, filed unread in the bell inbox (`inbox: true`
 *   — task completion is the one notification the message center keeps),
 *   click jumps to the session; foreground + `celebrate` rains in-app
 *   confetti on top.
 * - daemon (no sink): shim Notification (osascript banner on macOS).
 */
export function notifyTaskDone(input: {
  title: string;
  body: string;
  /** Session the notification jumps to when clicked (toast/popup/bell). */
  sessionId?: string;
  celebrate?: boolean;
}): void {
  try {
    if (input.celebrate === true && isAppForeground()) sendCelebration("task");
    if (sink) {
      sink({
        title: input.title,
        body: input.body,
        ...(input.sessionId ? { sessionId: input.sessionId } : {}),
        // Task completion is the message-center case: keep it unread in the
        // bell inbox until the user clicks it.
        inbox: true,
      });
      return;
    }
    if (!Notification.isSupported()) return;
    new Notification({ title: input.title, body: input.body }).show();
  } catch {
    // Swallow: desktop effects are best-effort.
  }
}

