/**
 * loops tool — port + output formatting shared by the builtin and tests.
 *
 * The Loops service lives in the main process (`main/loops/service.ts`,
 * electron-importing), so the tool reaches it through a structural port on
 * ToolExecuteContext — the same pattern as fsmGraphLibrary / turnHandoff.
 * `LoopsService` is assignable to {@link LoopsToolPort} by shape (locked by
 * a compile-time check in loops.test.ts).
 */
import type { ReasoningEffort } from "../llm/reasoningEffort.js";

/** Structural mirror of `LoopView` (loops/db.ts LoopRecord + cadenceSummary). */
export type LoopViewLike = {
  id: string;
  name: string;
  prompt: string;
  workspaceId: string;
  runMode: "agent" | "plan" | "ask";
  providerId: string;
  reasoningEffort: ReasoningEffort;
  fullPermissions: boolean;
  cadenceJson: string;
  enabled: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  createdAt: number;
  updatedAt: number;
  cadenceSummary: string;
};

/** Structural mirror of `LoopRunRecord` (loops/db.ts). */
export type LoopRunViewLike = {
  id: string;
  loopId: string;
  sessionId: string | null;
  status: "running" | "succeeded" | "failed" | "timeout" | "skipped";
  startedAt: number;
  endedAt: number | null;
  error: string | null;
};

/**
 * Capability surface the loops builtin needs. Shape-compatible subset of
 * `LoopsService` (main/loops/service.ts).
 */
export type LoopsToolPort = {
  list: () => LoopViewLike[];
  create: (raw: unknown) => LoopViewLike;
  update: (id: string, raw: unknown) => LoopViewLike | null;
  remove: (id: string) => boolean;
  listRuns: (id: string, limit?: number) => LoopRunViewLike[];
};

/** Local-time `YYYY-MM-DD HH:MM` for epoch-ms timestamps. */
export function formatLoopTimestamp(ms: number | null): string {
  if (ms === null) return "never";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** One compact list line per loop (ids are long UUIDs — keep lines scannable). */
export function describeLoopLine(loop: LoopViewLike): string {
  const state = loop.enabled ? "enabled" : "paused";
  const next = loop.enabled
    ? `next ${formatLoopTimestamp(loop.nextRunAt)}`
    : "paused";
  return [
    `- ${loop.id} · "${loop.name}"`,
    loop.cadenceSummary,
    `${state} · ${next}`,
    `${loop.runCount} run(s)`,
    `ws ${loop.workspaceId}`,
    `runMode ${loop.runMode}${loop.fullPermissions ? " · fullPermissions" : ""}`,
  ].join(" · ");
}

/** One run-history line. */
export function describeRunLine(run: LoopRunViewLike): string {
  const start = formatLoopTimestamp(run.startedAt);
  const duration =
    run.endedAt !== null
      ? ` · ${Math.max(0, Math.round((run.endedAt - run.startedAt) / 1000))}s`
      : "";
  const session = run.sessionId ? ` · session ${run.sessionId}` : "";
  const error = run.error ? ` · ${run.error}` : "";
  return `- [${start}] ${run.status}${duration}${session}${error}`;
}

/**
 * Resolve a loop reference: exact id first, then exact name. Name must be
 * unique — ambiguity lists candidates instead of guessing.
 */
export function resolveLoopRef(
  ref: string,
  loops: LoopViewLike[],
): { ok: true; loop: LoopViewLike } | { ok: false; message: string } {
  const byId = loops.find((loop) => loop.id === ref);
  if (byId) return { ok: true, loop: byId };
  const byName = loops.filter((loop) => loop.name === ref);
  if (byName.length === 1) return { ok: true, loop: byName[0]! };
  if (byName.length > 1) {
    const ids = byName.map((loop) => loop.id).join(", ");
    return {
      ok: false,
      message: `Multiple loops are named "${ref}" — use an id instead: ${ids}.`,
    };
  }
  return {
    ok: false,
    message: `No loop matches "${ref}". Use action=list to see ids and names.`,
  };
}
