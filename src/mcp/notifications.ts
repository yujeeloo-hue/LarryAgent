
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Notification } from "@modelcontextprotocol/sdk/types.js";
import { postNotification } from "../events/notificationCenter.js";
import type { JsonObject } from "../session/types.js";

export type McpNotificationForwarderOptions = {
  serverId: string;
  serverName: string;
  sender: unknown;
  onNotification?: (method: string, params: JsonObject) => void;
};

function normalizeParams(params: unknown): JsonObject {
  if (params && typeof params === "object" && !Array.isArray(params)) {
    return params as Record<string, unknown> as JsonObject;
  }
  return {};
}

export function attachMcpNotificationForwarder(
  client: Client,
  options: McpNotificationForwarderOptions,
): void {
  const { serverId, serverName, sender, onNotification } = options;
  client.fallbackNotificationHandler = async (notification: Notification) => {
    const data = normalizeParams(notification.params);
    try {
      onNotification?.(notification.method, data);
    } catch {
    }
    postNotification({
      eventName: notification.method,
      params: {
        serverId,
        serverName,
        data,
      },
      sender,
    });
  };
}
