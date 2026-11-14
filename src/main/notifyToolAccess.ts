/**
 * Module-level holder for the notify tool port.
 *
 * The notification hub (main/appNotify.ts) imports ipcMain + screen from
 * electron — both absent from the Loops daemon shim, while sessionRuntime
 * (which injects the port) is part of the daemon bundle. A holder breaks
 * that edge: sessionRuntime reads the port lazily, main/index registers
 * the real hub at boot, the daemon simply carries no port (the notify tool
 * reports "not available in this host" there). Same pattern as
 * main/loops/toolAccess.ts.
 */
import type { NotifyToolPort } from "../tools/notifyTool.js";

let port: NotifyToolPort | null = null;

/** Register the live hub (main boot); null = notify unavailable. */
export function setNotifyToolPort(next: NotifyToolPort | null): void {
  port = next;
}

export function getNotifyToolPort(): NotifyToolPort | null {
  return port;
}

