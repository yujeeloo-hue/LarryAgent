import { createHash } from "node:crypto";
import type { CocoMcpEvent } from "../coco/types.js";
import { addNotificationListener, type NotificationCenterEvent } from "../events/notificationCenter.js";
import type { CocoServiceDeps } from "./cocoServiceDeps.js";

/**
 * MCP notifications forwarded by NotificationCenter (src/mcp/notifications.ts):
 * one app-level record per notification, visible in CoCo context only
 * ("see, don't act"; no wake, no rule triggering).
 */
export function createCocoEventSources(deps: CocoServiceDeps) {
  const { repository } = deps;
  const MCP_EVENT_KIND = "mcpEvent";
  const MCP_EVENT_RETENTION = 200;
  const recordMcpEvent = (event: NotificationCenterEvent): void => {
    const { serverId, serverName, data } = event.params as Partial<{ serverId: unknown; serverName: unknown; data: unknown }>;
    if (typeof serverId !== "string" || typeof serverName !== "string") return;
    if (!deps.alive() || !deps.engine().settings().enabled) return;
    const id = createHash("sha256").update(`${event.eventName}\n${serverId}\n${JSON.stringify(data ?? null)}`).digest("hex");
    if (repository.get(MCP_EVENT_KIND, id)) return; // dedup: first-seen wins
    repository.put(MCP_EVENT_KIND, { id, method: event.eventName, serverId, serverName, at: Date.now() } satisfies CocoMcpEvent);
    const all = repository.list<CocoMcpEvent>(MCP_EVENT_KIND);
    if (all.length > MCP_EVENT_RETENTION) {
      for (const stale of all.slice(0, all.length - MCP_EVENT_RETENTION)) repository.remove(MCP_EVENT_KIND, stale.id);
    }
  };
  const unsubscribeMcpEvents = addNotificationListener(recordMcpEvent);
  return { stop: unsubscribeMcpEvents };
}
