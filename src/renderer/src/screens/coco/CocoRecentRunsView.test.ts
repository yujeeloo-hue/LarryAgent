import assert from "node:assert/strict";
import Module from "node:module";
import test from "node:test";
import { parseHTML } from "linkedom";
import type { CocoRuleRun, CocoSnapshot, CocoWork } from "../../../../coco/types.js";
import { defaultSettings } from "../../../../coco/validation.js";

// The existing Markdown renderer imports its highlight stylesheet through Vite.
(Module as unknown as { _extensions: Record<string, () => void> })._extensions[".css"] = () => {};
let CocoRecentRunsView: typeof import("./CocoRecentRunsView.js")["CocoRecentRunsView"];
test.before(async () => { ({ CocoRecentRunsView } = await import("./CocoRecentRunsView.js")); });

const { document, window } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document, window });
const now = Date.UTC(2026, 9, 29, 2, 42);
const run = (id: string, status: CocoRuleRun["status"] = "no_action", startedAt = now): CocoRuleRun => ({ id, ruleId: "rule", ruleName: `Review ${id}`, startedAt, status, attempts: 1, workIds: [] });
const snapshot = (runs: CocoRuleRun[]): CocoSnapshot => ({ settings: { ...defaultSettings(), timezone: "Asia/Shanghai" }, state: "idle", budget: { hourly: 0, daily: 0, estimated: false }, work: [], rules: [], messages: [], reports: [], verifications: [], attempts: [], legacyRuns: [], workspaces: [], ruleRuns: runs });
const expand = (row: HTMLDetailsElement, open = true): void => { row.open = open; row.dispatchEvent(new window.Event("toggle")); };

test("prioritizes active runs and caps the dated timeline at ten without mutating the snapshot", () => {
  const current = Array.from({ length: 6 }, (_, i) => run(`active-${i}`, i % 2 ? "retrying" : "running", now - (i + 1) * 1000));
  const history = Array.from({ length: 8 }, (_, i) => run(`finished-${i}`, "no_action", now + 1000 - i * 1000));
  const s = snapshot([...history, ...current]);
  const view = new CocoRecentRunsView(() => {}, () => {});
  view.render(s, now);
  assert.deepEqual([...view.root.querySelectorAll(".coco-run")].map(row => row.getAttribute("data-run-id")), [...current, ...history.slice(0, 4)].map(run => run.id));
  assert.match(view.root.querySelector(".coco-runs-meta")!.textContent!, /6 in progress.*14 runs/);
  assert.equal(view.root.querySelector(".coco-runs-footer"), null);
  assert.deepEqual([...view.root.querySelectorAll(".coco-runs-day")].map(node => node.textContent), ["In progress", "Today"]);
  assert.equal(s.ruleRuns![0]!.id, "finished-0");
  view.render(snapshot(Array.from({ length: 12 }, (_, i) => run(`active-${i}`, "running", now - i * 1000))), now);
  assert.equal(view.root.querySelectorAll(".coco-run").length, 10);
  assert.equal(view.root.querySelector(".coco-runs-footer"), null);
});

test("loads full Markdown only on expansion and retains expansion across snapshots", () => {
  let layouts = 0;
  const view = new CocoRecentRunsView(() => {}, () => { layouts += 1; });
  const s = snapshot(Array.from({ length: 7 }, (_, i) => ({ ...run(`run-${i}`, "no_action", now - i * 1000), summary: "# Review\n\nChecked **Relay** and [project progress](https://example.com).\n\n- No duplicate tasks." })));
  view.render(s, now);
  const row = view.root.querySelector<HTMLDetailsElement>(".coco-run")!;
  assert.equal(row.querySelector(".coco-run-summary"), null);
  assert.equal(row.querySelector(".coco-run-preview")!.textContent, "Checked Relay and project progress. No duplicate tasks.");
  expand(row);
  assert.ok(row.querySelector(".coco-run-summary strong"));
  assert.ok(row.querySelector(".coco-run-summary ul"));
  assert.equal(layouts, 1);
  s.ruleRuns![0]!.summary = "Updated summary from the latest snapshot.";
  view.render(s, now + 1000);
  assert.equal(view.root.querySelectorAll(".coco-run").length, 7);
  const updated = view.root.querySelector<HTMLDetailsElement>("[data-run-id='run-0']")!;
  assert.equal(updated.open, true);
  assert.match(updated.querySelector(".coco-run-summary")!.textContent!, /Updated summary/);
  // A queued toggle from the old, detached row must not overwrite the new state.
  expand(row, false);
  view.render(s, now + 2000);
  assert.equal(view.root.querySelector<HTMLDetailsElement>("[data-run-id='run-0']")!.open, true);
});

