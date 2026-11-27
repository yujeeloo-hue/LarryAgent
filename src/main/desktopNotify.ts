import { BrowserWindow, Notification } from "electron";


export const CELEBRATION_CHANNEL = "agent:celebrate";

export const F12_NOTIFY_TEST_DELAY_MS = 5_000;

let sink:
  | ((input: {
      title: string;
      body: string;
      sessionId?: string;
      inbox?: boolean;
    }) => void)
  | undefined;

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

export function notifyTaskDone(input: {
  title: string;
  body: string;
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
        inbox: true,
      });
      return;
    }
    if (!Notification.isSupported()) return;
    new Notification({ title: input.title, body: input.body }).show();
  } catch {
  }
}

