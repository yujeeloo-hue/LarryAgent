import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  PLAN_DOC_CONTENT_RECOMMENDED,
  PLAN_DOC_SUMMARY_MAX,
  buildPlanDocAbsolutePath,
  clipPlanDocSummary,
  displayPlanDocPath,
  isUnderPlanDocDir,
  planDocRevision,
} from "../../session/planDoc.js";
import { refreshPlanDocRef } from "../../session/plan.js";
import type { SessionPlanDoc } from "../../session/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import type { ToolDefinition, ToolHandler } from "../types.js";
import { abortIfSignaled, failureResult, revalidateToolPath, textResult } from "../pathUtil.js";

/** Default level: 0 — plan-mode gate artifact under docs/plans/. */
export const writePlanDocDefinition: ToolDefinition = {
  name: "write_plan_doc",
  description:
    "Write a markdown plan doc under docs/plans/ (required before " +
    "create_plan in Plan mode). Full-content write: title (filename slug) " +
    "+ content (complete markdown body — Goal, Approach, Acceptance, …) + " +
    "summary. The document is written wholesale; to change it, send the " +
    "full updated content again.",
  parameters: {
    type: "object",
    properties: {
      title: {
        type: "string",
        description: "Short plan title (filename slug).",
      },
      content: {
        type: "string",
        description:
          "Full markdown body (Goal, Approach, Acceptance, …) — the doc " +
          "is written wholesale, so include everything. Aim for ≤" +
          PLAN_DOC_CONTENT_RECOMMENDED +
          " characters (recommended, not enforced).",
      },
      summary: {
        type: "string",
        description:
          `Short executor summary (≤${PLAN_DOC_SUMMARY_MAX} chars).`,
      },
    },
    required: ["title", "content", "summary"],
    additionalProperties: false,
  },
  defaultPermissionLevel: 0,
};

export const writePlanDocHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const workspacePath = context.workspacePath?.trim() ?? "";
  if (!workspacePath) {
    return failureResult(
      "No workspace path on this session; cannot write a plan document.",
      ToolReturnCode.NotFound,
    );
  }

  const title = typeof args.title === "string" ? args.title.trim() : "";
  const content = typeof args.content === "string" ? args.content : null;
  const summaryRaw =
    typeof args.summary === "string" ? args.summary.trim() : "";

  if (!title || content === null || !summaryRaw) {
    return failureResult(
      'Invalid arguments: "title", "content", and "summary" (non-empty strings) are required.',
      ToolReturnCode.InvalidArguments,
    );
  }

  // Advisory only — see PLAN_DOC_CONTENT_RECOMMENDED.
  const lengthNote =
    content.length > PLAN_DOC_CONTENT_RECOMMENDED
      ? `\nnote: content is ${content.length} characters — recommended ≤${PLAN_DOC_CONTENT_RECOMMENDED}; written as-is.`
      : "";

  const summary = clipPlanDocSummary(summaryRaw);
  if (!summary) {
    return failureResult(
      'Invalid arguments: "summary" must be non-empty.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const absolutePath = buildPlanDocAbsolutePath(workspacePath, title);
  if (!isUnderPlanDocDir(workspacePath, absolutePath)) {
    return failureResult(
      "Internal error: computed plan doc path is outside docs/plans/.",
      ToolReturnCode.GenericFailure,
    );
  }

  const shown = displayPlanDocPath(absolutePath);

  try {
    const abortedBeforeWrite = abortIfSignaled(context.signal);
    if (abortedBeforeWrite) return abortedBeforeWrite;

    const denied = revalidateToolPath(absolutePath, context);
    if (denied) return denied;

    await mkdir(dirname(absolutePath), { recursive: true });
    const abortedAfterMkdir = abortIfSignaled(context.signal);
    if (abortedAfterMkdir) return abortedAfterMkdir;

    const deniedAfterMkdir = revalidateToolPath(absolutePath, context);
    if (deniedAfterMkdir) return deniedAfterMkdir;

    await writeFile(absolutePath, Buffer.from(content, "utf8"));
    const abortedAfterWrite = abortIfSignaled(context.signal);
    if (abortedAfterWrite) return abortedAfterWrite;

    const planDoc: SessionPlanDoc = {
      path: absolutePath,
      summary,
      updatedAt: Date.now(),
      revision: planDocRevision(content),
    };
    const previous = context.planDocSnapshot;
    if (previous?.path === absolutePath && previous.revision === planDoc.revision) {
      if (previous.reviewedRevision) planDoc.reviewedRevision = previous.reviewedRevision;
      if (previous.approvedRevision) planDoc.approvedRevision = previous.approvedRevision;
      if (previous.approvedAt !== undefined) planDoc.approvedAt = previous.approvedAt;
      if (previous.executionRequestedRevision) planDoc.executionRequestedRevision = previous.executionRequestedRevision;
    }
    const sessionPatch: import("../../agent/contracts/index.js").SessionPatch = {
      planDoc,
    };
    const currentPlan = context.planSnapshot;
    if (currentPlan?.status === "active") {
      sessionPatch.plan = refreshPlanDocRef(currentPlan, planDoc);
    }
    return {
      ...textResult(
        `Wrote ${shown}${lengthNote}\nsummary: ${summary}`,
        ToolReturnCode.Success,
      ),
      sessionPatch,
      routeEvent: { event: "doc_written", source: "tool" },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return failureResult(
      `Failed to write plan document: ${message}`,
      ToolReturnCode.GenericFailure,
    );
  }
};
