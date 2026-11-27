import type { SessionSummary } from "./types.js";

const WORKSPACE_MUTATION_TOOLS = new Set(["create_workspace", "rename_workspace"]);

export function isWorkspaceMutationTool(name: string | undefined): boolean {
  return typeof name === "string" && WORKSPACE_MUTATION_TOOLS.has(name);
}

export function deviceProjectIds(
  sessions: readonly SessionSummary[],
  knownNames: ReadonlyMap<string, string> | undefined,
  registered: readonly { id: string }[],
): string[] {
  const seen = new Set<string>(registered.map((workspace) => workspace.id));
  for (const session of sessions) {
    if (session.archived) continue;
    if (knownNames && !knownNames.has(session.workspaceId)) continue;
    seen.add(session.workspaceId);
  }
  return [...seen];
}
