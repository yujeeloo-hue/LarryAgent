import type { ReasoningEffort } from "../llm/reasoningEffort.js";

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

export type LoopRunViewLike = {
  id: string;
  loopId: string;
  sessionId: string | null;
  status: "running" | "succeeded" | "failed" | "timeout" | "skipped";
  startedAt: number;
  endedAt: number | null;
  error: string | null;
};

export type LoopsToolPort = {
  list: () => LoopViewLike[];
  create: (raw: unknown) => LoopViewLike;
  update: (id: string, raw: unknown) => LoopViewLike | null;
  remove: (id: string) => boolean;
  listRuns: (id: string, limit?: number) => LoopRunViewLike[];
};

export function formatLoopTimestamp(ms: number | null): string {
  if (ms === null) return "never";
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

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
