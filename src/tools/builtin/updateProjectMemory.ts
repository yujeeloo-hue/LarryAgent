import {
  composeProjectMemoryWrite,
  loadProjectMemory,
  setProjectMemoryBody,
} from "../../projectMemory/store.js";
import { normalizeProjectMemorySection } from "../../projectMemory/types.js";
import { ToolReturnCode } from "../../session/returnCodes.js";
import {
  abortIfSignaled,
  failureResult,
  textResult,
} from "../pathUtil.js";
import { projectMemoryWorkspace } from "../projectMemoryTarget.js";
import type { ToolDefinition, ToolHandler } from "../types.js";

/** Default level: 0 (always allowed). */
export const updateProjectMemoryDefinition: ToolDefinition = {
  name: "update_project_memory",
  description:
    "Update workspace PROJECT.md front sections (basics / structure / conventions / docs_guide; aim ≤3000 chars — soft target, never truncated). The Recent section is code-synthesized from the docs log files — never write it here. For docs/WORKLOG.md, PITFALLS.md, HANDOFF.md, STYLE.md, DEPLOY.md use write_file directly.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "Markdown to write (prefer short, high-signal facts).",
      },
      mode: {
        type: "string",
        enum: ["merge", "replace"],
        description: "merge (default) appends; replace overwrites.",
      },
      section: {
        type: "string",
        enum: ["basics", "structure", "conventions", "docs_guide"],
        description: "When set, only update that front section.",
      },
    },
    required: ["content"],
  },
  defaultPermissionLevel: 0,
};

export const updateProjectMemoryHandler: ToolHandler = async (args, context) => {
  const aborted = abortIfSignaled(context.signal);
  if (aborted) return aborted;

  const workspacePath = projectMemoryWorkspace(args, context);
  if (typeof workspacePath !== "string") return workspacePath;

  const content = typeof args.content === "string" ? args.content : "";
  if (!content.trim()) {
    return failureResult(
      'Invalid arguments: "content" must be a non-empty string.',
      ToolReturnCode.InvalidArguments,
    );
  }

  const modeRaw = typeof args.mode === "string" ? args.mode.trim() : "merge";
  const mode = modeRaw === "replace" ? "replace" : "merge";
  const section = normalizeProjectMemorySection(args.section);
  if (args.section !== undefined && args.section !== null && !section) {
    return failureResult(
      'Invalid arguments: "section" must be basics | structure | conventions | docs_guide (Recent is code-synthesized; docs files are written with write_file).',
      ToolReturnCode.InvalidArguments,
    );
  }

  const composed = await composeProjectMemoryWrite(
    workspacePath,
    content,
    mode,
    section,
  );
  if (!composed) {
    const snap = await loadProjectMemory(workspacePath);
    return textResult(
      `Project memory unchanged. PROJECT.md is ${snap.body.length} characters.`,
      ToolReturnCode.Success,
    );
  }

  // No hard truncation: over-target bodies are stored as-is. Semantic
  // compression (when worthwhile) happens in the background extract flow.
  const snap = await setProjectMemoryBody(workspacePath, composed.nextBody);
  const sectionNote = section ? `, section=${section}` : "";
  return textResult(
    `Project memory updated (${mode}${sectionNote}). PROJECT.md now ${snap.body.length} characters.`,
    ToolReturnCode.Success,
  );
};
