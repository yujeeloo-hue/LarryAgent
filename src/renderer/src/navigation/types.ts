export type AgentNavId =
  | "new-task"
  | "loop"
  | "search"
  | "tools"
  | "skills"
  | "graphs";

export type AgentNavItem = {
  id: AgentNavId;
  label: string;
};

export const AGENT_NAV_ITEMS: readonly AgentNavItem[] = [
  { id: "new-task", label: "New Task" },
  { id: "loop", label: "CoCo" },
  { id: "tools", label: "Tools" },
  { id: "skills", label: "Skills" },
  { id: "graphs", label: "Graphs" },
] as const;

export type SessionListItem = {
  id: string;
  title: string;
  updatedAt: number;
  status?: string;
  progressText?: string;
  type?: "agent";
  messageCount?: number;
  workspaceId?: string;
  archived?: boolean;
  archivedAt?: number | null;
  /** Origin marker; only non-'app' sources are exposed (loop/subagent). */
  source?: "app" | "subagent" | "loop" | "coco";
};

export type WorkspaceListItem = {
  id: string;
  name: string;
  path: string;
  /** Provenance; "coco" projects show the CoCo mark in the sidebar. */
  origin?: "user" | "coco";
  updatedAt: number;
};
