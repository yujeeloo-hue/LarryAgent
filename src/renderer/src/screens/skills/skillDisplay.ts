import { buildHunkLineDiff } from "../conversation/cards/buildHunkDiff.js";
import type { DiffLine } from "../conversation/cards/diffTypes.js";

const ORIGIN_LABELS: Record<SkillOrigin, string> = {
  user: "User",
  installed: "Installed",
  agent: "Agent",
  reflector: "Auto",
  coco: "CoCo",
};

export function skillOriginLabel(origin: SkillOrigin | undefined): string {
  return ORIGIN_LABELS[origin ?? "user"] ?? "User";
}

export function skillTextDiff(before: string, after: string): DiffLine[] {
  if (before === after) return [];
  return buildHunkLineDiff(before, after);
}
