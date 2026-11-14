import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SkillManager } from "./manager.js";
import {
  applySkillProposalPayload,
  createSkillProposal,
  type SkillProposalPayload,
} from "./proposals.js";
import { similarityClusters, skillSimilarityText } from "./similarity.js";
import { normalizeSkillProject } from "./projectScope.js";
import { isValidSkillName, normalizeSkillName } from "./toolHelpers.js";
import { AUTO_EDITABLE_ORIGINS, type SkillRecord } from "./types.js";
import type { SkillUsageRow, SkillUsageStatsRow } from "./usage.js";

/**
 * Library-level skill curation (docs/plans/20261108-skill-self-improvement.md
 * phase 4). Triggers and preselection are deterministic; one LLM judgment per
 * preselected item; writes go through the same snapshot / proposal paths as
 * the reflector (actor `reflector`, policy auto_owned_only).
 */

export const CURATION_COOLDOWN_MS = 24 * 60 * 60 * 1000;
export const CURATION_AUTO_WRITES_TRIGGER = 5;
export const CURATION_LIBRARY_SIZE_TRIGGER = 30;
export const CURATION_POOR_WINDOW = 10;
export const CURATION_POOR_MIN_FINISHED = 3;
export const CURATION_POOR_RATE = 0.5;
export const CURATION_STALE_MS = 60 * 24 * 60 * 60 * 1000;
export const CURATION_PER_SKILL_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const CURATION_MAX_ITEMS = 5;
export const CURATION_CLUSTER_THRESHOLD = 0.45;
export const CURATION_REASON_PREFIX = "[curation]";
const STATE_FILE = ".curation.json";

export type CurationDecision = {
  action: "merge" | "patch" | "deprecate" | "keep";
  target?: string;
  description?: string;
  body?: string;
  superseded_by?: string;
  reason: string;
};

export type CurationItem =
  | { kind: "cluster"; skillIds: string[] }
  | { kind: "stale"; skillIds: [string]; lastUsedAt: number }
  | {
      kind: "poor";
      skillIds: [string];
      uses: number;
      successRate: number;
      failures: string[];
    };

export type CurationItemResult = {
  kind: CurationItem["kind"];
  skills: string[];
  decision: CurationDecision["action"] | "error";
  applied: boolean;
  proposalId?: string;
  reason: string;
};

export type CurationResult = {
  at: number;
  trigger: string;
  items: CurationItemResult[];
  error?: string;
};

export type CurationState = {
  lastRunAt?: number;
  /** Reflector / CoCo skill writes since the last run (curation's own excluded). */
  autoWritesSinceRun: number;
  /** skillId → last time curation changed it. */
  touched: Record<string, number>;
  lastResult?: CurationResult;
};

export const CURATION_DECISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: { type: "string", enum: ["merge", "patch", "deprecate", "keep"] },
    target: { type: "string" },
    description: { type: "string" },
    body: { type: "string" },
    superseded_by: { type: "string" },
    reason: { type: "string" },
  },
  required: ["action", "reason"],
} as const;

// ---- state -----------------------------------------------------------------

export async function loadCurationState(skillsRoot: string): Promise<CurationState> {
  try {
    const raw = JSON.parse(await readFile(join(skillsRoot, STATE_FILE), "utf8")) as Partial<CurationState>;
    return {
      ...(typeof raw.lastRunAt === "number" ? { lastRunAt: raw.lastRunAt } : {}),
      autoWritesSinceRun: typeof raw.autoWritesSinceRun === "number" ? raw.autoWritesSinceRun : 0,
      touched: raw.touched && typeof raw.touched === "object" ? raw.touched : {},
      ...(raw.lastResult ? { lastResult: raw.lastResult } : {}),
    };
  } catch {
    return { autoWritesSinceRun: 0, touched: {} };
  }
}

