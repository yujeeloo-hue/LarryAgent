import { postNotification } from "../events/notificationCenter.js";

const sender = { module: "toolsConfig" };

export function postToolsConfigChanged(
  section: "mcpServers" | "skills",
): void {
  postNotification({
    eventName: "tools/config_changed",
    params: { section },
    sender,
  });
}
