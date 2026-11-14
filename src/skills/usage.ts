import { randomUUID } from "node:crypto";
import type { SessionDatabase } from "../session/db/openDb.js";
import {
  finalizeSkillUsage,
  insertSkillUsage,
  listOpenSkillReadIds,
  listRecentSkillUsage,
  listSessionSkillReads,
  listSkillsReadBetween,
  summarizeSkillUsage,
  type SkillUsageRow,
  type SkillUsageStatsRow,
} from "../session/db/skillUsageRepository.js";

/**
 * Skill usage ledger (`skill_usage`). Writes never throw into the agent turn;
 * without a configured DB every call is a no-op / empty result.
 */

/** A skill counts toward the "used skill" reflect path once per session per window. */
export const SKILL_USED_REFLECT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

let db: SessionDatabase | null = null;
const finalizeListeners = new Set<(sessionId: string) => void>();

/** Fires after a turn's skill reads got their outcome. Returns an unsubscribe. */
export function onSkillUsageFinalized(listener: (sessionId: string) => void): () => void {
  finalizeListeners.add(listener);
  return () => finalizeListeners.delete(listener);
}

export function configureSkillUsage(options: { db: SessionDatabase | null }): void {
  db = options.db;
}

export function isSkillUsageConfigured(): boolean {
  return db !== null;
}

function guard<T>(label: string, fallback: T, fn: (d: SessionDatabase) => T): T {
  if (!db) return fallback;
  try {
    return fn(db);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[skill-usage] ${label} failed: ${message}`);
    return fallback;
  }
}

export type TurnOutcomeCounters = {
  errors: number;
  recoveries: number;
  /** Steers drained + user denials so far in the turn. */
  corrections: number;
};

export function recordSkillRead(input: {
  skillId: string;
  skillName: string;
  skillRevision?: number;
  sessionId: string;
  subagentId?: string;
  at?: number;
  counters: TurnOutcomeCounters;
}): void {
  guard("record", undefined, (d) => {
    const at = input.at ?? Date.now();
    insertSkillUsage(d, {
      id: randomUUID(),
      skillId: input.skillId,
      skillName: input.skillName,
      ...(input.skillRevision !== undefined ? { skillRevision: input.skillRevision } : {}),
      sessionId: input.sessionId,
      ...(input.subagentId ? { subagentId: input.subagentId } : {}),
      readAt: at,
      errorsAtRead: input.counters.errors,
      recoveriesAtRead: input.counters.recoveries,
      correctionsAtRead: input.counters.corrections,
      createdAt: at,
    });
  });
}

export function finalizeTurnSkillUsage(input: {
  sessionId: string;
  subagentId?: string;
  turnStartedAt: number;
  outcome: string;
  counters: TurnOutcomeCounters;
}): number {
  const changed = guard("finalize", 0, (d) =>
    finalizeSkillUsage(d, {
      sessionId: input.sessionId,
      subagentId: input.subagentId ?? null,
      since: input.turnStartedAt,
      outcome: input.outcome,
      errors: input.counters.errors,
      recoveries: input.counters.recoveries,
      corrections: input.counters.corrections,
    }),
  );
  if (changed > 0) {
    for (const listener of finalizeListeners) {
      try {
        listener(input.sessionId);
      } catch (err) {
        console.warn("[skill-usage] finalize listener failed", err);
      }
    }
  }
  return changed;
}

export function listOpenSkillReads(): Set<string> {
  return new Set(guard("open", [] as string[], (d) => listOpenSkillReadIds(d)));
}

/**
 * Skills read during this turn (parent + its subagents) that the session had
 * not already read inside the cooldown window before the turn started.
 * Returns null when the ledger is unavailable.
 */
export function countFreshTurnSkillReads(input: {
  sessionId: string;
  turnStartedAt: number;
  cooldownMs?: number;
}): number | null {
  return guard<number | null>("count", null, (d) => {
    const read = listSessionSkillReads(d, input.sessionId, input.turnStartedAt);
    if (read.length === 0) return 0;
    const cooldown = input.cooldownMs ?? SKILL_USED_REFLECT_COOLDOWN_MS;
    const seen = listSkillsReadBetween(
      d,
      input.sessionId,
      read,
      input.turnStartedAt - cooldown,
      input.turnStartedAt,
    );
    return read.filter((id) => !seen.has(id)).length;
  });
}

export function getSkillUsageStats(options?: {
  skillId?: string;
  since?: number;
}): SkillUsageStatsRow[] {
  return guard("stats", [], (d) => summarizeSkillUsage(d, options));
}

export function listRecentSkillReads(options: {
  skillId?: string;
  since?: number;
  limit: number;
}): SkillUsageRow[] {
  return guard("recent", [], (d) => listRecentSkillUsage(d, options));
}

export type { SkillUsageRow, SkillUsageStatsRow };
