/**
 * MCP → NotificationCenter forwarding.
 *
 * Attaches the SDK client's fallbackNotificationHandler so every
 * server-initiated notification that has no dedicated handler — standard
 * methods (notifications/message, notifications/tools/list_changed,
 * notifications/resources/updated, …) as well as arbitrary custom methods —
 * is re-broadcast on the generic NotificationCenter (src/events/).
 *
 * Event mapping: eventName keeps the raw MCP method string; serverId /
 * serverName travel inside params (data holds the raw notification params,
 * nested to avoid key collisions).
 *
 * SDK boundary (accepted for v1): notifications/progress carrying a
 * progressToken that matches an in-flight request callback is routed
 * internally by the SDK and never reaches the fallback handler — such
 * progress is neither duplicated nor received here.
 */

import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { postNotification } from "../events/notificationCenter.js";
import type { JsonObject } from "../session/types.js";

export type McpNotificationForwarderOptions = {
  serverId: string;
  serverName: string;
  /** Producer identity for the broadcast events (McpManager instance). */
  sender: unknown;
};

function normalizeParams(params: unknown): JsonObject {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown> as JsonObject;
  }
  return {};
}

/**
 * Install the fallback notification forwarder on a freshly opened client.
 * Call after every (re)connect — each connection creates a new client and
 * a closed client never delivers notifications again.
 */
export function attachMcpNotificationForwarder(
  client: Client,
  options: McpNotificationForwarderOptions,
): void {
  const { serverId, serverName, sender } = options;
  client.fallbackNotificationHandler = async (notification: Notification) => {
    postNotification({
      eventName: notification.method,
      params: {
        serverId,
        serverName,
        data: normalizeParams(notification.params),
      },
      sender,
    });
  };
}
