
export type WirePoint = { x: number; y: number };
export type WireNodeBox = { x: number; y: number; w: number; h: number };

export type WireParams = {
  factor: number;
  minT: number;
  maxT: number;
  backFactor: number;
  backMin: number;
  sag: number;
  selfW: number;
  selfDrop: number;
};

export const WIRE_DEFAULTS: WireParams = {
  factor: 0.5,
  minT: 48,
  maxT: 220,
  backFactor: 0.75,
  backMin: 90,
  sag: 0.12,
  selfW: 0.55,
  selfDrop: 44,
};

export type WireGeom = {
  p0: WirePoint;
  c1: WirePoint;
  c2: WirePoint;
  p3: WirePoint;
};

export function outPin(node: WireNodeBox): WirePoint {
  return { x: node.x + node.w, y: node.y + node.h / 2 };
}

export function inPin(node: WireNodeBox): WirePoint {
  return { x: node.x, y: node.y + node.h / 2 };
}

export function blueprintWireGeom(
  p0: WirePoint,
  p3: WirePoint,
  params: WireParams = WIRE_DEFAULTS,
): WireGeom {
  const dx = p3.x - p0.x;
  const dy = p3.y - p0.y;
  let m = Math.min(params.maxT, Math.max(params.minT, Math.abs(dx) * params.factor));
  if (dx < 0) {
    m = Math.min(
      params.maxT * 1.6,
      Math.max(m, Math.abs(dy) * params.backFactor, params.backMin),
    );
  }
  const sag = dy > 0 ? dy * params.sag : 0;
  return {
    p0,
    c1: { x: p0.x + m, y: p0.y + sag },
    c2: { x: p3.x - m, y: p3.y + sag * 0.6 },
    p3,
  };
}

export function blueprintSelfLoopGeom(
  node: WireNodeBox,
  params: WireParams = WIRE_DEFAULTS,
): WireGeom {
  const p0 = outPin(node);
  const p3 = inPin(node);
  const mx = Math.max(params.minT, node.w * params.selfW);
  const drop = node.h / 2 + params.selfDrop;
  return {
    p0,
    c1: { x: p0.x + mx, y: p0.y + drop },
    c2: { x: p3.x - mx, y: p3.y + drop },
    p3,
  };
}

export function wireGeomToPath(geom: WireGeom): string {
  const { p0, c1, c2, p3 } = geom;
  return `M ${p0.x} ${p0.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${p3.x} ${p3.y}`;
}

export function blueprintEdgePath(
  from: WireNodeBox,
  to: WireNodeBox,
  params: WireParams = WIRE_DEFAULTS,
): string {
  if (from === to) return wireGeomToPath(blueprintSelfLoopGeom(from, params));
  return wireGeomToPath(blueprintWireGeom(outPin(from), inPin(to), params));
}

export function blueprintPreviewPath(
  from: WireNodeBox,
  cursor: WirePoint,
  params: WireParams = WIRE_DEFAULTS,
): string {
  return wireGeomToPath(blueprintWireGeom(outPin(from), cursor, params));
}
