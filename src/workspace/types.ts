export type TimestampMs = number;

export type Workspace = {
  id: string;
  name: string;
  path: string;
  origin: "user" | "coco";
  createdAt: TimestampMs;
  updatedAt: TimestampMs;
};

export const COCO_HOME_WORKSPACE_ID = "coco-home";


export type CreateWorkspaceInput = {
  name: string;
  path: string;
};

export type UpdateWorkspaceInput = {
  id: string;
  name?: string;
  path?: string;
};
