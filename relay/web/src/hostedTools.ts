
export type HostedToolFamily = "web_search" | "code_interpreter" | "image_generation";

export interface HostedToolFamilySpec {
  family: HostedToolFamily;
  label: string;
  types: readonly string[];
  defaultTool: Record<string, unknown>;
}

export const HOSTED_TOOL_FAMILIES: readonly HostedToolFamilySpec[] = [
  {
    family: "web_search",
    label: "Web search",
    types: ["web_search", "web_search_preview"],
    defaultTool: { type: "web_search" },
  },
  {
    family: "code_interpreter",
    label: "Code execution",
    types: ["code_interpreter"],
    defaultTool: { type: "code_interpreter", container: { type: "auto" } },
  },
  {
    family: "image_generation",
    label: "Image generation",
    types: ["image_generation"],
    defaultTool: { type: "image_generation" },
  },
];

export function normalizeToolsArray(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (tool): tool is Record<string, unknown> =>
      Boolean(tool) && typeof tool === "object" && !Array.isArray(tool)
        && typeof (tool as { type?: unknown }).type === "string"
        && Boolean((tool as { type: string }).type.trim()),
  );
}

export function toolEnabled(tools: Array<Record<string, unknown>>, family: HostedToolFamily): boolean {
  const spec = HOSTED_TOOL_FAMILIES.find((item) => item.family === family)!;
  return tools.some((tool) => spec.types.includes(String(tool.type)));
}

export function setToolEnabled(
  tools: Array<Record<string, unknown>>,
  family: HostedToolFamily,
  enabled: boolean,
): Array<Record<string, unknown>> {
  const spec = HOSTED_TOOL_FAMILIES.find((item) => item.family === family)!;
  const matches = (tool: Record<string, unknown>): boolean => spec.types.includes(String(tool.type));
  if (!enabled) return tools.filter((tool) => !matches(tool));
  return tools.some(matches) ? tools : [...tools, structuredClone(spec.defaultTool)];
}

export type ParsedHostedTools =
  | { ok: true; tools: Array<Record<string, unknown>> }
  | { ok: false; error: string };

export function parseHostedToolsJson(text: string): ParsedHostedTools {
  let value: unknown;
  try {
    value = JSON.parse(text.trim() || "[]");
  } catch {
    return { ok: false, error: "Hosted tools must be valid JSON." };
  }
  if (!Array.isArray(value)) {
    return { ok: false, error: "Enter a JSON array of tools, each with a type." };
  }
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)
      || typeof (item as { type?: unknown }).type !== "string"
      || !(item as { type: string }).type.trim()) {
      return { ok: false, error: "Enter a JSON array of tools, each with a type." };
    }
  }
  return { ok: true, tools: value.map((tool) => structuredClone(tool) as Record<string, unknown>) };
}
