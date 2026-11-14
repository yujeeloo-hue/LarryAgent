import { addNotificationListener } from "./notificationCenter.js";

/**
 * Event names allowed to cross the main → renderer bridge (single "nc:event"
 * channel). The allowlist is the flood dam: unlisted events intentionally
 * never reach the renderer. Want a new event pushed? Register it here and
 * pin the set in rendererBridge.test.ts.
 */
export const NC_RENDERER_EVENT_ALLOWLIST = new Set([
  "mcp/server_status",
  "tools/config_changed",
]);

/**
 * Forward allowlisted NotificationCenter events to a renderer-facing sender
 * (main wires this to broadcastToRenderer on channel "nc:event"). Returns a
 * detach function.
 */
export function attachNotificationCenterRendererBridge(
  forward: (payload: { eventName: string; params: unknown }) => void,
): () => void {
  return addNotificationListener((event) => {
    if (!NC_RENDERER_EVENT_ALLOWLIST.has(event.eventName)) return;
    forward({ eventName: event.eventName, params: event.params });
  });
}
