
import type { RunAgentTurnInput } from "../types.js";
import type { FSMGraphConfigVersion } from "./constants.js";
import { FSM_GRAPH_CONFIG_VERSION } from "./constants.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";

export type TurnContext = Record<string, unknown>;

export type NodeContext = Record<string, unknown>;

export type NodeActionExecArgs = {
  turnContext: TurnContext;
  nodeContext: NodeContext;
  host?: FsmHostCapabilities;
  turnInput?: RunAgentTurnInput;
  nodeId?: string;
};

export type NodeActionExecStatus = "continue" | "halt";

export type NodeActionExecResult = {
  status: NodeActionExecStatus;
  turnContextPatch?: TurnContext;
  nodeContextPatch?: NodeContext;
  errorMessage?: string;
};

export type NodeRunStatus = "continue" | "halt";

export type NodeRunResult = {
  status: NodeRunStatus;
  turnContext: TurnContext;
  nodeContext: NodeContext;
  errorMessage?: string;
  actionsExecuted: number;
};

export type EdgeEvalArgs = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  turnContext: TurnContext;
  nodeContext: NodeContext;
  session?: {
    phase?: string | null;
    plan?: import("../../session/types.js").SessionPlan | null;
  };
};

export type NodeActionConfig = {
  type: string;
  params?: Record<string, unknown>;
};

export type FSMGraphPinConfig = {
  name: string;
};

export type FSMGraphNodeConfig = {
  id: string;
  name?: string;
  pins?: FSMGraphPinConfig[];
  actions?: NodeActionConfig[];
  selfLoop?: boolean;
};

export type EdgeAlwaysParams = Record<string, never>;

export type EdgeWhenParams = {
  turnKey: string;
  equals?: unknown;
  source?: "turn" | "node" | "session";
  unlessNodeKey?: string;
  requireIncompletePlan?: boolean;
  type?: "int" | "float" | "string";
  operator?: string;
  value?: unknown;
};

type EdgeConfigBase = {
  id?: string;
  from: string;
  to: string;
};

export type FSMGraphEdgeAlwaysConfig = EdgeConfigBase & {
  type: "EdgeAlways";
  params?: EdgeAlwaysParams;
};

export type FSMGraphEdgeWhenConfig = EdgeConfigBase & {
  type: "EdgeWhen";
  params: EdgeWhenParams;
};

export type FSMGraphEdgeExtensionConfig = EdgeConfigBase & {
  type: string;
  params?: Record<string, unknown>;
};

export type FSMGraphEdgeConfig =
  | FSMGraphEdgeAlwaysConfig
  | FSMGraphEdgeWhenConfig
  | FSMGraphEdgeExtensionConfig;

export type FSMGraphConfig = {
  version: FSMGraphConfigVersion;
  id?: string;
  entryNodeId: string;
  terminalNodeId?: string;
  nodes: FSMGraphNodeConfig[];
  edges: FSMGraphEdgeConfig[];
};

export type FSMGraphRunReason = "end_node" | "halt" | "error";

export type FSMGraphRunResult = {
  reason: FSMGraphRunReason;
  turnContext: TurnContext;
  currentNodeId: string;
  errorMessage?: string;
  nodesVisited: string[];
};

export function createFSMGraphConfig(
  partial: Omit<FSMGraphConfig, "version"> & {
    version?: FSMGraphConfigVersion;
  },
): FSMGraphConfig {
  return {
    version: partial.version ?? FSM_GRAPH_CONFIG_VERSION,
    entryNodeId: partial.entryNodeId,
    nodes: partial.nodes,
    edges: partial.edges,
    ...(partial.terminalNodeId !== undefined
      ? { terminalNodeId: partial.terminalNodeId }
      : {}),
  };
}
