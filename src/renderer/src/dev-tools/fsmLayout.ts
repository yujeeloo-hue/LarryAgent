/**
 * Pure FSM graph → horizontal layered layout with corridor-routed edges
 * for the DevTools FSM tab. Geometry only — no DOM.
 *
 * Routing contract (docs/plans/20260824-fsm-graph.md):
 * - Adjacent-layer forwards: bezier through the column gap (slot → slot).
 * - Skip-layer forwards: top bus — exit source LEFT edge, rise in the
 *   column-gap corridor, run along a lane above the node area, descend in
 *   the corridor left of the target column, enter target LEFT edge.
 * - Backs: bottom bus, mirrored (exit RIGHT edge … lane below … enter
 *   target LEFT edge).
 * - Crosses (same layer): bezier bulging into the gap right of the column.
 * - All vertical segments live in column gaps — never through stacked
 *   sibling nodes (Socratic Q1 corridor rule). Corridor slots stagger per
 *   gap; parallel edges merge; node-side endpoints distribute as slots;
 *   bus lanes pack by interval disjointness per side.
 */

export type FsmLayoutInputGraph = {
  mode?: string;
  entryNodeId: string;
  terminalNodeId: string;
  nodes: Array<{
    id: string;
    name?: string;
    selfLoop: boolean;
    actionTypes: string[];
  }>;
  edges: Array<{ from: string; to: string; type: string; when?: string }>;
};

export type FsmEdgeKind = "forward" | "back" | "cross" | "self";

export type Pt = { x: number; y: number };

export type FsmEdgeGeom =
  | { type: "poly"; pts: Pt[] }
  | { type: "bezier"; p0: Pt; c1: Pt; c2: Pt; p1: Pt }
  | { type: "self"; p0: Pt; c1: Pt; c2: Pt; p1: Pt };

export type FsmLayoutNode = {
  id: string;
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
};

export type FsmLayoutEdge = {
  from: string;
  to: string;
  kind: FsmEdgeKind;
  when?: string;
  /** Bus channel index (skip-forward: top lanes, back: bottom lanes). */
  lane?: number;
  /** Which bus side carries this edge (skip-forward / back only). */
  busSide?: "top" | "bottom";
  /** Structured geometry (test-friendly sampling). */
  geom: FsmEdgeGeom;
  /** SVG path data, translated and filleted. */
  path: string;
};

export type FsmLayout = {
  nodes: FsmLayoutNode[];
  edges: FsmLayoutEdge[];
  width: number;
  height: number;
};

export const FSM_NODE_W = 164;
export const FSM_NODE_H = 46;
export const FSM_GAP_X = 96;
export const FSM_GAP_Y = 26;
export const FSM_PADDING = 28;
export const FSM_LANE_SPACING = 18;

const FSM_FILLET = 8;
const FSM_SELF_BAND = 30;
const FSM_TOP_INSET = 10;
const FSM_BOTTOM_INSET = 14;
const FSM_SELF_ARC_H = 24;

type MergedEdge = {
  key: string;
  from: string;
  to: string;
  whens: string[];
  kind: FsmEdgeKind;
  dl: number;
};

const fmt = (n: number): string => String(Math.round(n * 10) / 10);

/**
 * Epsilon path segment along the end tangent of an edge `d` string, for
 * hanging an `marker-end` arrowhead as the topmost painted element
 * (zero-length paths don't render markers). Supports the editor's cubic
 * beziers (`M … C a b, c d, x y`) and corridor polylines (`… L x y`):
 * the last two coordinate pairs always straddle the end tangent.
 * Coordinates keep full precision (no fmt rounding — the sub-pixel offset
 * would vanish at 0.1 precision). Returns null when path has < 2 points.
 */
