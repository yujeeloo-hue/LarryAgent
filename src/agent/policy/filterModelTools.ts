import { isToolNamePermitted } from "./toolNameLists.js";

export type ModelToolPolicy = {
  allowTools?: readonly string[];
  denyTools?: readonly string[];
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function identity(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.trim() === value
    ? value
    : undefined;
}

/**
 * Functions use their actual name, while hosted tools use their native type.
 * MCP exposes two policy aliases: "mcp" for every server and server_label for
 * one server. Both must be valid so a missing label cannot evade a server deny.
 */
function toolIdentities(value: unknown): string[] {
  const tool = asRecord(value);
  if (!tool) return [];
  const type = identity(tool.type);
  if (!type) return [];
  if (type === "function") {
    const nestedName = identity(asRecord(tool.function)?.name);
    const flatName = identity(tool.name);
    // Ambiguous mixed wire formats must not let either name bypass a policy.
    if (nestedName && flatName && nestedName !== flatName) return [];
    const name = nestedName ?? flatName;
    return name ? [name] : [];
  }
  if (type === "mcp") {
    const label = identity(tool.server_label);
    return label ? [type, label] : [];
  }
  return [type];
}

/**
 * Intersect model-visible tools with the configured policy before a request.
 * Deny matches on any identity win; an allow list must match at least one.
 * Unknown/malformed identities fail closed whenever any restriction exists.
 * Empty lists preserve the previous unrestricted behavior and tool objects.
 */
export function filterModelTools<T>(
  tools: readonly T[],
  policy: ModelToolPolicy,
): T[] {
  const allow = policy.allowTools ?? [];
  const deny = policy.denyTools ?? [];
  if (allow.length === 0 && deny.length === 0) return tools.slice();
  return tools.filter((tool) => {
    const identities = toolIdentities(tool);
    if (identities.length === 0) return false;
    if (!identities.every((name) => isToolNamePermitted(name, { denyTools: deny }))) {
      return false;
    }
    return allow.length === 0 || identities.some(
      (name) => isToolNamePermitted(name, { allowTools: allow }),
    );
  });
}
