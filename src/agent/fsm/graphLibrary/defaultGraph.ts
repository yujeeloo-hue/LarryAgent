import { ROUTE_TARGET_REFLECT } from "../actions/NodeActionRouteTo.js";
import { NODE_END, NODE_START } from "../constants.js";
import { pinsFromNames } from "../pinRouting.js";
import { createFSMGraphConfig } from "../types.js";
import { rolePresetParams } from "../configs/rolePresets.js";

const AGENT_NODE_ID = "agent";

/**
 * Minimal valid blank graph for the editor:
 * Start → Agent (self-loop) + End stub. Users add nodes/pins/edges from here.
 */
export function createDefaultGraphConfig() {
  return createFSMGraphConfig({
    entryNodeId: NODE_START,
    terminalNodeId: NODE_END,
    nodes: [
      {
        id: NODE_START,
        name: "Start",
        actions: [{ type: "NodeActionStartTurn", params: {} }],
      },
      {
        id: AGENT_NODE_ID,
        name: "Agent",
        selfLoop: true,
        pins: pinsFromNames([AGENT_NODE_ID, ROUTE_TARGET_REFLECT]),
        actions: [
          { type: "NodeActionRoundGate", params: {} },
          {
            type: "NodeActionPrepareRole",
            params: rolePresetParams("agent"),
          },
          { type: "NodeActionPrepareTools", params: {} },
          { type: "NodeActionBuildModelWindow", params: {} },
          { type: "NodeActionCallModel", params: {} },
          { type: "NodeActionRunTools", params: {} },
          { type: "NodeActionApplyToolEffects", params: {} },
          { type: "NodeActionEmitRouteEvent", params: {} },
          { type: "NodeActionAwaitSubagents", params: {} },
          {
            type: "NodeActionRouteTo",
            params: {
              routes: [
                { event: "stay", to: AGENT_NODE_ID },
                { event: "leave", to: ROUTE_TARGET_REFLECT },
              ],
            },
          },
        ],
      },
      {
        id: NODE_END,
        name: "End",
        actions: [
          { type: "NodeActionFillEmptyAssistant", params: {} },
          { type: "NodeActionFinishIdle", params: {} },
        ],
      },
    ],
    edges: [{ from: NODE_START, to: AGENT_NODE_ID, type: "EdgeAlways" }],
  });
}
