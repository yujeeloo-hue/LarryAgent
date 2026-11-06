import { postNotification } from "../events/notificationCenter.js";

const sender = { module: "toolsConfig" };

/**
 * Broadcast a tools.json section persistence change (eventName
 * "tools/config_changed"). v1 covers mcpServers/skills — the two sections
 * the Tools page lists; other sections have no broadcast consumer yet.
 * Renderer delivery goes through the NotificationCenter → IPC bridge
 * allowlist ("nc:event"); new sections must be registered there if pushed.
 */
export function postToolsConfigChanged(
  section: "mcpServers" | "skills",
): void {
  postNotification({
    eventName: "tools/config_changed",
    params: { section },
    sender,
  });
}
