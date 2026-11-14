import { relative, resolve, sep } from "node:path";
import type { CocoContext, CocoEngine } from "../coco/engine.js";
import { inCocoScope } from "../coco/scope.js";
import type { CocoRule, CocoSettings } from "../coco/types.js";
import { onProjectWorklogWritten } from "../projectMemory/docsStore.js";
import { onProjectMemoryWritten } from "../projectMemory/store.js";
import { PROJECT_DOCS_DIR, PROJECT_DOC_FILENAMES } from "../projectMemory/types.js";
import { onToolFileWrite } from "../tools/fileWriteEvents.js";
import { onWorkspaceLifecycle } from "../workspace/events.js";
import { onSkillCurationRun } from "./skillCuration.js";
import { COCO_HOME_WORKSPACE_ID } from "../workspace/index.js";

type Doc = "PROJECT.md" | "WORKLOG.md";
const WORKLOG_RELATIVE = [PROJECT_DOCS_DIR, PROJECT_DOC_FILENAMES.worklog].join(sep);

/**
 * Wake-ledger writers: every entry is recorded where the fact happens
 * (memory/doc writes, file tools, workspace create/delete). No polling.
 * Task outcomes are recorded by the engine itself.
 */
export function createCocoWakeSources(input: {
  alive(): boolean;
  engine(): CocoEngine;
  context(settings: CocoSettings, rule?: CocoRule): CocoContext;
  /** A workspace was created or deleted (project awareness reconciles). */
  onWorkspaceChanged(): void;
}) {
  const unsubscribers: (() => void)[] = [];

  const projectAt = (path: string) => {
    const target = resolve(path);
    return input.context(input.engine().settings()).workspaces.find(w => w.path && resolve(w.path) === target);
  };
  const recordDoc = (workspacePath: string, doc: Doc): void => {
    if (!input.alive()) return;
    const project = projectAt(workspacePath);
    if (!project?.path) return;
    input.engine().recordWake({ kind: "project_doc", workspaceId: project.id, workspaceName: project.name, workspacePath: project.path, doc }, false);
  };
  /** A file tool wrote PROJECT.md or docs/WORKLOG.md at the root of a managed project. */
  const fileWritten = (path: string): void => {
    if (!input.alive()) return;
    for (const project of input.context(input.engine().settings()).workspaces) {
      if (!project.path) continue;
      const rel = relative(resolve(project.path), path);
      if (rel === "PROJECT.md") return recordDoc(project.path, "PROJECT.md");
      if (rel === WORKLOG_RELATIVE) return recordDoc(project.path, "WORKLOG.md");
    }
  };

  return {
    start(): void {
      if (unsubscribers.length) return;
      unsubscribers.push(
        onProjectMemoryWritten(path => recordDoc(path, "PROJECT.md")),
        onProjectWorklogWritten(path => recordDoc(path, "WORKLOG.md")),
        onToolFileWrite(event => fileWritten(event.path)),
        onSkillCurationRun((result, summary) => {
          if (!input.alive() || !result.items.some(i => i.applied || i.proposalId)) return;
          input.engine().recordWake({ kind: "skill_library", workspaceId: "", workspaceName: "", workspacePath: "", summary }, false);
        }),
        onWorkspaceLifecycle(({ type, workspace }) => {
          if (!input.alive() || workspace.id === COCO_HOME_WORKSPACE_ID) return;
          if (inCocoScope(input.engine().settings(), workspace.id)) {
            input.engine().recordWake({ kind: type === "created" ? "workspace_added" : "workspace_removed", workspaceId: workspace.id, workspaceName: workspace.name, workspacePath: workspace.path }, true);
          }
          input.onWorkspaceChanged();
        }),
      );
    },
    stop(): void { for (const unsubscribe of unsubscribers.splice(0)) unsubscribe(); },
  };
}
