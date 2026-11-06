/**
 * NotificationCenter — generic in-process event hub (main process).
 *
 * Deliberately decoupled from any producer: MCP servers are the first
 * producer (src/mcp/notifications.ts forwards SDK notifications), but the
 * hub itself knows nothing about MCP. Future consumers (CoCo event sources,
 * renderer IPC, notify) subscribe via addNotificationListener and filter by
 * eventName themselves — v1 ships zero consumers.
 *
 * Event shape: { eventName, params, sender } where sender is any object
 * identifying the producer (e.g. the McpManager instance).
 */

import type { JsonObject } from "../session/types.js";

export type NotificationCenterEvent = {
  eventName: string;
  params: JsonObject;
  /** Producing object (opaque to the hub); MCP events use the McpManager. */
  sender: unknown;
};

export type NotificationCenterListener = (event: NotificationCenterEvent) => void;

const listeners = new Set<NotificationCenterListener>();

/**
 * Broadcast one event to all current listeners. Synchronous dispatch.
 * A throwing listener is logged and isolated — it never breaks sibling
 * listeners or the posting side.
 */
export function postNotification(event: NotificationCenterEvent): void {
  // Snapshot: a listener that (un)subscribes during dispatch must not
  // mutate the iteration of the current pass.
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (err) {
      console.error("[notification-center] listener threw", err);
    }
  }
}

/** Subscribe to all events (no eventName filter in v1). Returns unsubscribe. */
export function addNotificationListener(
  listener: NotificationCenterListener,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