export async function saveCurationState(skillsRoot: string, state: CurationState): Promise<void> {
  await mkdir(skillsRoot, { recursive: true });
  const target = join(skillsRoot, STATE_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

// ---- triggers --------------------------------------------------------------

function successRate(rows: SkillUsageRow[]): { finished: number; rate: number } {
  const finished = rows.filter((r) => r.outcome !== undefined);
  const ok = finished.filter((r) => r.outcome === "idle" && (r.errorsAfter ?? 0) === 0).length;
  return { finished: finished.length, rate: finished.length > 0 ? ok / finished.length : 1 };
}

/** Why curation should run now, or null. */
export function curationTrigger(input: {
  state: CurationState;
  now: number;
  enabled: boolean;
  records: SkillRecord[];
  recentUsage: (skillId: string) => SkillUsageRow[];
}): string | null {
  if (!input.enabled) return null;
  const last = input.state.lastRunAt;
  if (last !== undefined && input.now - last < CURATION_COOLDOWN_MS) return null;
  if (input.state.autoWritesSinceRun >= CURATION_AUTO_WRITES_TRIGGER) return "auto_writes";
  const active = input.records.filter((r) => r.enabled && r.status === "active");
  if (
    active.length >= CURATION_LIBRARY_SIZE_TRIGGER &&
    active.some((r) => (r.createdAt ?? 0) > (last ?? 0))
  ) {
    return "library_size";
  }
  for (const r of active) {
    const { finished, rate } = successRate(input.recentUsage(r.id).slice(0, CURATION_POOR_WINDOW));
    if (finished >= CURATION_POOR_MIN_FINISHED && rate < CURATION_POOR_RATE) return "poor_skill";
  }
  return null;
}

// ---- preselection ----------------------------------------------------------

function failureLine(row: SkillUsageRow): string {
  const parts = [`outcome ${row.outcome ?? "running"}`];
  if (row.errorsAfter) parts.push(`${row.errorsAfter} tool error(s) after reading`);
  if (row.userSteered) parts.push("user corrected the agent");
  return `${new Date(row.readAt).toISOString().slice(0, 10)}: ${parts.join(", ")}`;
}

export function preselectCurationItems(input: {
  records: SkillRecord[];
  stats: SkillUsageStatsRow[];
  recentUsage: (skillId: string) => SkillUsageRow[];
  openReads: ReadonlySet<string>;
  touched: Record<string, number>;
  now: number;
}): CurationItem[] {
  const statsById = new Map(input.stats.map((s) => [s.skillId, s]));
  const eligible = (r: SkillRecord): boolean =>
    !input.openReads.has(r.id) &&
    !(input.touched[r.id] !== undefined && input.now - input.touched[r.id]! < CURATION_PER_SKILL_COOLDOWN_MS);
  const active = input.records.filter((r) => r.enabled && r.status === "active");
  const items: CurationItem[] = [];
  const claimed = new Set<string>();
  const push = (item: CurationItem): void => {
    if (items.length >= CURATION_MAX_ITEMS) return;
    if (item.skillIds.some((id) => claimed.has(id))) return;
    item.skillIds.forEach((id) => claimed.add(id));
    items.push(item);
  };

  for (const r of active.filter(eligible)) {
    const recent = input.recentUsage(r.id).slice(0, CURATION_POOR_WINDOW);
    const { finished, rate } = successRate(recent);
    if (finished < CURATION_POOR_MIN_FINISHED || rate >= CURATION_POOR_RATE) continue;
    const failures = recent
      .filter((row) => row.outcome !== undefined && (row.outcome !== "idle" || (row.errorsAfter ?? 0) > 0))
      .slice(0, 3)
      .map(failureLine);
    push({
      kind: "poor",
      skillIds: [r.id],
      uses: statsById.get(r.id)?.uses ?? recent.length,
      successRate: rate,
      failures,
    });
  }

  const pool = active.filter(eligible);
  // Clusters stay inside one project scope: merging a JellyBot skill into a
  // universal one would silently change where the survivor is listed.
  const byScope = new Map<string, SkillRecord[]>();
  for (const record of pool) {
    const key = normalizeSkillProject(record.project);
    const bucket = byScope.get(key);
    if (bucket) bucket.push(record);
    else byScope.set(key, [record]);
  }
  for (const bucket of byScope.values()) {
    for (const cluster of similarityClusters(
      bucket.map((r) => ({ id: r.id, text: skillSimilarityText(r) })),
      CURATION_CLUSTER_THRESHOLD,
      4,
    )) {
      push({ kind: "cluster", skillIds: cluster });
    }
  }

  for (const r of pool) {
    if (!AUTO_EDITABLE_ORIGINS.includes(r.origin)) continue;
    const lastUsedAt = statsById.get(r.id)?.lastUsedAt || r.createdAt;
    if (lastUsedAt === undefined || input.now - lastUsedAt < CURATION_STALE_MS) continue;
    push({ kind: "stale", skillIds: [r.id], lastUsedAt });
  }
  return items;
}

// ---- judgment input --------------------------------------------------------

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…(clipped)`;
}

export function curationItemPrompt(
  item: CurationItem,
  records: Map<string, SkillRecord>,
  stats: Map<string, SkillUsageStatsRow>,
  now: number,
): string {
  const header =
    item.kind === "cluster"
      ? "Case: these skills look similar. Merge, keep, or deprecate redundant ones."
      : item.kind === "stale"
        ? `Case: this automatically created skill has not been used for ${Math.floor((now - item.lastUsedAt) / 86_400_000)} days.`
        : `Case: this skill's recent uses mostly went wrong (${Math.round(item.successRate * 100)}% clean over the last uses).`;
  const lines = [header, ""];
  for (const id of item.skillIds) {
    const r = records.get(id);
    if (!r) continue;
    const s = stats.get(id);
    lines.push(
      `## ${r.name}`,
      `origin: ${r.origin} · project: ${r.project ?? "universal"} · revision ${r.revision} · uses: ${s?.uses ?? 0}${s && s.finished > 0 ? ` · clean: ${Math.round((s.successes / s.finished) * 100)}%` : ""}`,
      `description: ${r.description}`,
      "",
      clip(r.body, 4000),
      "",
    );
  }
  if (item.kind === "poor" && item.failures.length > 0) {
    lines.push("Recent failed uses:", ...item.failures.map((f) => `- ${f}`));
  }
  return lines.join("\n");
}

export function parseCurationDecision(text: string): CurationDecision | null {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (!["merge", "patch", "deprecate", "keep"].includes(String(r.action))) return null;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
  const decision: CurationDecision = {
    action: r.action as CurationDecision["action"],
    reason: str(r.reason)?.trim().slice(0, 300) ?? "(no reason given)",
  };
  for (const key of ["target", "description", "body", "superseded_by"] as const) {
    const v = str(r[key]);
    if (v !== undefined) decision[key] = v;
  }
  return decision;
}

// ---- apply -----------------------------------------------------------------

function byName(records: SkillRecord[], ref: string | undefined): SkillRecord | undefined {
  if (!ref) return undefined;
  const needle = normalizeSkillName(ref);
  return records.find((r) => r.id === ref || r.name === needle);
}

/** Map a decision to a proposal payload over the item's skills; null = nothing to do / invalid. */
export function decisionPayload(
  decision: CurationDecision,
  itemSkills: SkillRecord[],
  allRecords: SkillRecord[],
): { payload: SkillProposalPayload; targets: SkillRecord[] } | { error: string } | null {
  if (decision.action === "keep") return null;
  if (decision.action === "deprecate") {
    const target = byName(itemSkills, decision.target) ?? (itemSkills.length === 1 ? itemSkills[0] : undefined);
    if (!target) return { error: "deprecate needs a target from the case" };
    const successor = byName(allRecords, decision.superseded_by);
    return {
      payload: {
        kind: "deprecate",
        targetId: target.id,
        ...(successor && successor.id !== target.id ? { supersededBy: successor.id } : {}),
      },
      targets: [target],
    };
  }
  if (!decision.description?.trim() || !decision.body?.trim()) {
    return { error: `${decision.action} needs description and body` };
  }
  if (decision.action === "patch") {
    const target = byName(itemSkills, decision.target) ?? (itemSkills.length === 1 ? itemSkills[0] : undefined);
    if (!target) return { error: "patch needs a target from the case" };
    return {
      payload: {
        kind: "patch",
        targetId: target.id,
        name: target.name,
        description: decision.description,
        body: decision.body,
      },
      targets: [target],
    };
  }
  if (itemSkills.length < 2) return { error: "merge needs at least two skills" };
  const keep = byName(itemSkills, decision.target);
  const newName = keep ? keep.name : normalizeSkillName(decision.target ?? "");
  if (!keep && (!isValidSkillName(newName) || byName(allRecords, newName))) {
    return { error: "merge target must be one of the skills or a new unused slug" };
  }
  // The survivor stays in the scope of the skill being kept (or the item's
  // shared scope) — merging never re-homes a skill into another project.
  const project =
    keep?.project ?? itemSkills.find((r) => r.project)?.project ?? undefined;
  return {
    payload: {
      kind: "merge",
      ...(keep ? { targetId: keep.id } : {}),
      sourceIds: itemSkills.map((r) => r.id),
      name: newName,
      description: decision.description,
      body: decision.body,
      ...(project !== undefined ? { project } : {}),
    },
    targets: itemSkills,
  };
}

/**
 * Apply one decision: directly when every target is automatically owned,
 * otherwise as a pending proposal for the user.
 */
export async function applyCurationDecision(input: {
  item: CurationItem;
  decision: CurationDecision;
  manager: SkillManager;
}): Promise<CurationItemResult> {
  const all = input.manager.listRecords();
  const itemSkills = input.item.skillIds
    .map((id) => all.find((r) => r.id === id))
    .filter((r): r is SkillRecord => Boolean(r));
  const base = {
    kind: input.item.kind,
    skills: itemSkills.map((r) => r.name),
    reason: input.decision.reason,
  };
  const mapped = decisionPayload(input.decision, itemSkills, all);
  if (mapped === null) return { ...base, decision: "keep", applied: false };
  if ("error" in mapped) return { ...base, decision: "error", applied: false, reason: mapped.error };
  const reason = `${CURATION_REASON_PREFIX} ${input.decision.reason}`;
  if (mapped.targets.every((t) => AUTO_EDITABLE_ORIGINS.includes(t.origin))) {
    await applySkillProposalPayload(mapped.payload, input.manager, { actor: "reflector", reason });
    return { ...base, decision: input.decision.action, applied: true };
  }
  const proposal = await createSkillProposal({
    payload: mapped.payload,
    targets: mapped.targets,
    reason,
    actor: "reflector",
  });
  return { ...base, decision: input.decision.action, applied: false, proposalId: proposal.id };
}

/** One-line summary for logs, the Skills screen and the CoCo briefing. */
export function summarizeCurationResult(result: CurationResult): string {
  if (result.error) return `Skill library curation failed: ${result.error}`;
  const count = (action: string): number =>
    result.items.filter((i) => i.applied && i.decision === action).length;
  const suggestions = result.items.filter((i) => i.proposalId).length;
  const parts = [
    count("merge") ? `merged ${count("merge")}` : "",
    count("patch") ? `patched ${count("patch")}` : "",
    count("deprecate") ? `deprecated ${count("deprecate")}` : "",
    suggestions ? `${suggestions} suggestion(s)` : "",
  ].filter(Boolean);
  return parts.length > 0
    ? `Skill library curated: ${parts.join(", ")}.`
    : `Skill library reviewed: no changes (${result.items.length} case(s)).`;
}