export function edgeArrowSegment(d: string, len = 0.01): string | null {
  const nums = d.match(/-?[\d.]+/g);
  if (!nums || nums.length < 4) return null;
  const endX = Number(nums[nums.length - 2]);
  const endY = Number(nums[nums.length - 1]);
  const prevX = Number(nums[nums.length - 4]);
  const prevY = Number(nums[nums.length - 3]);
  if (![endX, endY, prevX, prevY].every(Number.isFinite)) return null;
  let dx = endX - prevX;
  let dy = endY - prevY;
  const hyp = Math.hypot(dx, dy);
  if (hyp < 1e-6) {
    dx = 1;
    dy = 0;
  } else {
    dx /= hyp;
    dy /= hyp;
  }
  return `M ${endX - dx * len} ${endY - dy * len} L ${endX} ${endY}`;
}

function roundedOrthoPath(pts: Pt[], r: number): string {
  const p = pts.filter(
    (q, i) =>
      i === 0 ||
      Math.abs(q.x - pts[i - 1]!.x) > 0.01 ||
      Math.abs(q.y - pts[i - 1]!.y) > 0.01,
  );
  if (p.length < 2) return "";
  let d = `M ${fmt(p[0]!.x)} ${fmt(p[0]!.y)}`;
  for (let i = 1; i < p.length - 1; i += 1) {
    const prev = p[i - 1]!;
    const cur = p[i]!;
    const next = p[i + 1]!;
    const len1 = Math.hypot(cur.x - prev.x, cur.y - prev.y);
    const len2 = Math.hypot(next.x - cur.x, next.y - cur.y);
    const rr = Math.min(r, len1 / 2, len2 / 2);
    const d1 = { x: (cur.x - prev.x) / len1, y: (cur.y - prev.y) / len1 };
    const d2 = { x: (next.x - cur.x) / len2, y: (next.y - cur.y) / len2 };
    const a = { x: cur.x - d1.x * rr, y: cur.y - d1.y * rr };
    const b = { x: cur.x + d2.x * rr, y: cur.y + d2.y * rr };
    d += ` L ${fmt(a.x)} ${fmt(a.y)} Q ${fmt(cur.x)} ${fmt(cur.y)} ${fmt(b.x)} ${fmt(b.y)}`;
  }
  const last = p[p.length - 1]!;
  d += ` L ${fmt(last.x)} ${fmt(last.y)}`;
  return d;
}

function geomToPath(geom: FsmEdgeGeom): string {
  if (geom.type === "poly") return roundedOrthoPath(geom.pts, FSM_FILLET);
  return `M ${fmt(geom.p0.x)} ${fmt(geom.p0.y)} C ${fmt(geom.c1.x)} ${fmt(geom.c1.y)} ${fmt(geom.c2.x)} ${fmt(geom.c2.y)} ${fmt(geom.p1.x)} ${fmt(geom.p1.y)}`;
}

