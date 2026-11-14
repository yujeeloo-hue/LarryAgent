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

/** Who authored a library graph. */
export type FsmGraphOrigin = "user" | "llm";

/**
 * Graph identity color (hex `#rrggbb`) shown on the focused composer border
 * while the graph is the selected run mode. Absent → renderer default
 * (violet).
 */
export type FsmGraphColor = string;

/** Fixed palette for builtin modes + fresh graphs (renderer mirrors these). */
export const FSM_GRAPH_COLORS = {
  ask: "#4c9dff",
  planExecute: "#f5a623",
  /** Default for blank graphs / graphs without a stored color. */
  default: "#a78bfa",
} as const;

/** Fork-of-builtin seed color: colored modes keep theirs, others default. */
export function forkColorForMode(mode: BuiltinGraphMode): FsmGraphColor {
  if (mode === "ask") return FSM_GRAPH_COLORS.ask;
  if (mode === "plan_execute") return FSM_GRAPH_COLORS.planExecute;
  return FSM_GRAPH_COLORS.default;
}

/** Normalize a stored/supplied color to lowercase `#rrggbb`, or undefined. */
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
  /** Disabled graphs stay in the library but are not selectable as custom graphs. */
  enabled: boolean;
  /** Identity color `#rrggbb` (absent → default violet). */
  color?: FsmGraphColor;
};

export type FsmGraphLibraryRecord = {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt: number;
  config: FSMGraphConfig;
  /** Author: "user" (Graphs editor / UI) or "llm" (fsm_graph tool). */
  origin: FsmGraphOrigin;
  /** Only the user can flip this (UI enable/disable); tools persist it unchanged. */
  enabled: boolean;
  /** Identity color `#rrggbb` (absent → default violet in the composer). */
  color?: FsmGraphColor;
  /** Editor-only node positions (persisted with the graph). */
  nodeLayout?: Record<string, FsmGraphNodeLayout>;
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
