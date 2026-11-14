import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { serializeSkillMarkdown } from "./parseSkillMd.js";
import type { SkillManager } from "./manager.js";
import type {
  SkillActor,
  SkillFileInput,
  SkillMutationContext,
  SkillRecord,
} from "./types.js";

/**
 * Pending skill edits an automatic writer was not allowed to apply
 * (`{skillsRoot}/.proposals/<id>.json`). The user accepts or rejects them in
 * the Skills screen; nothing is dropped silently.
 */

export const SKILL_PROPOSALS_DIR = ".proposals";
export const MAX_PENDING_PROPOSALS_PER_SKILL = 3;

export type SkillProposalKind = "patch" | "update" | "merge" | "deprecate";
export type SkillProposalStatus = "pending" | "accepted" | "rejected";

export type SkillContentPayload = {
  name: string;
  description: string;
  body: string;
  /** Project scope carried by a proposal (`""` = universal). */
  project?: string;
  files?: SkillFileInput[];
  removeFiles?: string[];
};

export type SkillProposalPayload =
  | ({ kind: "patch" | "update"; targetId: string } & SkillContentPayload)
  | ({ kind: "merge"; targetId?: string; sourceIds: string[] } & SkillContentPayload)
  | { kind: "deprecate"; targetId: string; supersededBy?: string };

export type SkillProposal = {
  id: string;
  kind: SkillProposalKind;
  status: SkillProposalStatus;
  /** Every skill the proposal would change. */
  targetIds: string[];
  /** Revision of each target when the proposal was made. */
  baseRevisions: Record<string, number>;
  payload: SkillProposalPayload;
  reason: string;
  actor: SkillActor;
  sessionId?: string;
  createdAt: number;
  resolvedAt?: number;
  resolution?: string;
};

export type SkillProposalChange = {
  skillId: string | null;
  name: string;
  before: string;
  after: string;
};

export type SkillProposalView = SkillProposal & {
  /** A target changed (or vanished) since the proposal was made. */
  stale: boolean;
  changes: SkillProposalChange[];
};

let root: string | null = null;
let chain: Promise<unknown> = Promise.resolve();

export function configureSkillProposalsRoot(skillsRoot: string | null): void {
  root = skillsRoot;
}

function dir(): string {
  if (!root) throw new Error("Skills root is not configured");
  return join(root, SKILL_PROPOSALS_DIR);
}

function locked<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.then(() => undefined, () => undefined);
  return run;
}

async function save(proposal: SkillProposal): Promise<void> {
  await mkdir(dir(), { recursive: true });
  const target = join(dir(), `${proposal.id}.json`);
  const temp = `${target}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(proposal, null, 2)}\n`, "utf8");
  await rename(temp, target);
}

async function loadAll(): Promise<SkillProposal[]> {
  let names: string[];
  try {
    names = await readdir(dir());
  } catch {
    return [];
  }
  const out: SkillProposal[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      out.push(JSON.parse(await readFile(join(dir(), name), "utf8")) as SkillProposal);
    } catch {
      // unreadable proposal; skip
    }
  }
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

export function listSkillProposals(filter?: {
  status?: SkillProposalStatus;
}): Promise<SkillProposal[]> {
  return locked(async () => {
    const all = await loadAll();
    return filter?.status ? all.filter((p) => p.status === filter.status) : all;
  });
}

/**
 * Store a pending proposal. When a target already has
 * {@link MAX_PENDING_PROPOSALS_PER_SKILL} pending ones, the oldest is
 * rejected (recorded, not deleted).
 */
export function createSkillProposal(input: {
  payload: SkillProposalPayload;
  targets: SkillRecord[];
  reason: string;
  actor: SkillActor;
  sessionId?: string;
  now?: number;
}): Promise<SkillProposal> {
  return locked(async () => {
    const now = input.now ?? Date.now();
    const proposal: SkillProposal = {
      id: randomUUID(),
      kind: input.payload.kind,
      status: "pending",
      targetIds: input.targets.map((t) => t.id),
      baseRevisions: Object.fromEntries(input.targets.map((t) => [t.id, t.revision])),
      payload: input.payload,
      reason: input.reason,
      actor: input.actor,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      createdAt: now,
    };
    const pending = (await loadAll()).filter((p) => p.status === "pending");
    for (const targetId of proposal.targetIds) {
      const forTarget = pending
        .filter((p) => p.status === "pending" && p.targetIds.includes(targetId))
        .sort((a, b) => a.createdAt - b.createdAt);
      while (forTarget.length >= MAX_PENDING_PROPOSALS_PER_SKILL) {
        const oldest = forTarget.shift()!;
        oldest.status = "rejected";
        oldest.resolvedAt = now;
        oldest.resolution = "Replaced by a newer suggestion";
        await save(oldest);
      }
    }
    await save(proposal);
    return proposal;
  });
}