export function layoutFsmGraph(graph: FsmLayoutInputGraph): FsmLayout {
  const nodeIds = graph.nodes.map((node) => node.id);
  const idSet = new Set(nodeIds);

  // —— Merge parallel edges (same from→to): one curve, joined when-labels.
  const mergedMap = new Map<string, MergedEdge>();
  for (const edge of graph.edges) {
    if (!idSet.has(edge.from) || !idSet.has(edge.to)) continue;
    const key = `${edge.from}\u0000${edge.to}`;
    const m =
      mergedMap.get(key) ??
      ({ key, from: edge.from, to: edge.to, whens: [], kind: "forward", dl: 0 } as MergedEdge);
    if (edge.when) m.whens.push(edge.when);
    mergedMap.set(key, m);
  }

  // —— DFS from entry: reachable set + back edges (cycle breaking).
  const adj = new Map<string, string[]>();
  for (const m of mergedMap.values()) {
    if (m.from === m.to) continue;
    const list = adj.get(m.from) ?? [];
    list.push(m.to);
    adj.set(m.from, list);
  }
  const reachable = new Set<string>();
  const backKeys = new Set<string>();
  const onStack = new Set<string>();
  const visit = (id: string): void => {
    if (reachable.has(id)) return;
    reachable.add(id);
    onStack.add(id);
    for (const next of adj.get(id) ?? []) {
      if (onStack.has(next)) {
        backKeys.add(`${id}\u0000${next}`);
      } else if (!reachable.has(next)) {
        visit(next);
      }
    }
    onStack.delete(id);
  };
  visit(graph.entryNodeId);

  // —— Longest-path layering over the acyclic edge set.
  const layer = new Map<string, number>();
  for (const id of nodeIds) layer.set(id, 0);
  const relaxed: Array<[string, string]> = [];
  for (const m of mergedMap.values()) {
    if (m.from === m.to) continue;
    if (backKeys.has(m.key)) continue;
    if (!reachable.has(m.from)) continue;
    relaxed.push([m.from, m.to]);
  }
  for (let i = 0; i < nodeIds.length; i += 1) {
    let changed = false;
    for (const [u, v] of relaxed) {
      const next = (layer.get(u) ?? 0) + 1;
      if (next > (layer.get(v) ?? 0)) {
        layer.set(v, next);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // —— Terminal pinned to the rightmost layer.
  let maxLayer = 0;
  for (const id of nodeIds) maxLayer = Math.max(maxLayer, layer.get(id) ?? 0);
  if (idSet.has(graph.terminalNodeId)) layer.set(graph.terminalNodeId, maxLayer);

  // —— Classify edges (forward adjacency decided by layer distance).
  for (const m of mergedMap.values()) {
    const lu = layer.get(m.from) ?? 0;
    const lv = layer.get(m.to) ?? 0;
    m.dl = lv - lu;
    m.kind =
      m.from === m.to ? "self" : m.dl < 0 ? "back" : m.dl === 0 ? "cross" : "forward";
  }

  // —— Columns keep config order within a layer.
  const columns: string[][] = Array.from({ length: maxLayer + 1 }, () => []);
  for (const node of graph.nodes) {
    columns[Math.min(layer.get(node.id) ?? 0, maxLayer)]?.push(node.id);
  }
  const colOf = new Map<string, number>();
  const rowOf = new Map<string, number>();
  columns.forEach((col, l) =>
    col.forEach((id, idx) => {
      colOf.set(id, l);
      rowOf.set(id, idx);
    }),
  );
  const maxCol = columns.length - 1;
  const maxRows = Math.max(1, ...columns.map((c) => c.length));

  // —— Corridor slots: every vertical segment lands in a column gap;
  //    multiple verticals in one gap stagger across its width.
  const gapPop = new Map<number, string[]>();
  const pushGap = (g: number, sub: string): void => {
    const list = gapPop.get(g) ?? [];
    list.push(sub);
    gapPop.set(g, list);
  };
  for (const m of mergedMap.values()) {
    if (m.kind === "self") continue;
    const s = colOf.get(m.from) ?? 0;
    const t = colOf.get(m.to) ?? 0;
    if (m.kind === "cross") {
      pushGap(s + 1, `${m.key}:cx`);
      continue;
    }
    if (m.kind === "forward" && m.dl === 1) continue; // bezier, no vertical
    if (m.kind === "forward") {
      pushGap(s, `${m.key}:v1`);
      pushGap(t, `${m.key}:v2`);
    } else {
      pushGap(s + 1, `${m.key}:v1`);
      pushGap(t, `${m.key}:v2`);
    }
  }
  const gapLeftX = (g: number): number =>
    FSM_PADDING - FSM_GAP_X + g * (FSM_NODE_W + FSM_GAP_X);
  const slotX = new Map<string, number>();
  for (const [g, subs] of gapPop) {
    const sorted = [...subs].sort();
    sorted.forEach((sub, i) => {
      slotX.set(
        `${g}:${sub}`,
        gapLeftX(g) + (FSM_GAP_X * (i + 1)) / (sorted.length + 1),
      );
    });
  }

  // —— Bus lane packing: same side shares a lane only when x-intervals
  //    stay disjoint (longest spans claim outer lanes first).
  const laneOf = new Map<string, number>();
  const busEdges: MergedEdge[] = [...mergedMap.values()].filter(
    (m) => m.kind === "back" || (m.kind === "forward" && m.dl > 1),
  );
  const packSide = (list: MergedEdge[]): number => {
    const intervals = list.map((m) => {
      const s = colOf.get(m.from) ?? 0;
      const t = colOf.get(m.to) ?? 0;
      const x1 = slotX.get(`${m.kind === "back" ? s + 1 : s}:${m.key}:v1`) ?? 0;
      const x2 = slotX.get(`${t}:${m.key}:v2`) ?? 0;
      return { key: m.key, lo: Math.min(x1, x2), hi: Math.max(x1, x2) };
    });
    const sorted = [...intervals].sort(
      (a, b) => b.hi - b.lo - (a.hi - a.lo) || a.lo - b.lo,
    );
    const lanes: Array<Array<{ lo: number; hi: number }>> = [];
    for (const iv of sorted) {
      let idx = lanes.findIndex((lane) =>
        lane.every((o) => iv.lo > o.hi + 1 || iv.hi < o.lo - 1),
      );
      if (idx < 0) {
        lanes.push([]);
        idx = lanes.length - 1;
      }
      lanes[idx]!.push(iv);
      laneOf.set(iv.key, idx);
    }
    return lanes.length;
  };
  const topBus = busEdges.filter((m) => m.kind === "forward");
  const bottomBus = busEdges.filter((m) => m.kind === "back");
  const topLaneCount = packSide(topBus);
  const bottomLaneCount = packSide(bottomBus);

  // —— Vertical zones: top lanes / self-arc band / node rows / bottom lanes.
  const hasSelf = [...mergedMap.values()].some((m) => m.kind === "self");
  const nodeAreaTop =
    FSM_PADDING +
    topLaneCount * FSM_LANE_SPACING +
    (hasSelf ? FSM_SELF_BAND : FSM_TOP_INSET);
  const nodeAreaBottom =
    nodeAreaTop + maxRows * FSM_NODE_H + (maxRows - 1) * FSM_GAP_Y;
  const topLaneY = (k: number): number =>
    FSM_PADDING + k * FSM_LANE_SPACING + FSM_LANE_SPACING / 2;
  const bottomLaneY = (k: number): number =>
    nodeAreaBottom +
    FSM_BOTTOM_INSET +
    k * FSM_LANE_SPACING +
    FSM_LANE_SPACING / 2;
  const height =
    nodeAreaBottom +
    (bottomLaneCount > 0
      ? FSM_BOTTOM_INSET + bottomLaneCount * FSM_LANE_SPACING
      : 0) +
    FSM_PADDING;

  const nodes: FsmLayoutNode[] = graph.nodes.map((node) => {
    const l = Math.min(layer.get(node.id) ?? 0, maxCol);
    const idx = rowOf.get(node.id) ?? 0;
    return {
      id: node.id,
      layer: l,
      x: FSM_PADDING + l * (FSM_NODE_W + FSM_GAP_X),
      y: nodeAreaTop + idx * (FSM_NODE_H + FSM_GAP_Y),
      w: FSM_NODE_W,
      h: FSM_NODE_H,
    };
  });
  const nodeGeom = new Map(nodes.map((n) => [n.id, n]));
  const centerY = (id: string): number => {
    const n = nodeGeom.get(id);
    return n ? n.y + n.h / 2 : 0;
  };

  // —— Node-side slot distribution (right/left edges fan endpoints out).
  type Incident = { y: number; key: string };
  const leftInc = new Map<string, Incident[]>();
  const rightInc = new Map<string, Incident[]>();
  const addInc = (
    map: Map<string, Incident[]>,
    nodeId: string,
    key: string,
    y: number,
  ): void => {
    const list = map.get(nodeId) ?? [];
    list.push({ y, key });
    map.set(nodeId, list);
  };
  for (const m of mergedMap.values()) {
    if (m.kind === "self") continue;
    if (m.kind === "forward" && m.dl === 1) {
      addInc(rightInc, m.from, m.key, centerY(m.to));
      addInc(leftInc, m.to, m.key, centerY(m.from));
      continue;
    }
    if (m.kind === "cross") {
      addInc(rightInc, m.from, m.key, centerY(m.to));
      addInc(rightInc, m.to, m.key, centerY(m.from));
      continue;
    }
    if (m.kind === "forward") {
      // Skip-layer forward: exit LEFT edge, enter target LEFT edge.
      addInc(leftInc, m.from, m.key, centerY(m.to));
      addInc(leftInc, m.to, m.key, centerY(m.from));
      continue;
    }
    // Back: exit RIGHT edge, enter target LEFT edge.
    addInc(rightInc, m.from, m.key, centerY(m.to));
    addInc(leftInc, m.to, m.key, centerY(m.from));
  }
  const sideSlot = new Map<string, number>();
  const assignSide = (
    map: Map<string, Incident[]>,
    side: "L" | "R",
  ): void => {
    for (const [nodeId, list] of map) {
      const n = nodeGeom.get(nodeId);
      if (!n) continue;
      const sorted = [...list].sort(
        (a, b) => a.y - b.y || (a.key < b.key ? -1 : 1),
      );
      sorted.forEach((inc, i) => {
        sideSlot.set(
          `${nodeId}|${side}:${inc.key}`,
          n.y + (n.h * (i + 1)) / (sorted.length + 1),
        );
      });
    }
  };
  assignSide(leftInc, "L");
  assignSide(rightInc, "R");
  const slotY = (nodeId: string, side: "L" | "R", key: string): number =>
    sideSlot.get(`${nodeId}|${side}:${key}`) ??
    (nodeGeom.get(nodeId)?.y ?? 0) + FSM_NODE_H / 2;

  // —— Edge geometries.
  const geoms = new Map<string, FsmEdgeGeom>();
  for (const m of mergedMap.values()) {
    const from = nodeGeom.get(m.from);
    const to = nodeGeom.get(m.to);
    if (!from || !to) continue;

    if (m.kind === "self") {
      const cx = from.x + from.w / 2;
      geoms.set(m.key, {
        type: "self",
        p0: { x: cx - 14, y: from.y },
        c1: { x: cx - 14, y: from.y - FSM_SELF_ARC_H },
        c2: { x: cx + 14, y: from.y - FSM_SELF_ARC_H },
        p1: { x: cx + 14, y: from.y },
      });
      continue;
    }

    if (m.kind === "cross") {
      const s = colOf.get(m.from) ?? 0;
      const gmx = slotX.get(`${s + 1}:${m.key}:cx`) ?? 0;
      const y1 = slotY(m.from, "R", m.key);
      const y2 = slotY(m.to, "R", m.key);
      geoms.set(m.key, {
        type: "bezier",
        p0: { x: from.x + from.w, y: y1 },
        c1: { x: gmx, y: y1 },
        c2: { x: gmx, y: y2 },
        p1: { x: to.x + to.w, y: y2 },
      });
      continue;
    }

    if (m.kind === "forward" && m.dl === 1) {
      const y1 = slotY(m.from, "R", m.key);
      const y2 = slotY(m.to, "L", m.key);
      const x1 = from.x + from.w;
      const x2 = to.x;
      const mid = (x2 - x1) / 2;
      geoms.set(m.key, {
        type: "bezier",
        p0: { x: x1, y: y1 },
        c1: { x: x1 + mid, y: y1 },
        c2: { x: x2 - mid, y: y2 },
        p1: { x: x2, y: y2 },
      });
      continue;
    }

    // Bus edges (skip-layer forward on top, back on bottom).
    const s = colOf.get(m.from) ?? 0;
    const t = colOf.get(m.to) ?? 0;
    const v1x =
      slotX.get(`${m.kind === "back" ? s + 1 : s}:${m.key}:v1`) ?? 0;
    const v2x = slotX.get(`${t}:${m.key}:v2`) ?? 0;
    const lane = laneOf.get(m.key) ?? 0;
    const ly = m.kind === "back" ? bottomLaneY(lane) : topLaneY(lane);
    const sy = slotY(m.from, m.kind === "back" ? "R" : "L", m.key);
    const ty = slotY(m.to, "L", m.key);
    const sx = m.kind === "back" ? from.x + from.w : from.x;
    geoms.set(m.key, {
      type: "poly",
      pts: [
        { x: sx, y: sy },
        { x: v1x, y: sy },
        { x: v1x, y: ly },
        { x: v2x, y: ly },
        { x: v2x, y: ty },
        { x: to.x, y: ty },
      ],
    });
  }

  // —— Normalize x: gap-0 corridors can reach negative x before shift.
  let minX = Infinity;
  let maxX = -Infinity;
  const trackX = (x: number): void => {
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
  };
  for (const n of nodes) {
    trackX(n.x);
    trackX(n.x + n.w);
  }
  for (const g of geoms.values()) {
    if (g.type === "poly") {
      for (const p of g.pts) trackX(p.x);
    } else {
      trackX(g.p0.x);
      trackX(g.p1.x);
      trackX(g.c1.x);
      trackX(g.c2.x);
    }
  }
  const dx = minX < FSM_PADDING ? FSM_PADDING - minX : 0;
  if (dx > 0) {
    for (const n of nodes) n.x += dx;
    for (const g of geoms.values()) {
      if (g.type === "poly") {
        for (const p of g.pts) p.x += dx;
      } else {
        g.p0.x += dx;
        g.p1.x += dx;
        g.c1.x += dx;
        g.c2.x += dx;
      }
    }
  }
  const width = maxX + dx + FSM_PADDING;

  const edges: Array<FsmLayoutEdge | null> = [...mergedMap.values()].map((m) => {
    const geom = geoms.get(m.key);
    if (!geom) return null;
    const lane = laneOf.get(m.key);
    const busSide: "top" | "bottom" | undefined =
      m.kind === "back" ? "bottom" : m.kind === "forward" && m.dl > 1 ? "top" : undefined;
    return {
      from: m.from,
      to: m.to,
      kind: m.kind,
      ...(m.whens.length > 0 ? { when: m.whens.join(" / ") } : {}),
      ...(lane !== undefined ? { lane } : {}),
      ...(busSide ? { busSide } : {}),
      geom,
      path: geomToPath(geom),
    };
  });
  const validEdges = edges.filter((e): e is FsmLayoutEdge => e !== null);

  return { nodes, edges: validEdges, width, height };
}

/** Uniform scale to fit a max canvas height (1 = no shrink needed). */
export function fitHeightScale(layout: FsmLayout, maxHeight: number): number {
  if (layout.height <= maxHeight || layout.height <= 0) return 1;
  return maxHeight / layout.height;
}

export type FsmCamera = { scale: number; panX: number; panY: number };

/**
 * Contain `layout` in the viewport (never scale up past 1) and center it.
 * `padding` is inset on each side when computing the fit scale; pan still
 * uses the full viewport so leftover space is equal left/right and top/bottom.
 */
export function fitGraphInViewport(
  layout: Pick<FsmLayout, "width" | "height">,
  viewport: { width: number; height: number },
  padding: number,
): FsmCamera | null {
  if (viewport.width <= 0 || viewport.height <= 0) return null;
  if (layout.width <= 0 || layout.height <= 0) return null;
  const innerW = Math.max(1, viewport.width - padding * 2);
  const innerH = Math.max(1, viewport.height - padding * 2);
  const scale = Math.min(1, innerW / layout.width, innerH / layout.height);
  return {
    scale,
    panX: (viewport.width - layout.width * scale) / 2,
    panY: (viewport.height - layout.height * scale) / 2,
  };
}
