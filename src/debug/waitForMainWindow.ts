/**
 * Wait until Unreal's real editor frame exists — not the splash
 * ("0% initializing"). Attaching during splash stops the process.
 */
import { spawn } from "node:child_process";

export type WindowWaitResult = "ready" | "timeout" | "exited" | "cancelled";

export type WindowProbeResult = "ready" | "alive" | "exited";

export type WaitForProcessMainWindowInput = {
  pid: number;
  /** Omit or pass null to wait until ready / exited / cancelled. */
  timeoutMs?: number | null;
  pollMs?: number;
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  probe?: (pid: number) => WindowProbeResult;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function waitForProcessMainWindow(
  input: WaitForProcessMainWindowInput,
): Promise<WindowWaitResult> {
  const timeoutMs = input.timeoutMs;
  const pollMs = input.pollMs ?? 400;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const probe = input.probe;
  if (!probe) {
    return waitForUnrealEditorWindow(input.pid, input.signal, timeoutMs);
  }
  const started = now();

  return (async () => {
    if (input.signal?.aborted) return "cancelled";
    for (;;) {
      if (input.signal?.aborted) return "cancelled";
      const state = probe(input.pid);
      if (state === "ready") return "ready";
      if (state === "exited") return "exited";
      if (timeoutMs != null && now() - started >= timeoutMs) return "timeout";
      await sleep(pollMs);
    }
  })();
}

/** Splash is not enough — wait for the Slate editor class `UnrealWindow`. */
export function waitForUnrealEditorWindow(
  pid: number,
  signal?: AbortSignal,
  timeoutMs?: number | null,
): Promise<WindowWaitResult> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve("exited");
  }
  if (process.platform !== "win32") {
    return Promise.resolve("ready");
  }
  if (signal?.aborted) return Promise.resolve("cancelled");

  const script = unrealWindowWaitScript();
  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", script],
    {
      windowsHide: true,
      env: {
        ...process.env,
        WAIT_PID: String(pid),
        WAIT_TIMEOUT_MS: timeoutMs == null ? "0" : String(Math.max(0, timeoutMs)),
      },
    },
  );

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: WindowWaitResult): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (!child.killed) child.kill();
      resolve(result);
    };
    const onAbort = (): void => finish("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", () => finish("timeout"));
    child.once("exit", (code) => {
      if (code === 0) finish("ready");
      else if (code === 2) finish("exited");
      else finish("timeout");
    });
  });
}

/**
 * Restore and foreground the visible main window owned by `pid`.
 *
 * Windows restricts SetForegroundWindow across GUI threads. The helper
 * temporarily joins the foreground and target input queues, activates the
 * target, then immediately detaches them. It never changes always-on-top.
 */
export function focusProcessMainWindow(pid: number): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(false);
  if (process.platform !== "win32") return Promise.resolve(true);

  const child = spawn(
    "powershell.exe",
    ["-NoProfile", "-STA", "-Command", processWindowFocusScript()],
    {
      windowsHide: true,
      env: { ...process.env, FOCUS_PID: String(pid) },
    },
  );
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

function processWindowFocusScript(): string {
  return `
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class TargetWindowFocus {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr h, int command);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr SetFocus(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT rect);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);

  public static bool Focus(int pid) {
    IntPtr target = IntPtr.Zero;
    long largestArea = -1;
    EnumWindows((h, l) => {
      uint owner;
      GetWindowThreadProcessId(h, out owner);
      if (owner != (uint)pid || !IsWindowVisible(h)) return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      if (title.Length == 0) return true;
      RECT rect;
      if (!GetWindowRect(h, out rect)) return true;
      long area = Math.Max(0, rect.Right - rect.Left) * (long)Math.Max(0, rect.Bottom - rect.Top);
      if (area > largestArea) {
        largestArea = area;
        target = h;
      }
      return true;
    }, IntPtr.Zero);
    if (target == IntPtr.Zero) return false;

    if (IsIconic(target)) ShowWindowAsync(target, 9); // SW_RESTORE
    uint targetPid;
    uint targetThread = GetWindowThreadProcessId(target, out targetPid);
    IntPtr foreground = GetForegroundWindow();
    uint foregroundPid;
    uint foregroundThread = foreground == IntPtr.Zero
      ? 0
      : GetWindowThreadProcessId(foreground, out foregroundPid);
    uint currentThread = GetCurrentThreadId();
    if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, true);
    if (targetThread != 0) AttachThreadInput(currentThread, targetThread, true);
    try {
      BringWindowToTop(target);
      SetForegroundWindow(target);
      SetFocus(target);
    } finally {
      if (targetThread != 0) AttachThreadInput(currentThread, targetThread, false);
      if (foregroundThread != 0) AttachThreadInput(currentThread, foregroundThread, false);
    }
    return GetForegroundWindow() == target;
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop
if ([TargetWindowFocus]::Focus([int]$env:FOCUS_PID)) { exit 0 }
exit 1
`.trim();
}

function unrealWindowWaitScript(): string {
  // $pid is PowerShell's own PID — use WAIT_PID. Exit 0 ready, 2 process gone, 1 timeout.
  return `
$code = @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class UnrealWinProbe {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  public static bool HasUnrealEditorWindow(int pid) {
    bool found = false;
    EnumWindows((h, l) => {
      uint wpid;
      GetWindowThreadProcessId(h, out wpid);
      if (wpid != (uint)pid || !IsWindowVisible(h)) return true;
      var cls = new StringBuilder(256);
      GetClassName(h, cls, cls.Capacity);
      if (cls.ToString() != "UnrealWindow") return true;
      var title = new StringBuilder(512);
      GetWindowText(h, title, title.Capacity);
      var t = title.ToString();
      // Splash / 0% initializing often already has UnrealWindow with a
      // blank or progress title — attaching then freezes D3D startup.
      if (t.Length == 0) return true;
      if (t.IndexOf("Initializing", StringComparison.OrdinalIgnoreCase) >= 0) return true;
      if (t.IndexOf('%') >= 0) return true;
      if (t.IndexOf("Unreal Editor", StringComparison.OrdinalIgnoreCase) < 0) return true;
      found = true;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
Add-Type -TypeDefinition $code -ErrorAction Stop
$targetPid = [int]$env:WAIT_PID
$timeoutMs = [int]$env:WAIT_TIMEOUT_MS
$deadline = if ($timeoutMs -gt 0) { [DateTime]::UtcNow.AddMilliseconds($timeoutMs) } else { [DateTime]::MaxValue }
while ([DateTime]::UtcNow -lt $deadline) {
  if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) { exit 2 }
  if ([UnrealWinProbe]::HasUnrealEditorWindow($targetPid)) { exit 0 }
  Start-Sleep -Milliseconds 500
}
exit 1
`.trim();
}
