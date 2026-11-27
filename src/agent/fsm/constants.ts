export const FSM_GRAPH_CONFIG_VERSION = 2 as const;

export type FSMGraphConfigVersion = typeof FSM_GRAPH_CONFIG_VERSION;

export const DEFAULT_TERMINAL_NODE_ID = "end";

export const EDGE_TYPE_ALWAYS = "EdgeAlways" as const;
export const EDGE_TYPE_WHEN = "EdgeWhen" as const;

export const NODE_START = "start";
export const NODE_END = "end";
export const NODE_SKILL_REFLECT_GATE = "skill_reflect_gate";
export const NODE_SKILL_REFLECTOR = "skill_reflector";
export const NODE_EXECUTION_VALIDATOR = "execution_validator";

