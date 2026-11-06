import { randomUUID } from "node:crypto";
import type { CocoRepository } from "./repository.js";
import type { CocoVcsFact, CocoWakeEntry } from "./types.js";

export const WAKE_ENTRY_KIND = "wakeEntry";
/** Delivered entries are kept this long, then pruned by the daily cleanup. */
export const WAKE_ENTRY_RETENTION_MS = 7 * 86_400_000;

export type CocoWakeProject = { id: string; name: string; path: string };
export type CocoVcsChange = { workspace: CocoWakeProject; from: CocoVcsFact; to: CocoVcsFact };
/** What a project's PROJECT.md digest did after the write, if anything yet. */
export type CocoProjectDocNote = "summary updated in memory" | "first PROJECT.md generated";

export function undeliveredWakeEntries(repository: CocoRepository): CocoWakeEntry[] {
  return repository.list<CocoWakeEntry>(WAKE_ENTRY_KIND).filter(e => !e.deliveredAt).sort((a, b) => a.at - b.at);
}

/** Append one entry. A document already waiting for delivery only moves its time forward. */
export function appendWakeEntry(repository: CocoRepository, entry: Omit<CocoWakeEntry, "id" | "deliveredAt">): CocoWakeEntry {
  if (entry.kind === "project_doc") {
    const waiting = undeliveredWakeEntries(repository).find(e => e.kind === "project_doc" && e.workspaceId === entry.workspaceId && e.doc === entry.doc);
    if (waiting) return repository.put<CocoWakeEntry>(WAKE_ENTRY_KIND, { ...waiting, at: entry.at });
  }
  return repository.put<CocoWakeEntry>(WAKE_ENTRY_KIND, { ...entry, id: randomUUID() });
}

export function markWakeEntriesDelivered(repository: CocoRepository, ids: string[], at: number): void {
  for (const id of ids) {
    const entry = repository.get<CocoWakeEntry>(WAKE_ENTRY_KIND, id);
    if (entry && !entry.deliveredAt) repository.put<CocoWakeEntry>(WAKE_ENTRY_KIND, { ...entry, deliveredAt: at });
  }
}

export function pruneWakeEntries(repository: CocoRepository, now: number): void {
  for (const entry of repository.list<CocoWakeEntry>(WAKE_ENTRY_KIND)) {
    if (entry.deliveredAt && now - entry.deliveredAt >= WAKE_ENTRY_RETENTION_MS) repository.remove(WAKE_ENTRY_KIND, entry.id);
  }
}

const sameVersion = (a: CocoVcsFact, b: CocoVcsFact): boolean =>
  a.kind === "git" && b.kind === "git" ? a.commit === b.commit : a.kind === "svn" && b.kind === "svn" ? a.revision === b.revision : false;

/**
 * Compare current versions with the delivered baseline. Projects seen for the
 * first time report no change; their version only becomes the baseline.
 */
export function vcsChanges(projects: CocoWakeProject[], baseline: Record<string, CocoVcsFact>, current: Record<string, CocoVcsFact | null>): CocoVcsChange[] {
  const changes: CocoVcsChange[] = [];
  for (const workspace of projects) {
    const from = baseline[workspace.id], to = current[workspace.id];
    if (from && to && !sameVersion(from, to)) changes.push({ workspace, from, to });
  }
  return changes;
}

/** Baseline after delivery: known current versions win; unreadable ones keep the previous value. */
export function nextVcsBaseline(baseline: Record<string, CocoVcsFact>, current: Record<string, CocoVcsFact | null>, projects: CocoWakeProject[]): Record<string, CocoVcsFact> {
  const next: Record<string, CocoVcsFact> = {};
  for (const project of projects) {
    const value = current[project.id] ?? baseline[project.id];
    if (value) next[project.id] = value;
  }
  return next;
}

/** First-seen projects join the baseline immediately so their first change is reportable. */
export function seedVcsBaseline(baseline: Record<string, CocoVcsFact>, current: Record<string, CocoVcsFact | null>): Record<string, CocoVcsFact> | undefined {
  let changed = false;
  const next = { ...baseline };
  for (const [id, value] of Object.entries(current)) if (value && !next[id]) { next[id] = value; changed = true; }
  return changed ? next : undefined;
}

