export type CollaborativeRepository = {
  id: string;
  name: string;
  root: string;
  kind: "git" | "svn";
  binding?: { branch: string; directory: string; revision: string; localBranch?: string };
  materialized: string[];
};
export type CollaborativeFile = {
  path: string;
  content: string;
  hash: string;
  binary: boolean;
  materialized: boolean;
  diskPath?: string;
};
export type CollaborativeEntry = { name: string; path: string; directory: boolean; materialized: boolean; modified: boolean; localOnly?: boolean };
export type CollaborativeSide = "left" | "right";
export type CollaborativeEditorDraft = { content: string; savedContent: string };
export type CollaborativeCommitFile = {
  side: CollaborativeSide;
  branch: string;
  diskPath: string;
  revision: string;
  hash: string;
  changed: boolean;
  added?: boolean;
  unavailable?: string;
};
export type CollaborativeDiff = {
  path: string;
  localPath?: string;
  branchSource?: string;
  base?: string;
  branchToLocal?: string;
  localChanges?: string;
  identical?: boolean;
  note?: string;
  error?: string;
};
export type CollaborativeMaterializedFile = { path: string; diskPath?: string; created?: "local" | "empty"; error?: string };
export type CollaborativeRequest = {
  workspacePath: string;
  op: "state" | "scan" | "bindings" | "enable" | "bind" | "list" | "exists" | "read" | "materialize" | "release" | "save" | "changes" | "diff" | "commit" | "merge-preview" | "merge-apply"
    | "editor-merge-preview" | "editor-merge-cancel" | "editor-commit-files" | "editor-commit-message" | "editor-commit";
  repositoryId?: string;
  path?: string;
  branch?: string;
  directory?: string;
  enabled?: boolean;
  includeWorkingCopy?: boolean;
  content?: string;
  expectedHash?: string;
  message?: string;
  paths?: string[];
  discard?: boolean;
  create?: boolean;
  editorDrafts?: Partial<Record<CollaborativeSide, CollaborativeEditorDraft>>;
  commitFiles?: CollaborativeCommitFile[];
  mergeId?: string;
};
export type CollaborativeResult = {
  exists?: boolean;
  enabled?: boolean;
  repositories?: CollaborativeRepository[];
  entries?: CollaborativeEntry[];
  file?: CollaborativeFile;
  created?: "local" | "empty";
  paths?: string[];
  diffs?: CollaborativeDiff[];
  materializedFiles?: CollaborativeMaterializedFile[];
  proposal?: { content: string; expectedHash: string; source: string; target: string };
  mergeError?: string;
  commit?: { shortHash: string; subject: string };
  commitFiles?: CollaborativeCommitFile[];
  commitMessage?: { message: string; source: "llm" | "fallback" };
  commitError?: string;
  draftSaved?: boolean;
};
