import type { SessionDatabase } from "./openDb.js";

/**
 * One successful `read_skill` (SKILL.md) plus the outcome of the turn that
 * read it. Subagent reads are stored under the parent session id with
 * `subagentId` set and are finalized by the child turn.
 */
export type SkillUsageRow = {
  id: string;
  skillId: string;
  skillName: string;
  skillRevision?: number;
  sessionId: string;
  subagentId?: string;
  readAt: number;
  errorsAtRead: number;
  recoveriesAtRead: number;
  correctionsAtRead: number;
  outcome?: string;
  errorsAfter?: number;
  recoveriesAfter?: number;
  userSteered?: boolean;
  createdAt: number;
};

export type SkillUsageStatsRow = {
  skillId: string;
  uses: number;
  lastUsedAt: number;
  /** Finalized reads (outcome set). */
  finished: number;
  /** outcome = idle and no tool error after the read. */
  successes: number;
  /** The user steered / denied after the read. */
  corrected: number;
};

export function insertSkillUsage(
  db: SessionDatabase,
  row: Omit<SkillUsageRow, "outcome" | "errorsAfter" | "recoveriesAfter" | "userSteered">,
): void {
  db.prepare(
    `INSERT INTO skill_usage (
      id, skill_id, skill_name, skill_revision, session_id, subagent_id, read_at,
      errors_at_read, recoveries_at_read, corrections_at_read, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.skillId,
    row.skillName,
    row.skillRevision ?? null,
    row.sessionId,
    row.subagentId ?? null,
    row.readAt,
    row.errorsAtRead,
    row.recoveriesAtRead,
    row.correctionsAtRead,
    row.createdAt,
  );
}

/**
 * Back-fill outcome for every still-open read of one turn. `subagentId`
 * null finalizes only the parent turn's own reads.
 */
export function finalizeSkillUsage(
  db: SessionDatabase,
  input: {
    sessionId: string;
    subagentId: string | null;
    since: number;
    outcome: string;
    errors: number;
    recoveries: number;
    corrections: number;
  },
): number {
  const result = db
    .prepare(
      `UPDATE skill_usage SET
        outcome = ?,
        errors_after = MAX(0, ? - errors_at_read),
        recoveries_after = MAX(0, ? - recoveries_at_read),
        user_steered = CASE WHEN ? > corrections_at_read THEN 1 ELSE 0 END
      WHERE session_id = ? AND outcome IS NULL AND read_at >= ?
        AND ${input.subagentId === null ? "subagent_id IS NULL" : "subagent_id = ?"}`,
    )
    .run(
      input.outcome,
      input.errors,
      input.recoveries,
      input.corrections,
      input.sessionId,
      input.since,
      ...(input.subagentId === null ? [] : [input.subagentId]),
    );
  return Number(result.changes ?? 0);
}

/** Distinct skills read in one session since `since` (parent + subagents). */
export function listSessionSkillReads(
  db: SessionDatabase,
  sessionId: string,
  since: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT DISTINCT skill_id AS skillId FROM skill_usage
       WHERE session_id = ? AND read_at >= ?`,
    )
    .all(sessionId, since) as Array<{ skillId: string }>;
  return rows.map((r) => r.skillId);
}

/** Skills among `skillIds` this session already read in [since, before). */
export function listSkillsReadBetween(
  db: SessionDatabase,
  sessionId: string,
  skillIds: string[],
  since: number,
  before: number,
): Set<string> {
  if (skillIds.length === 0) return new Set();
  const placeholders = skillIds.map(() => "?").join(", ");
  const rows = db
    .prepare(
      `SELECT DISTINCT skill_id AS skillId FROM skill_usage
       WHERE session_id = ? AND read_at >= ? AND read_at < ?
         AND skill_id IN (${placeholders})`,
    )
    .all(sessionId, since, before, ...skillIds) as Array<{ skillId: string }>;
  return new Set(rows.map((r) => r.skillId));
}

/** Skills with a read whose turn has not finished yet. */
export function listOpenSkillReadIds(db: SessionDatabase): string[] {
  const rows = db
    .prepare(`SELECT DISTINCT skill_id AS skillId FROM skill_usage WHERE outcome IS NULL`)
    .all() as Array<{ skillId: string }>;
  return rows.map((r) => r.skillId);
}

export function summarizeSkillUsage(
  db: SessionDatabase,
  options?: { skillId?: string; since?: number },
): SkillUsageStatsRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (options?.skillId) {
    where.push("skill_id = ?");
    args.push(options.skillId);
  }
  if (options?.since !== undefined) {
    where.push("read_at >= ?");
    args.push(options.since);
  }
  const rows = db
    .prepare(
      `SELECT skill_id AS skillId,
        COUNT(*) AS uses,
        MAX(read_at) AS lastUsedAt,
        SUM(CASE WHEN outcome IS NOT NULL THEN 1 ELSE 0 END) AS finished,
        SUM(CASE WHEN outcome = 'idle' AND errors_after = 0 THEN 1 ELSE 0 END) AS successes,
        SUM(CASE WHEN user_steered = 1 THEN 1 ELSE 0 END) AS corrected
      FROM skill_usage
      ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
      GROUP BY skill_id`,
    )
    .all(...args) as Array<Record<string, number | string>>;
  return rows.map((r) => ({
    skillId: String(r.skillId),
    uses: Number(r.uses) || 0,
    lastUsedAt: Number(r.lastUsedAt) || 0,
    finished: Number(r.finished) || 0,
    successes: Number(r.successes) || 0,
    corrected: Number(r.corrected) || 0,
  }));
}

/** Most recent finalized reads, newest first (curation / digest input). */
export function listRecentSkillUsage(
  db: SessionDatabase,
  options: { skillId?: string; since?: number; limit: number },
): SkillUsageRow[] {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (options.skillId) {
    where.push("skill_id = ?");
    args.push(options.skillId);
  }
  if (options.since !== undefined) {
    where.push("read_at >= ?");
    args.push(options.since);
  }
  const rows = db
    .prepare(
      `SELECT * FROM skill_usage
       ${where.length > 0 ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY read_at DESC LIMIT ?`,
    )
    .all(...args, Math.max(1, Math.min(500, options.limit))) as Array<Record<string, unknown>>;
  return rows.map(rowToUsage);
}

function rowToUsage(r: Record<string, unknown>): SkillUsageRow {
  const out: SkillUsageRow = {
    id: String(r.id),
    skillId: String(r.skill_id),
    skillName: String(r.skill_name),
    sessionId: String(r.session_id),
    readAt: Number(r.read_at),
    errorsAtRead: Number(r.errors_at_read) || 0,
    recoveriesAtRead: Number(r.recoveries_at_read) || 0,
    correctionsAtRead: Number(r.corrections_at_read) || 0,
    createdAt: Number(r.created_at),
  };
  if (r.skill_revision != null) out.skillRevision = Number(r.skill_revision);
  if (typeof r.subagent_id === "string") out.subagentId = r.subagent_id;
  if (typeof r.outcome === "string") out.outcome = r.outcome;
  if (r.errors_after != null) out.errorsAfter = Number(r.errors_after);
  if (r.recoveries_after != null) out.recoveriesAfter = Number(r.recoveries_after);
  if (r.user_steered != null) out.userSteered = Number(r.user_steered) === 1;
  return out;
}
