import { requestCollaborative } from "../../collaborative/port.js";
import type { CollaborativeRequest } from "../../shared/collaborative.js";
import { failureResult, textResult } from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

const OPS = ["state", "scan", "list", "exists", "read", "diff", "materialize", "release", "save", "changes", "merge-preview", "merge-apply", "commit"];

export const collaborativeBranchDefinition: ToolDefinition = {
  name: "collaborative_branch",
  description: "Work with the collaborative branch checkouts the user configured for this workspace (see [Collaborative branches] in the system prompt). Prefer this over creating your own worktree, clone or temporary checkout of those branches. Each checkout is sparse by design: a file exists in the checkout directory only after materialize. Merge flow: diff (local working copy vs the pinned branch, plus the local changes since the merge base) → materialize the files you will change (create: true adds files the branch does not have yet) → edit them with the normal file tools at the returned diskPath → commit ONLY when the user explicitly asks (message required). state lists repositories and bindings; list / read / exists browse the branch without a checkout; changes lists edited checkout files; merge-preview / merge-apply run the built-in AI merge for one file; save writes a whole file guarded by expectedHash; release removes a materialized file. Paths are repository-relative with forward slashes. Never fetches, pushes or switches branches. Bindings are created by the user in Dev Mode.",
  parameters: { type: "object", properties: {
    op: { type: "string", description: "exists checks branch-file metadata without reading the body or creating a checkout.", enum: OPS },
    repositoryId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, expectedHash: { type: "string" }, message: { type: "string" },
    paths: { type: "array", items: { type: "string" }, description: "diff / materialize: up to 20 repository-relative files. commit: the changed paths to commit." },
    create: { type: "boolean", description: "Materialize only: also accept files missing on the branch. Each new file is added to the checkout, seeded from the local working copy file when it exists, otherwise empty (result created: \"local\" | \"empty\"). Files that exist on the branch are materialized normally." },
    discard: { type: "boolean", description: "Release only: allow discarding uncommitted changes ONLY when the user explicitly requested their removal. expectedHash is required." },
  }, required: ["op"], additionalProperties: false },
  defaultPermissionLevel: 1,
};
export const collaborativeBranchHandler: ToolHandler = async (args, context) => {
  if (typeof args.op !== "string" || !OPS.includes(args.op)) return failureResult("Unsupported collaborative operation");
  try {
    const request = { ...args, workspacePath: context.workspacePath } as unknown as CollaborativeRequest;
    return textResult(JSON.stringify(await requestCollaborative(request)), 0);
  } catch (error) { return failureResult(error instanceof Error ? error.message : String(error)); }
};
