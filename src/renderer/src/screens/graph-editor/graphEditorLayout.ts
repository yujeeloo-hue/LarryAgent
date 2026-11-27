import {
  layoutFsmGraph,
  type FsmLayout,
  type FsmLayoutInputGraph,
} from "../../dev-tools/fsmLayout.js";
import { blueprintEdgePath } from "./wirePath.js";

export type NodeLayoutMap = Record<string, { x: number; y: number }>;

const PAD = 28;

export function layoutForEditor(
  graph: FsmLayoutInputGraph,
  nodeLayout: NodeLayoutMap | undefined,
): { layout: FsmLayout; nodeLayout: NodeLayoutMap } {
  const auto = layoutFsmGraph(graph);
  const positions: NodeLayoutMap = { ...(nodeLayout ?? {}) };

  for (const node of auto.nodes) {
    if (!positions[node.id]) {
      positions[node.id] = { x: node.x, y: node.y };
    }
  }

  if (!nodeLayout || Object.keys(nodeLayout).length === 0) {
    return { layout: auto, nodeLayout: positions };
  }

  const nodes = auto.nodes.map((node) => ({
    ...node,
    x: positions[node.id]!.x,
    y: positions[node.id]!.y,
  }));

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const edges = auto.edges.map((edge) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) return edge;
    return {
      ...edge,
      path: blueprintEdgePath(from, to),
    };
  });

  const width =
    nodes.length > 0
      ? Math.max(...nodes.map((node) => node.x + node.w)) + PAD
      : auto.width;
  const height =
    nodes.length > 0
      ? Math.max(...nodes.map((node) => node.y + node.h)) + PAD
      : auto.height;

  return {
    layout: { nodes, edges, width, height },
    nodeLayout: positions,
  };
}

export function dropNodeFromLayout(
  nodeLayout: NodeLayoutMap | undefined,
  nodeId: string,
): NodeLayoutMap | undefined {
  if (!nodeLayout || !(nodeId in nodeLayout)) return nodeLayout;
  const next = { ...nodeLayout };
  delete next[nodeId];
  return Object.keys(next).length > 0 ? next : undefined;
}
