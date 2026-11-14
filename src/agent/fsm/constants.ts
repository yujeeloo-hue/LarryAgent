/** Current serializable FSMGraphConfig schema version. */
export const FSM_GRAPH_CONFIG_VERSION = 2 as const;

export type FSMGraphConfigVersion = typeof FSM_GRAPH_CONFIG_VERSION;

/** Default terminal Node id when `terminalNodeId` is omitted. */
export const DEFAULT_TERMINAL_NODE_ID = "end";

/** Built-in edge type ids. */
export const EDGE_TYPE_ALWAYS = "EdgeAlways" as const;
export const EDGE_TYPE_WHEN = "EdgeWhen" as const;

/** Shared node ids (graph configs + NodeActions). */
export const NODE_START = "start";
export const NODE_END = "end";
/** Pre-end eligibility gate before the reflect role node. */
export const NODE_SKILL_REFLECT_GATE = "skill_reflect_gate";
/** Skill-reflect role node (generic PrepareRole + overlay + RouteTo). */
export const NODE_SKILL_REFLECTOR = "skill_reflector";
/** V3: verify + commit_step collapse into this one. */
export const NODE_EXECUTION_VALIDATOR = "execution_validator";