function contentMd(c: {
  name: string;
  description: string;
  body: string;
  project?: string;
}): string {
  return serializeSkillMarkdown(c);
}

function recordMd(record: SkillRecord | null): string {
  return record ? contentMd(record) : "";
}

/** Proposal plus staleness and before / after SKILL.md text per skill. */
export function describeSkillProposal(
  proposal: SkillProposal,
  manager: SkillManager,
): SkillProposalView {
  const stale = proposal.targetIds.some(
    (id) => manager.getRecord(id)?.revision !== proposal.baseRevisions[id],
  );
  const changes: SkillProposalChange[] = [];
  const p = proposal.payload;
  if (p.kind === "deprecate") {
    const record = manager.getRecord(p.targetId);
    const successor = p.supersededBy ? manager.getRecord(p.supersededBy) : null;
    changes.push({
      skillId: p.targetId,
      name: record?.name ?? p.targetId,
      before: record ? `status: ${record.status}` : "",
      after: `status: deprecated${successor ? ` (superseded by ${successor.name})` : ""}`,
    });
  } else {
    const target = p.targetId ? manager.getRecord(p.targetId) : null;
    changes.push({
      skillId: p.targetId ?? null,
      name: target?.name ?? p.name,
      before: recordMd(target),
      after: contentMd(p),
    });
    if (p.kind === "merge") {
      for (const id of p.sourceIds) {
        if (id === p.targetId) continue;
        const source = manager.getRecord(id);
        changes.push({
          skillId: id,
          name: source?.name ?? id,
          before: source ? `status: ${source.status}` : "",
          after: `status: deprecated (superseded by ${target?.name ?? p.name})`,
        });
      }
    }
  }
  return { ...proposal, stale, changes };
}

/** Apply a proposal's change as the given actor (no proposal bookkeeping). */
export async function applySkillProposalPayload(
  payload: SkillProposalPayload,
  manager: SkillManager,
  ctx: SkillMutationContext,
): Promise<SkillRecord[]> {
  if (payload.kind === "deprecate") {
    return [
      await manager.deprecateSkill(payload.targetId, { supersededBy: payload.supersededBy }, ctx),
    ];
  }
  if (payload.kind === "merge") {
    const result = await manager.mergeSkills(
      {
        target: payload.targetId ?? payload.name,
        sources: payload.sourceIds,
        description: payload.description,
        body: payload.body,
        ...(payload.project !== undefined ? { project: payload.project } : {}),
        files: payload.files,
        removeFiles: payload.removeFiles,
      },
      ctx,
    );
    return [result.target, ...result.deprecated];
  }
  const current = manager.getRecord(payload.targetId);
  if (!current) throw new Error(`Skill not found: ${payload.targetId}`);
  return [
    await manager.upsertSkill(
      {
        id: payload.targetId,
        name: payload.name,
        description: payload.description,
        body: payload.body,
        enabled: current.enabled,
        ...(payload.project !== undefined ? { project: payload.project } : {}),
        files: payload.files,
        removeFiles: payload.removeFiles,
      },
      ctx,
    ),
  ];
}

export function resolveSkillProposal(
  id: string,
  decision: "accept" | "reject",
  manager: SkillManager,
): Promise<{ proposal: SkillProposal; applied: SkillRecord[] }> {
  return locked(async () => {
    const proposal = (await loadAll()).find((p) => p.id === id);
    if (!proposal) throw new Error(`Suggestion not found: ${id}`);
    if (proposal.status !== "pending") {
      throw new Error(`Suggestion was already ${proposal.status}.`);
    }
    let applied: SkillRecord[] = [];
    if (decision === "accept") {
      if (describeSkillProposal(proposal, manager).stale) {
        throw new Error(
          "This suggestion is out of date: the skill changed after it was made. Reject it or edit the skill manually.",
        );
      }
      applied = await applySkillProposalPayload(proposal.payload, manager, {
        actor: "user",
        reason: `Accepted suggestion: ${proposal.reason}`,
      });
    }
    proposal.status = decision === "accept" ? "accepted" : "rejected";
    proposal.resolvedAt = Date.now();
    await save(proposal);
    return { proposal, applied };
  });
}
