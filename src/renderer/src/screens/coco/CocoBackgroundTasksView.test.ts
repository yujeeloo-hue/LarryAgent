import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { CocoBackgroundTasksView } from "./CocoBackgroundTasksView.js";
import type { CocoBackgroundTask } from "../../../../coco/types.js";

const { document } = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { document });
const task = (id: string, status: CocoBackgroundTask["status"] = "running"): CocoBackgroundTask => ({ id, sessionId: `session-${id}`, purpose: "recover", title: "Audit fonts", status, startedAt: 1, updatedAt: 2, progress: "Reading saved tool results", summary: "" });

test("renders only running checks as static compact rows — no history group, no expansion", () => {
  const view = new CocoBackgroundTasksView();
  document.body.append(view.root);
  view.update([task("one"), { ...task("done", "completed"), summary: "Finished work" }, { ...task("bad", "error"), summary: "Failed" }]);
  assert.equal(view.root.hidden, false);
  assert.equal(view.root.querySelectorAll(".coco-background-row").length, 1, "finished and errored checks are not shown");
  const row = view.root.querySelector(".coco-background-row")!;
  assert.match(row.textContent!, /Recovery · Audit fonts/);
  assert.match(row.textContent!, /Reading saved tool results/);
  assert.equal(row.querySelector("details"), null, "rows are not expandable");
  assert.equal(view.root.querySelector(".coco-background-history"), null, "no Earlier checks history group");
  const spinner = row.querySelector(".session-running-spinner");
  assert.ok(spinner && spinner.tagName === "SPAN", "canonical app ring spinner");
  view.update([]); assert.equal(view.root.hidden, false, "still visible while the exit transition runs");
  view.destroy(); assert.equal(view.root.isConnected, false);
});

test("rows are node-stable; progress updates roll the status text in place", () => {
  const view = new CocoBackgroundTasksView();
  document.body.append(view.root);
  view.update([task("one")]);
  const row = view.root.querySelector(".coco-background-row")!;
  const status = row.querySelector(".coco-background-status")!;
  view.update([{ ...task("one"), progress: "Checking acceptance evidence" }]);
  assert.equal(view.root.querySelector(".coco-background-row"), row, "the same node is reused across snapshots");
  assert.equal(row.querySelector(".coco-background-status"), status);
  assert.match(status.textContent!, /Checking acceptance evidence/);
  view.update([{ ...task("one"), progress: "" }]);
  assert.match(status.textContent!, /Checking saved context…/, "empty progress falls back to the default status");
  view.destroy();
});

test("a check that stops running exits with the fade transition and then detaches", async () => {
  const view = new CocoBackgroundTasksView();
  document.body.append(view.root);
  view.update([task("one")]);
  const row = view.root.querySelector(".coco-background-row")!;
  view.update([{ ...task("one", "completed") }]);
  assert.equal(row.classList.contains("is-out"), true, "the row fades out instead of vanishing");
  assert.equal(row.isConnected, true);
  await new Promise(resolve => setTimeout(resolve, 380));
  assert.equal(row.isConnected, false);
  assert.equal(view.root.hidden, true, "the strip hides once nothing is running");
  view.destroy();
});

test("concurrent running checks stack in start order", () => {
  const view = new CocoBackgroundTasksView();
  document.body.append(view.root);
  view.update([{ ...task("late"), title: "Late check", startedAt: 9 }, { ...task("early"), title: "Early check", startedAt: 1 }, { ...task("mid"), title: "Mid check", startedAt: 5 }]);
  const rows = [...view.root.querySelectorAll(".coco-background-row")]!;
  assert.deepEqual(rows.map(row => row.textContent), ["Recovery · Early check·Reading saved tool results", "Recovery · Mid check·Reading saved tool results", "Recovery · Late check·Reading saved tool results"]);
  view.destroy();
});


test("legacy greeting records never appear as background task cards", () => {
  const view = new CocoBackgroundTasksView();
  view.update([{ ...task("old-greet"), purpose: "greet", title: "Catch up with you" }]);
  assert.equal(view.root.querySelectorAll(".coco-background-row").length, 0);
  assert.equal(view.root.hidden, true);
  view.destroy();
});
