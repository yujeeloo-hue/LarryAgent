import { addNotificationListener } from "./notificationCenter.js";

export const NC_RENDERER_EVENT_ALLOWLIST = new Set([
  "mcp/server_status",
  "tools/config_changed",
]);

export function attachNotificationCenterRendererBridge(
  forward: (payload: { eventName: string; params: unknown }) => void,
): () => void {
  return addNotificationListener((event) => {
    if (!NC_RENDERER_EVENT_ALLOWLIST.has(event.eventName)) return;
    forward({ eventName: event.eventName, params: event.params });
  });
}