const shortVersion = (fact: CocoVcsFact): string => fact.kind === "git" ? fact.commit.slice(0, 7) : `r${fact.revision}`;
const branch = (fact: CocoVcsFact): string => fact.kind === "git" ? (fact.ref.replace(/^refs\/heads\//, "") || "HEAD") : "";

function entryReason(entry: CocoWakeEntry): string | undefined {
  if (entry.kind === "workspace_added") return "workspace added";
  if (entry.kind === "workspace_removed") return "workspace removed";
  if (entry.kind !== "work_status") return undefined;
  if (entry.outcome === "completed") return "task completed";
  if (entry.outcome === "failed") return "task failed";
  return entry.reason === "app_restart" ? "app restart" : "task interrupted";
}

/** Wake reasons in occurrence order, without repeats. Document and version changes count as the heartbeat. */
export function wakeReasons(entries: CocoWakeEntry[], heartbeat: boolean, versionChanged: boolean): string[] {
  const reasons: string[] = [];
  const add = (reason: string): void => { if (!reasons.includes(reason)) reasons.push(reason); };
  if (heartbeat) add("heartbeat");
  for (const entry of entries) add(entryReason(entry) ?? "heartbeat");
  if (versionChanged) add("heartbeat");
  return reasons;
}

export type CocoWakeBriefingInput = {
  reasons: string[];
  since?: number | undefined;
  timezone: string;
  entries: CocoWakeEntry[];
  vcs: CocoVcsChange[];
  docNote?: ((entry: CocoWakeEntry) => CocoProjectDocNote | undefined) | undefined;
};

const formatTime = (at: number, timeZone: string): string => {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
};

/** The plain-text wake briefing. Sections without entries are omitted. */
export function formatWakeBriefing(input: CocoWakeBriefingInput): string {
  const lines = ["[Automatic CoCo wake, not a user message] The user has sent nothing new. Follow [AUTONOMOUS].", "", `Wake: ${input.reasons.join(", ")}`];
  if (input.since) lines.push(`Since: ${formatTime(input.since, input.timezone)}`);

  const projects = new Map<string, { name: string; path: string; items: string[] }>();
  const project = (id: string, name: string, path: string) => {
    let value = projects.get(id);
    if (!value) { value = { name, path, items: [] }; projects.set(id, value); }
    return value;
  };
  for (const entry of input.entries.filter(e => e.kind === "project_doc")) {
    const note = entry.doc === "PROJECT.md" ? input.docNote?.(entry) : undefined;
    const doc = entry.doc === "WORKLOG.md" ? "docs/WORKLOG.md" : entry.doc;
    project(entry.workspaceId, entry.workspaceName, entry.workspacePath).items.push(`${doc} changed${note ? ` (${note})` : ""}`);
  }
  for (const change of input.vcs) {
    const label = change.to.kind === "git" ? `git ${branch(change.to)}` : "svn";
    project(change.workspace.id, change.workspace.name, change.workspace.path).items.push(`${label}: ${shortVersion(change.from)} → ${shortVersion(change.to)}`);
  }
  if (projects.size) {
    lines.push("", "Projects");
    for (const value of projects.values()) lines.push(`- ${value.name} — ${value.path}`, ...value.items.map(item => `  - ${item}`));
  }

  const tasks = input.entries.filter(e => e.kind === "work_status");
  if (tasks.length) {
    lines.push("", "Tasks");
    for (const task of tasks) {
      const ids = `workspaceId ${task.workspaceId}${task.workId ? `, workId ${task.workId}` : ""}`;
      lines.push(`- ${task.workTitle ?? "Task"} — ${task.outcome}${task.reason === "app_restart" ? " (app restart)" : ""} · ${task.workspaceName} (${ids})`);
    }
  }

  const added = input.entries.filter(e => e.kind === "workspace_added"), removed = input.entries.filter(e => e.kind === "workspace_removed");
  if (added.length || removed.length) {
    lines.push("", "Workspaces");
    for (const entry of added) lines.push(`- Added: ${entry.workspaceName} — ${entry.workspacePath}`);
    for (const entry of removed) lines.push(`- Removed: ${entry.workspaceName} — ${entry.workspacePath}`);
  }
  return lines.join("\n");
}
