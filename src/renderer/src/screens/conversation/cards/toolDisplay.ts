import { MessagesSquare, type IconNode } from "lucide";
import { toolIconCatalog } from "../../../../../shared/icons/toolIconCatalog.js";
import { desktopFunctionalIconNodes } from "../../../ui/functionalIconNames.js";

/** Must match `TOOL_RESULT_BODY_PART_ID` in src/tools/displayMeta.ts */
export const TOOL_RESULT_BODY_PART_ID = "file_body";

/** Must match `TOOL_RESULT_DIFF_PART_ID` in src/tools/displayMeta.ts */
export const TOOL_RESULT_DIFF_PART_ID = "file_diff";

/** Matches main-process MCP registry prefix (`mcp__{serverId}__{tool}`). */
const MCP_TOOL_PREFIX = "mcp__";

export type ToolDisplayMeta = {
  displayName: string;
  icon: IconNode;
  expandResultByDefault: boolean;
};

/**
 * Default expansion policy for rich (full-width) cards only.
 * Compact cards never expand — see isRichToolCard().
 */
const iconNodes = new Map(Object.entries(desktopFunctionalIconNodes));
// Ask User deliberately uses the Lucide outline approved in the preview.
iconNodes.set("MessagesSquare", MessagesSquare);
const Server = iconNodes.get("Server")!;
const Wrench = iconNodes.get("Wrench")!;
const META: Record<string, ToolDisplayMeta> = Object.fromEntries(
  Object.entries(toolIconCatalog).map(([name, meta]) => [name, { ...meta, icon: iconNodes.get(meta.icon)! }]),
);

const FALLBACK: ToolDisplayMeta = {
  displayName: "Tool",
  icon: Wrench,
  expandResultByDefault: false,
};

export function isMcpRegistryToolName(name: string): boolean {
  return name.startsWith(MCP_TOOL_PREFIX);
}

/** Original MCP tool name from `mcp__{serverId}__{toolName}`. */
export function mcpToolDisplayName(registryName: string): string {
  if (!isMcpRegistryToolName(registryName)) return registryName;
  const rest = registryName.slice(MCP_TOOL_PREFIX.length);
  const sep = rest.indexOf("__");
  const tool = sep >= 0 ? rest.slice(sep + 2) : rest;
  return tool.trim() || "tool";
}

export function getToolDisplayMeta(name: string): ToolDisplayMeta {
  const meta = META[name];
  if (meta) return meta;
  if (isMcpRegistryToolName(name)) {
    return {
      displayName: `MCP : ${mcpToolDisplayName(name)}`,
      icon: Server,
      expandResultByDefault: false,
    };
  }
  return {
    displayName: name.trim() || FALLBACK.displayName,
    icon: FALLBACK.icon,
    expandResultByDefault: false,
  };
}

/** display-name → icon index for resolving Thinking-title hints. */
const HINT_LABEL_ICONS: ReadonlyArray<readonly [string, IconNode]> = (() => {
  const map = new Map<string, IconNode>();
  for (const meta of Object.values(META)) map.set(meta.displayName, meta.icon);
  return Array.from(map.entries());
})();

/** Chip parts for a Thinking-title hint produced by `toolHintLabel`. */
export type ResolvedToolHint = {
  icon: IconNode;
  /** Tool display name ("Read File", "MCP") matched from the hint prefix. */
  label: string;
  /** Object/detail only (the icon carries the verb); full hint when unmatched. */
  text: string;
};

/**
 * Resolve a hint string like `"Read File a.ts"` into its tool icon plus the
 * object text. Hints are always `${displayName}[ ${detail}]`, so the longest
 * display-name prefix is the exact label boundary; MCP hints keep their
 * `MCP : ` prefix; anything else falls back to the wrench icon.
 */
export function resolveToolHint(hint: string): ResolvedToolHint {
  const text = hint.trim();
  if (!text) return { icon: FALLBACK.icon, label: "", text };
  if (text.startsWith("MCP :")) {
    const rest = text.slice("MCP :".length).trim();
    return { icon: Server, label: "MCP", text: rest || text };
  }
  let bestLabel = "";
  let bestIcon: IconNode | null = null;
  for (const [label, icon] of HINT_LABEL_ICONS) {
    if (text.startsWith(label) && label.length > bestLabel.length) {
      bestLabel = label;
      bestIcon = icon;
    }
  }
  if (bestIcon === null) return { icon: FALLBACK.icon, label: "", text };
  return { icon: bestIcon, label: bestLabel, text: text.slice(bestLabel.length).trim() || text };
}

/** Parse `+12 −3` / `+12 -3` from tool result summary text. */
export function parseLineChangeCounts(
  text: string,
): { added: number; removed: number } | null {
  const match = text.match(/\+(\d+)\s*[−-]\s*(\d+)/);
  if (!match) return null;
  return {
    added: Number(match[1]),
    removed: Number(match[2]),
  };
}
