export type WorkingTreeStats = {
  isRepo: boolean;
  insertions: number;
  deletions: number;
  dirtyFileCount: number;
  aheadCount: number;
  behindCount: number;
};

export type WorkingTreeChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

export type WorkingTreeChange = {
  path: string;
  oldPath?: string;
  status: WorkingTreeChangeStatus;
  insertions: number;
  deletions: number;
  binary: boolean;
};

export type WorkingTreeChangesResult = {
  isRepo: boolean;
  files: WorkingTreeChange[];
};

export type WorkingTreePathDiff = {
  path: string;
  binary: boolean;
  before: string;
  after: string;
  truncated: boolean;
};

export type PathDiffStats = {
  path: string;
  isRepo: boolean;
  insertions: number;
  deletions: number;
  hasDiff: boolean;
};

export type CommitContext = {
  status: string;
  diff: string;
  dirtyFileCount: number;
  insertions: number;
  deletions: number;
};

export type PrepareCommitResult = {
  draftMessage: string;
  messageSource: "llm" | "fallback";
  stats: WorkingTreeStats;
};

export type CommitResult = {
  ok: true;
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  vcs?: "git" | "svn";
};
