/**
 * Parallel FSM foundations — isolated from live JellyBot turn path.
 */

import type { RunAgentTurnInput } from "../types.js";
import type { FSMGraphConfigVersion } from "./constants.js";
import { FSM_GRAPH_CONFIG_VERSION } from "./constants.js";
import type { FsmHostCapabilities } from "./FsmHostCapabilities.js";

/** Turn-scoped control / routing context for one FSMGraph.run. */
export type TurnContext = Record<string, unknown>;

/** Fresh per Node entry — working context for that Node’s Actions. */
export type NodeContext = Record<string, unknown>;

/**
 * Injected Exec arguments. Actions must not hold Node / FSMGraph back-pointers.
 * Topology-blind contract for routing: Actions write `routeTarget` = a
 * **pin.name** selected via params (never invent a separate semantic
 * vocabulary). Built-in graphs set pin.name === target node id so wires stay
 * readable. See `docs/fsm-pins.md`.
 * `host` / `turnInput` are optional — absent → stub Action path (Step 3 tests).
 * `nodeId` is visit identity only (once-per-node guards / diagnostics) — never
 * use it to choose the next pin or node.
 */
export type NodeActionExecArgs = {
  turnContext: TurnContext;
  nodeContext: NodeContext;
  /** Real TurnHost (or mock) for Step 4+ capability Actions. */
  host?: FsmHostCapabilities;
  /** Required for Host-backed StartTurn. */
  turnInput?: RunAgentTurnInput;
  /**
   * Current FSM node id for this visit. Visit-scoped only — not for routing.
   */
  nodeId?: string;
};

export type NodeActionExecStatus = "continue" | "halt";

/**
 * Result of NodeActionBase.Exec.
 * Node merges patches; `halt` stops the Action list (and the graph run).
 */
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

/** Injected Eval arguments — read-only intent; returns boolean only. */
export type EdgeEvalArgs = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  turnContext: TurnContext;
  nodeContext: NodeContext;
  /**
   * Host session snapshot for EdgeWhen `source: "session"` (phase / plan
   * incompleteness). Omitted on hostless stub runs — session edges then miss.
   */
  session?: {
    phase?: string | null;
    plan?: import("../../session/types.js").SessionPlan | null;
  };
};

/** Serializable Action entry on a Node. */
export type NodeActionConfig = {
  /** Must match a registered NodeActionXXX type id. */
  type: string;
  /** Action-specific params; validated by the registry, including described children. */
  params?: Record<string, unknown>;
};

/** Outbound pin on a Node — reference key is `name` (unique per node). */
export type FSMGraphPinConfig = {
  name: string;
};

/** Serializable Node entry. */
export type FSMGraphNodeConfig = {
  id: string;
  name?: string;
  /**
   * Graph-owned outbound pins. Routing Actions only select these names via
   * fixed callback slots (`x-ui: "pin-select"`). See `docs/fsm-pins.md`.
   */
  pins?: FSMGraphPinConfig[];
  actions?: NodeActionConfig[];
  /**
   * Checkbox self-loop fallback: when true, a routing pass with **zero**
   * matching outgoing edges stays on this node instead of erroring.
   * Exactly 1 match still takes the edge; >1 matches still error — the
   * flag only replaces explicit from===to edges, never adds ambiguity.
   * Do not draw a self-edge for this; use the flag only.
   */
  selfLoop?: boolean;
};

/** Params for built-in EdgeAlways — must be omitted or empty. */
export type EdgeAlwaysParams = Record<string, never>;

/** Params for built-in EdgeWhen. */
export type EdgeWhenParams = {
  /** Context key (or session field name when source is session). */
  turnKey: string;
  equals?: unknown;
  /**
   * Which store to read `turnKey` from. Default `"turn"`.
   * `"node"` — round-scoped nodeContext (routeTarget, …).
   * `"session"` — Host session fields (`phase`, …).
   */
  source?: "turn" | "node" | "session";
  /**
   * When set, the edge is false if `nodeContext[unlessNodeKey]` is a
   * non-empty string (e.g. skip phase-resume edges when Approve already
   * wrote routeTarget).
   */
  unlessNodeKey?: string;
  /**
   * When true (typically with source=session + phase), also require an
   * active plan with open steps — used for executing→executor resume.
   */
  requireIncompletePlan?: boolean;
  /**
   * Typed comparison (mutually exclusive with `equals` — validated at
   * authoring time). When `type`/`operator`/`value` are present, the shared
   * comparator (compareValues.ts) replaces strict equality; `source`
   * semantics are unchanged.
   */
  type?: "int" | "float" | "string";
  operator?: string;
  value?: unknown;
};

type EdgeConfigBase = {
  id?: string;
  from: string;
  to: string;
};

/** Built-in plain route. */
export type FSMGraphEdgeAlwaysConfig = EdgeConfigBase & {
  type: "EdgeAlways";
  params?: EdgeAlwaysParams;
};

/** Built-in turnContext equality condition. */
export type FSMGraphEdgeWhenConfig = EdgeConfigBase & {
  type: "EdgeWhen";
  params: EdgeWhenParams;
};

/**
 * Extension / future edge types — params opaque until that type’s factory validates.
 */
export type FSMGraphEdgeExtensionConfig = EdgeConfigBase & {
  type: string;
  params?: Record<string, unknown>;
};

/**
 * Serializable Edge entry (discriminated for built-ins; open for extensions).
 */
export type FSMGraphEdgeConfig =
  | FSMGraphEdgeAlwaysConfig
  | FSMGraphEdgeWhenConfig
  | FSMGraphEdgeExtensionConfig;

/**
 * Current serializable graph description — primary input to FSMGraph.run.
 */
export type FSMGraphConfig = {
  /** Schema version; must be {@link FSM_GRAPH_CONFIG_VERSION}. */
  version: FSMGraphConfigVersion;
  /** Optional diagnostic label (migration tests, logs). Unused by the runtime. */
  id?: string;
  entryNodeId: string;
  /**
   * Terminal node id. When omitted, defaults to `"end"`.
   * Normal completion requires reaching this node.
   */
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

/** Helper to build a current config without repeating the version literal. */
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
