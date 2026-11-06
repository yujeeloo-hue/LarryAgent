/** Working-tree line change summary relative to HEAD (or empty tree). */
export type WorkingTreeStats = {
  isRepo: boolean;
  insertions: number;
  deletions: number;
  /** Count of paths with any change (tracked + untracked). */
  dirtyFileCount: number;
  /** Commits on HEAD not on @{upstream}. 0 when no upstream / not a repo. */
  aheadCount: number;
};

/** Coarse status for a dirty path in the Changes panel. */
export type WorkingTreeChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "untracked";

/** One dirty path in the working tree (Changes list). */
export type WorkingTreeChange = {
  /** Repo-relative posix path (destination path for renames). */
  path: string;
  /** Source path when status is renamed/copied. */
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

/** Per-path before/after text for lined diff preview. */
export type WorkingTreePathDiff = {
  path: string;
  binary: boolean;
  /** Empty when untracked / added / missing at base. */
  before: string;
  /** Empty when deleted / missing on disk. */
  after: string;
  truncated: boolean;
};

/** Per-path working-tree line stats (Detail → Files). */
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
  /** "llm" when the draft was model-generated; "fallback" placeholder otherwise. */
  messageSource: "llm" | "fallback";
  stats: WorkingTreeStats;
};

export type CommitResult = {
  ok: true;
  hash: string;
  shortHash: string;
  message: string;
  subject: string;
  /** Which VCS produced this commit — drives UI wording (commit vs revision). */
  vcs?: "git" | "svn";
};
