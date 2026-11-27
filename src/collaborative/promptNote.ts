import type { CollaborativeRepository } from "../shared/collaborative.js";
import { requestCollaborative } from "./port.js";

export const COLLABORATIVE_NOTE_HEADER = "[Collaborative branches — configured by the user for this workspace]";

const MAX_LISTED = 12;

export function buildCollaborativeNote(repositories: readonly CollaborativeRepository[]): string | null {
  const bound = repositories.filter(repo => repo.binding);
  if (!bound.length) return null;
  const lines = [
    COLLABORATIVE_NOTE_HEADER,
    "Each checkout below is sparse by design: a file exists there only after it is materialized.",
  ];
  for (const repo of bound.slice(0, MAX_LISTED)) {
    const binding = repo.binding!;
    const local = binding.localBranch ? `, local branch ${binding.localBranch}` : "";
    lines.push(`- ${repo.name} (${repo.kind}, repositoryId ${repo.id}) local ${repo.root} · branch ${binding.branch} → checkout ${binding.directory}${local}`);
  }
  if (bound.length > MAX_LISTED) lines.push(`- … ${bound.length - MAX_LISTED} more — collaborative_branch op=state lists them.`);
  lines.push(
    "When a task involves these branches (porting a feature, merging code, comparing with the branch), use collaborative_branch instead of creating your own worktree, clone or temporary checkout:",
    "diff compares local files with the branch; materialize checks out only the files you will change (create: true for files new to the branch); then edit them with the normal file tools inside the checkout directory. Commit only when the user asks.",
    "If collaborative_branch is not in your tool list, call it through tool_describe → tool_call.",
  );
  return lines.join("\n");
}

export async function loadCollaborativeNote(workspacePath: string): Promise<string | null> {
  try {
    return buildCollaborativeNote((await requestCollaborative({ op: "bindings", workspacePath })).repositories ?? []);
  } catch {
    return null;
  }
}
