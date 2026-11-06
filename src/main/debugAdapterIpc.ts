import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { join } from "node:path";
import { probeDebugAdapter, type DebugAdapterProbe } from "../debug/adapterProbe.js";
import { ensureBundledLldbDap } from "../debug/bundledAdapter.js";
import {
  DebugSessionManager,
  type DebugCommand,
  type DebugStartRequest,
} from "../debug/debugSessionManager.js";
import type { LineBreakpoint } from "../debug/dapSession.js";
import {
  patchWorkspaceSettings,
  readWorkspaceSettings,
  withSettingsDefaults,
} from "../settings/index.js";

function parseLineBreakpoints(raw: unknown): LineBreakpoint[] | null {
  if (!Array.isArray(raw)) return null;
  const out: LineBreakpoint[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const line = (item as { line?: unknown }).line;
    const condition = (item as { condition?: unknown }).condition;
    if (!Number.isInteger(line) || (line as number) <= 0) return null;
    if (condition !== undefined && typeof condition !== "string") return null;
    const trimmed =
      typeof condition === "string" ? condition.trim() : "";
    out.push(
      trimmed
        ? { line: line as number, condition: trimmed }
        : { line: line as number },
    );
  }
  return out;
}

function resourcesRoot(): string {
  return app.isPackaged
    ? process.resourcesPath
    : join(app.getAppPath(), "resources");
}

async function configuredAdapterProbe(): Promise<DebugAdapterProbe> {
  const settings = withSettingsDefaults(
    await readWorkspaceSettings(app.getPath("userData")),
  );
  const bundledPath =
    process.platform === "win32"
      ? ensureBundledLldbDap(resourcesRoot())
      : null;
  return probeDebugAdapter({
    configuredPath: settings.debugAdapterPath,
    bundledPath,
  });
}

async function resolveDebugAdapter(
  owner: WebContents,
): Promise<DebugAdapterProbe | null> {
  const existing = await configuredAdapterProbe();
  if (existing.ok) return existing;

  const parent = BrowserWindow.fromWebContents(owner);
  while (true) {
    const options = {
      title: "Select Larry lldb-dap",
      buttonLabel: "Select lldb-dap",
      properties: ["openFile" as const],
      filters:
        process.platform === "win32"
          ? [{ name: "lldb-dap executable", extensions: ["exe"] }]
          : [{ name: "lldb-dap executable", extensions: ["*"] }],
    };
    const selected = parent
      ? await dialog.showOpenDialog(parent, options)
      : await dialog.showOpenDialog(options);
    if (selected.canceled || !selected.filePaths[0]) return null;

    const selectedPath = selected.filePaths[0];
    const probe = probeDebugAdapter({
      configuredPath: selectedPath,
    });
    if (probe.ok) {
      await patchWorkspaceSettings(app.getPath("userData"), {
        debugAdapterPath: selectedPath,
      });
      return probe;
    }

    const message = parent
      ? await dialog.showMessageBox(parent, {
          type: "error",
          title: "Incompatible lldb-dap",
          message: probe.message,
          detail:
            "Choose the custom Larry lldb-dap that supports pdbModuleAllowlist.",
          buttons: ["Choose Again", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        })
      : await dialog.showMessageBox({
          type: "error",
          title: "Incompatible lldb-dap",
          message: probe.message,
          detail:
            "Choose the custom Larry lldb-dap that supports pdbModuleAllowlist.",
          buttons: ["Choose Again", "Cancel"],
          defaultId: 0,
          cancelId: 1,
        });
    if (message.response === 1) return null;
  }
}

export function registerDebugAdapterIpc(): void {
  const manager = new DebugSessionManager(resolveDebugAdapter, (owner) => {
    const win = BrowserWindow.fromWebContents(owner);
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    if (process.platform === "win32") win.setAlwaysOnTop(true);
    win.show();
    win.focus();
    win.moveTop();
    if (process.platform === "darwin") app.focus({ steal: true });
    if (process.platform === "win32") {
      setTimeout(() => {
        if (!win.isDestroyed()) win.setAlwaysOnTop(false);
      }, 0);
    }
  });
  app.on("before-quit", () => {
    void manager.dispose();
  });
  ipcMain.handle("debug:start", (event, request: DebugStartRequest) =>
    manager.start(event.sender, request),
  );
  ipcMain.handle(
    "debug:setBreakpoints",
    (event, path: unknown, breakpoints: unknown) => {
      const parsed = parseLineBreakpoints(breakpoints);
      if (typeof path !== "string" || !parsed) {
        return {
          ok: false,
          message: "path and breakpoint objects ({ line, condition? }) are required",
        };
      }
      return manager.replaceBreakpoints(event.sender, path, parsed);
    },
  );
  ipcMain.handle("debug:command", (event, command: unknown) => {
    const valid: DebugCommand[] = [
      "pause",
      "continue",
      "next",
      "stepIn",
      "stepOut",
      "stop",
    ];
    if (typeof command !== "string" || !valid.includes(command as DebugCommand)) {
      return { ok: false, message: "Invalid debug command" };
    }
    return manager.command(event.sender, command as DebugCommand);
  });
  ipcMain.handle("debug:selectThread", (event, threadId: unknown) => {
    if (!Number.isInteger(threadId)) {
      return { ok: false, message: "A thread id is required" };
    }
    return manager.selectThread(event.sender, threadId as number);
  });
  ipcMain.handle("debug:selectTarget", (event, targetId: unknown) => {
    if (typeof targetId !== "string" || !targetId.trim()) {
      return { ok: false, message: "A session id is required" };
    }
    return manager.selectTarget(event.sender, targetId.trim());
  });
  ipcMain.handle("debug:selectFrame", (event, frameId: unknown) => {
    if (!Number.isInteger(frameId)) {
      return { ok: false, message: "A stack frame id is required" };
    }
    return manager.selectFrame(event.sender, frameId as number);
  });
  ipcMain.handle(
    "debug:evaluate",
    (event, expression: unknown, frameId: unknown) => {
      if (
        typeof expression !== "string" ||
        !expression.trim() ||
        expression.length > 1_000 ||
        !Number.isInteger(frameId)
      ) {
        return {
          ok: false,
          message: "A non-empty expression and stack frame are required",
        };
      }
      return manager.evaluate(event.sender, expression.trim(), frameId as number);
    },
  );
  ipcMain.handle("debug:variables", (event, variablesReference: unknown) => {
    if (
      !Number.isInteger(variablesReference) ||
      (variablesReference as number) <= 0
    ) {
      return { ok: false, message: "A positive variables reference is required" };
    }
    return manager.variables(event.sender, variablesReference as number);
  });
  ipcMain.handle("debug:state", (event) => manager.state(event.sender));
}
