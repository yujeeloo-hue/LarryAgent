import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import { clipPlanDocSummary, isUnderPlanDocDir, planDocHeadingSummary, planDocRevision } from "../../session/planDoc.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { SessionPlanDoc } from "../../session/types.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, resolveToolPath, textResult } from "../pathUtil.js";

export const adoptPlanDocDefinition: ToolDefinition = {
  name: "adopt_plan_doc",
  description: "Read and bind an existing current-task markdown plan under docs/plans/ without rewriting it. Reuse a design from Agent mode and hand it to plan review instead of creating a duplicate document. Never claims user approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Absolute path to the current task's existing plan document under workspace/docs/plans/." },
      summary: { type: "string", description: "Optional short summary; defaults to the document heading." },
    },
    required: ["path"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const adoptPlanDocHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;
  const workspacePath = context.workspacePath?.trim();
  const path = typeof args.path === "string" ? args.path.trim() : "";
  if (!workspacePath || !path) return failureResult("A workspace and plan document path are required.", ToolReturnCode.InvalidArguments);
  const resolved = resolveToolPath(path, { workspacePath, allowOutsideWorkspace: false });
  if (!resolved.ok) return failureResult(resolved.reason, resolved.returnCode);
  if (!isUnderPlanDocDir(workspacePath, resolved.path.absolute)) {
    return failureResult("The plan document must be under workspace/docs/plans/.", ToolReturnCode.InvalidArguments);
  }
  try {
    const [root, actual] = await Promise.all([realpath(workspacePath), realpath(resolved.path.absolute)]);
    const rel = relative(root, actual);
    if (rel.startsWith("..") || isAbsolute(rel)) return failureResult("The plan document resolves outside the workspace.", ToolReturnCode.InvalidArguments);
    const content = await readFile(actual, "utf8");
    const cancelled = abortIfSignaled(context.signal);
    if (cancelled) return cancelled;
    if (!content.trim()) return failureResult("The plan document is empty.", ToolReturnCode.InvalidArguments);
    const revision = planDocRevision(content);
    const previous = context.planDocSnapshot;
    const unchanged = previous?.path === resolved.path.absolute && previous.revision === revision;
    const doc: SessionPlanDoc = {
      ...(unchanged ? previous : {}),
      path: resolved.path.absolute,
      summary: clipPlanDocSummary(typeof args.summary === "string" && args.summary.trim() ? args.summary : planDocHeadingSummary(content) ?? "Existing plan document"),
      updatedAt: Date.now(),
      revision,
      ...(context.planExecutionRequested === true ? { executionRequestedRevision: revision } : {}),
    };
    return {
      ...textResult(`Adopted ${doc.path}\nsummary: ${doc.summary}\nrevision: ${revision}\n\n${content}`, ToolReturnCode.Success),
      sessionPatch: { planDoc: doc },
      routeEvent: { event: "doc_adopted", source: "tool" },
    };
  } catch (error) {
    return failureResult(`Could not read plan document: ${error instanceof Error ? error.message : String(error)}`, ToolReturnCode.NotFound);
  }
};