test("opens the actual work item, with verified and pending acceptance kept distinct", () => {
  let opened: CocoWork | undefined;
  const view = new CocoRecentRunsView(work => { opened = work; }, () => {});
  const s = snapshot([{ ...run("planned", "planned"), workIds: ["done", "pending", "missing"] }]);
  const base = { goalId: "goal", objective: "Review", workspaceId: "relay", priority: 50, dependsOn: [], steps: [], acceptance: [{ id: "check", description: "Flow works", kind: "review" as const }], deliverables: [], ruleIds: [], revision: 1, repairs: 0, fullPermissions: true, providerId: "", createdAt: now, updatedAt: now, summary: "", timeline: [] };
  s.work = [{ ...base, id: "done", title: "Recover Confirm", status: "completed" }, { ...base, id: "pending", title: "Check narrow layout", status: "verifying" }];
  s.workspaces = [{ id: "relay", name: "Relay" }];
  s.verifications = [{ id: "verification", workId: "done", revision: 1, at: now, passed: true, summary: "Passed", checks: [{ criterionId: "check", passed: true, evidence: "Recovered after failure" }] }];
  view.render(s, now);
  assert.match(view.root.querySelector(".coco-run-outcomes")!.textContent!, /2 tasks1 verified1 pending/);
  expand(view.root.querySelector<HTMLDetailsElement>(".coco-run")!);
  const tasks = view.root.querySelectorAll<HTMLButtonElement>(".coco-run-task");
  assert.equal(tasks.length, 2);
  assert.match(tasks[0]!.textContent!, /Relay1\/1 criteria passed/);
  assert.match(tasks[1]!.textContent!, /Acceptance pending/);
  tasks[1]!.click();
  assert.equal(opened, s.work[1]);
});

test("a chat request finished today sits under Today at its completion time", () => {
  const requested = Date.UTC(2026, 9, 28, 15, 48), finished = Date.UTC(2026, 9, 29, 0, 5);
  const s = snapshot([
    { id: "chat-m1", source: "chat", ruleId: "", ruleName: "Scan for Chinese text", startedAt: requested, endedAt: finished, status: "planned", attempts: 1, workIds: [] },
    run("rule", "planned", Date.UTC(2026, 9, 28, 10)),
  ]);
  const view = new CocoRecentRunsView(() => {}, () => {});
  view.render(s, now);
  assert.deepEqual([...view.root.querySelectorAll(".coco-runs-day")].map(node => node.textContent), ["Today", "Yesterday"]);
  const chat = view.root.querySelector<HTMLDetailsElement>("[data-run-id='chat-m1']")!;
  assert.equal(chat.querySelector(".coco-run-time")!.textContent, "08:05");
  assert.equal(chat.querySelector(".coco-run-status")!.textContent, "Completed");
  assert.match(chat.querySelector(".coco-run-meta")!.textContent!, /Completed in 8h 17m/);
});

test("groups by the configured timezone and keeps retry dates and errors readable", () => {
  const s = snapshot([
    { ...run("retry", "retrying"), retryAt: Date.UTC(2026, 9, 29, 17), error: "<script>unsafe()</script>\nHTTP 503", attempts: 2 },
    run("today", "no_action", Date.UTC(2026, 9, 28, 17)),
    { ...run("yesterday", "failed", Date.UTC(2026, 9, 28, 15, 59)), summary: "A partial review was saved.", error: "Connection timed out", attempts: 3 },
  ]);
  const view = new CocoRecentRunsView(() => {}, () => {});
  view.render(s, now);
  assert.deepEqual([...view.root.querySelectorAll(".coco-runs-day")].map(node => node.textContent), ["In progress", "Today", "Yesterday"]);
  const retry = view.root.querySelector<HTMLDetailsElement>("[data-run-id='retry']")!;
  assert.match(retry.querySelector(".coco-run-status")!.textContent!, /Retrying at .*30/);
  expand(retry);
  assert.equal(retry.querySelector("script"), null);
  assert.equal(retry.querySelector(".coco-run-error")!.textContent, "<script>unsafe()</script>\nHTTP 503");
  const failed = view.root.querySelector<HTMLDetailsElement>("[data-run-id='yesterday']")!;
  expand(failed);
  assert.match(failed.querySelector(".coco-run-summary")!.textContent!, /partial review/);
  assert.match(failed.querySelector(".coco-run-error")!.textContent!, /Connection timed out/);
});
