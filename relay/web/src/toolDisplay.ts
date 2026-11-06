import { toolIconCatalog } from "../../../src/shared/icons/toolIconCatalog.js";
/** Tool labels and icons, shared by rich cards and the Thinking dock. */
type ToolMeta = { displayName: string; icon: string };

const TOOL_META: Record<string, ToolMeta> = Object.fromEntries(
  Object.entries(toolIconCatalog).map(([name, meta]) => [name, {
    displayName: meta.displayName,
    icon: meta.icon[0]!.toLowerCase() + meta.icon.slice(1),
  }]),
);

export function toolMeta(name: string): ToolMeta {
  const direct = TOOL_META[name];
  if (direct) return direct;
  if (name.startsWith("mcp__")) {
    const short = name.slice(name.lastIndexOf("__") + 2);
    return { displayName: `MCP : ${short || name}`, icon: "server" };
  }
  return { displayName: name.trim() || "Tool", icon: "wrench" };
}


export function resolveToolHint(hint: string): { icon: string; label: string; text: string } {
  const text = hint.trim();
  if (text.startsWith("MCP :")) {
    return { icon: "server", label: "MCP", text: text.slice(5).trim() || text };
  }
  let label = "";
  let icon = "wrench";
  for (const meta of Object.values(TOOL_META)) {
    if (text.startsWith(meta.displayName) && meta.displayName.length > label.length) {
      label = meta.displayName;
      icon = meta.icon;
    }
  }
  return { icon, label, text: text.slice(label.length).trim() || text };
}
