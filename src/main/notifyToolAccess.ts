import type { NotifyToolPort } from "../tools/notifyTool.js";

let port: NotifyToolPort | null = null;

export function setNotifyToolPort(next: NotifyToolPort | null): void {
  port = next;
}

export function getNotifyToolPort(): NotifyToolPort | null {
  return port;
}

