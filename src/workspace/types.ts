/** Epoch milliseconds. */
export type TimestampMs = number;

/** First-class workspace: named folder binding for agent sessions. */
export type Workspace = {
  id: string;
  name: string;
  /** Absolute filesystem path used as the tool/session project root. */
  path: string;
  /** Who registered this workspace; "coco" rows are CoCo-created projects. */
  origin: "user" | "coco";
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
};

/**
 * Reserved row for Coco's private home (`{userData}/coco/`). Never listed as a
 * project; reachable only through `getWorkspace`.
 */
export const COCO_HOME_WORKSPACE_ID = "coco-home";

/**
 * Workspace archive visibility is derived from its sessions:
 * any unarchived session (or no sessions) → PROJECTS; any archived
 * session → Archived view. There is no workspace-level archive flag.
 */

export type CreateWorkspaceInput = {
  name: string;
  path: string;
};

export type UpdateWorkspaceInput = {
  id: string;
  name?: string;
  path?: string;
};
