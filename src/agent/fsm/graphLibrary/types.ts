import type { FSMGraphConfig } from "../types.js";
import { graphConfigForMode } from "../FsmGraphWorkflow.js";

export type FsmGraphNodeLayout = {
  x: number;
  y: number;
};

export type BuiltinGraphMode =
  | "react"
  | "react_v2"
  | "ask"
  | "plan_execute"
  | "subagent";

export type FsmGraphOrigin = "user" | "llm";

export type FsmGraphColor = string;

export const FSM_GRAPH_COLORS = {
  ask: "#4c9dff",
  planExecute: "#f5a623",
  default: "#a78bfa",
} as const;

export function forkColorForMode(mode: BuiltinGraphMode): FsmGraphColor {
  if (mode === "ask") return FSM_GRAPH_COLORS.ask;
  if (mode === "plan_execute") return FSM_GRAPH_COLORS.planExecute;
  return FSM_GRAPH_COLORS.default;
}

export function normalizeFsmGraphColor(value: unknown): FsmGraphColor | undefined {
  if (typeof value !== "string") return undefined;
  const hex = value.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(hex) ? hex : undefined;
}

export type FsmGraphLibraryEntry = {
  id: string;
  name: string;
  updatedAt: number;
  origin: FsmGraphOrigin;
  enabled: boolean;
  validation?: import("../authoring/diagnostics.js").GraphValidation;
  draftContextId?: string;
  color?: FsmGraphColor;
};

export type FsmGraphLibraryRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  config: FSMGraphConfig;
  origin: FsmGraphOrigin;
  enabled: boolean;
  color?: FsmGraphColor;
  nodeLayout?: Record<string, FsmGraphNodeLayout>;
  validation?: import("../authoring/diagnostics.js").GraphValidation;
  draftContextId?: string;
  draftRevision?: number;
};

export type FsmBuiltinTemplate = {
  mode: BuiltinGraphMode;
  label: string;
  description: string;
};

export const FSM_BUILTIN_TEMPLATES: readonly FsmBuiltinTemplate[] = [
  {
    mode: "react",
    label: "Auto",
    description: "Works through tasks by reasoning, using tools, and checking results until the work is done.",
  },
  {
    mode: "react_v2",
    label: "Auto V2",
    description: "Previews substantial UI changes for your approval before implementation. Other tasks go straight to execution.",
  },
  {
    mode: "ask",
    label: "Ask",
    description: "Reads and searches to answer questions, explain code, and explore ideas without changing your workspace.",
  },
  {
    mode: "plan_execute",
    label: "Plan",
    description: "Drafts and reviews a plan, waits for your approval, then executes and checks the work step by step.",
  },
  {
    mode: "subagent",
    label: "Subagent",
    description: "Runs a delegated task as a child agent and returns the result. Child agents cannot delegate further.",
  },
] as const;

export type FsmActionCatalogEntry = {
  type: string;
  title?: string;
  description?: string;
  paramsSchema: Record<string, unknown>;
};
