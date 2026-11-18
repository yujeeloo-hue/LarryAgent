import { requestCollaborative } from "../../collaborative/port.js";
import type { CollaborativeRequest } from "../../shared/collaborative.js";
import { failureResult, textResult } from "../pathUtil.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

export const collaborativeBranchDefinition: ToolDefinition = {
  name: "collaborative_branch",
  description: "Operate on the current workspace's configured collaborative branches without changing session workspacePath, the main branch or its index. state/scan discover Git and SVN repositories, including nested repos. read/list browse a pinned branch without checkout. materialize/save check out only the requested relative path. merge-preview proposes an AI integration from the committed local branch; merge-apply writes a reviewed proposal using expectedHash. commit is separate and MUST only be used when the user explicitly requests a commit; it requires a message. No fetch, push, branch switch, build, or debug is performed. Bindings must first be configured in Dev Mode.",
  parameters: { type: "object", properties: {
    op: { type: "string", description: "exists checks branch-file metadata without reading the body or creating a checkout.", enum: ["state", "scan", "list", "exists", "read", "materialize", "release", "save", "changes", "merge-preview", "merge-apply", "commit"] },
    repositoryId: { type: "string" }, path: { type: "string" }, content: { type: "string" }, expectedHash: { type: "string" }, message: { type: "string" }, paths: { type: "array", items: { type: "string" } },
    discard: { type: "boolean", description: "Release only: allow discarding uncommitted changes ONLY when the user explicitly requested their removal. expectedHash is required." },
  }, required: ["op"], additionalProperties: false },
  defaultPermissionLevel: 1,
};
export const collaborativeBranchHandler: ToolHandler = async (args, context) => {
  const allowed = ["state", "scan", "list", "exists", "read", "materialize", "release", "save", "changes", "merge-preview", "merge-apply", "commit"];
  if (typeof args.op !== "string" || !allowed.includes(args.op)) return failureResult("Unsupported collaborative operation");
  try {
    const request = { ...args, workspacePath: context.workspacePath } as unknown as CollaborativeRequest;
    return textResult(JSON.stringify(await requestCollaborative(request)), 0);
  } catch (error) { return failureResult(error instanceof Error ? error.message : String(error)); }
};
