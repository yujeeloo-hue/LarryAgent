import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { CocoRepository } from "./repository.js";
import type { CocoWakeEntry } from "./types.js";
import { appendWakeEntry, formatWakeBriefing, markWakeEntriesDelivered, nextVcsBaseline, pruneWakeEntries, seedVcsBaseline, undeliveredWakeEntries, vcsChanges, wakeReasons, WAKE_ENTRY_RETENTION_MS } from "./wakeLedger.js";

const project = { workspaceId: "p1", workspaceName: "JellyBot", workspacePath: "/dev/JellyBot" };
const repo = () => new CocoRepository(new DatabaseSync(":memory:"));

test("a document waiting for delivery keeps one entry; delivered entries prune after 7 days", () => {
  const r = repo();
  appendWakeEntry(r, { ...project, at: 1, kind: "project_doc", doc: "PROJECT.md" });
  appendWakeEntry(r, { ...project, at: 5, kind: "project_doc", doc: "PROJECT.md" });
  appendWakeEntry(r, { ...project, at: 6, kind: "project_doc", doc: "WORKLOG.md" });
  appendWakeEntry(r, { ...project, at: 7, kind: "work_status", workTitle: "A", outcome: "completed" });
  appendWakeEntry(r, { ...project, at: 8, kind: "work_status", workTitle: "A", outcome: "completed" });
  const waiting = undeliveredWakeEntries(r);
  assert.equal(waiting.length, 4);
  assert.equal(waiting.find(e => e.doc === "PROJECT.md")?.at, 5);
  markWakeEntriesDelivered(r, waiting.map(e => e.id), 100);
  assert.equal(undeliveredWakeEntries(r).length, 0);
  appendWakeEntry(r, { ...project, at: 200, kind: "project_doc", doc: "PROJECT.md" });
  assert.equal(undeliveredWakeEntries(r).length, 1, "a delivered document starts a new entry");
  pruneWakeEntries(r, 100 + WAKE_ENTRY_RETENTION_MS - 1);
  assert.equal(r.list("wakeEntry").length, 5);
  pruneWakeEntries(r, 100 + WAKE_ENTRY_RETENTION_MS);
  assert.equal(r.list("wakeEntry").length, 1, "undelivered entries are never pruned");
});

test("version changes: first sight seeds, branch-only moves are ignored, unreadable keeps the old baseline", () => {
  const projects = [{ id: "p1", name: "JellyBot", path: "/a" }, { id: "p2", name: "Octo", path: "/b" }];
  const git = (commit: string, ref = "refs/heads/main") => ({ kind: "git" as const, ref, commit });
  const seeded = seedVcsBaseline({}, { p1: git("a".repeat(40)), p2: null })!;
  assert.deepEqual(seeded, { p1: git("a".repeat(40)) });
  assert.equal(seedVcsBaseline(seeded, { p1: git("b".repeat(40)) }), undefined);
  assert.deepEqual(vcsChanges(projects, seeded, { p1: git("a".repeat(40), "refs/heads/feature") }), []);
  const moved = vcsChanges(projects, { ...seeded, p2: { kind: "svn", revision: "1842" } }, { p1: git("b".repeat(40)), p2: { kind: "svn", revision: "1846" } });
  assert.equal(moved.length, 2);
  assert.deepEqual(nextVcsBaseline({ p1: git("a".repeat(40)) }, { p1: null }, projects), { p1: git("a".repeat(40)) });
});

test("the briefing lists every section in the agreed format and omits empty ones", () => {
  const entries: CocoWakeEntry[] = [
    { id: "1", at: 1, kind: "work_status", ...project, workId: "w1", workTitle: "Fix relay reconnect", outcome: "completed" },
    { id: "2", at: 2, kind: "project_doc", ...project, doc: "PROJECT.md" },
    { id: "3", at: 3, kind: "project_doc", ...project, doc: "WORKLOG.md" },
    { id: "4", at: 4, kind: "work_status", ...project, workTitle: "Add settings slider", outcome: "interrupted", reason: "app_restart" },
    { id: "5", at: 5, kind: "work_status", ...project, workTitle: "Ship docs index", outcome: "failed", reason: "retries_exhausted" },
    { id: "6", at: 6, kind: "workspace_added", workspaceId: "p2", workspaceName: "Octo Notes", workspacePath: "/dev/OctoNotes" },
    { id: "7", at: 7, kind: "workspace_removed", workspaceId: "p3", workspaceName: "Old Sandbox", workspacePath: "/dev/old-sandbox" },
  ];
  const vcs = [
    { workspace: { id: "p1", name: "JellyBot", path: "/dev/JellyBot" }, from: { kind: "git" as const, ref: "refs/heads/main", commit: "a1b2c3d".padEnd(40, "0") }, to: { kind: "git" as const, ref: "refs/heads/main", commit: "e4f5a6b".padEnd(40, "0") } },
    { workspace: { id: "p2", name: "Octo Notes", path: "/dev/OctoNotes" }, from: { kind: "svn" as const, revision: "1842" }, to: { kind: "svn" as const, revision: "1846" } },
  ];
  const text = formatWakeBriefing({
    reasons: wakeReasons(entries, false, true),
    since: Date.UTC(2026, 10, 2, 1, 32), timezone: "Asia/Shanghai", entries, vcs,
    docNote: () => "summary updated in memory",
  });
  assert.equal(text, [
    "[Automatic CoCo wake, not a user message] The user has sent nothing new. Follow [AUTONOMOUS].",
    "",
    "Wake: task completed, heartbeat, app restart, task failed, workspace added, workspace removed",
    "Since: 2026-11-02 09:32",
    "",
    "Projects",
    "- JellyBot — /dev/JellyBot",
    "  - PROJECT.md changed (summary updated in memory)",
    "  - docs/WORKLOG.md changed",
    "  - git main: a1b2c3d → e4f5a6b",
    "- Octo Notes — /dev/OctoNotes",
    "  - svn: r1842 → r1846",
    "",
    "Tasks",
    "- Fix relay reconnect — completed · JellyBot (workspaceId p1, workId w1)",
    "- Add settings slider — interrupted (app restart) · JellyBot (workspaceId p1)",
    "- Ship docs index — failed · JellyBot (workspaceId p1)",
    "",
    "Workspaces",
    "- Added: Octo Notes — /dev/OctoNotes",
    "- Removed: Old Sandbox — /dev/old-sandbox",
  ].join("\n"));
  const minimal = formatWakeBriefing({ reasons: ["heartbeat"], timezone: "UTC", entries: [], vcs: [vcs[1]!] });
  assert.ok(!minimal.includes("Since:") && !minimal.includes("Tasks") && !minimal.includes("Workspaces"));
});
