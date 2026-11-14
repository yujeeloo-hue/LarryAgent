import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COCO_MEMORY_SOFT_CAP, acceptConsolidated, applyCocoMemoryUpdate, droppedEntries,
  emptyCocoMemory, formatCocoMemory, parseCocoMemory, trimCocoMemory,
} from "./memory.js";

const stamp = "2026-10-30 12:00";

test("parse/format round-trips the four sections and keeps stray lines in Focus", () => {
  const body = "# CoCo memory\n\nloose note\n\n## Projects\n\n- App — /a\n\n## Focus\n\n## Open items\n\n- [open] o1: ship\n  detail line\n\n## Work log\n";
  const doc = parseCocoMemory(body);
  assert.deepEqual(doc.projects, ["- App — /a"]);
  assert.deepEqual(doc.open_items, ["- [open] o1: ship\n  detail line"]);
  assert.deepEqual(doc.focus, ["- loose note"]);
  assert.deepEqual(parseCocoMemory(formatCocoMemory(doc)), doc);
});

test("merge appends without duplicates and timestamps work log bullets", () => {
  let { body } = applyCocoMemoryUpdate(formatCocoMemory(emptyCocoMemory()), { section: "work_log", content: "Fixed login\n- 2026-10-01 09:00 · Older", mode: "merge", stamp });
  ({ body } = applyCocoMemoryUpdate(body, { section: "work_log", content: "- 2026-10-01 09:00 · Older", mode: "merge", stamp }));
  assert.deepEqual(parseCocoMemory(body).work_log, [`- ${stamp} · Fixed login`, "- 2026-10-01 09:00 · Older"]);
});

test("replace reports the entries it removed", () => {
  const start = applyCocoMemoryUpdate(formatCocoMemory(emptyCocoMemory()), { section: "focus", content: "- a\n- b", mode: "merge", stamp }).body;
  const next = applyCocoMemoryUpdate(start, { section: "focus", content: "- b\n- c", mode: "replace", stamp });
  assert.deepEqual(next.removed, [{ section: "focus", text: "- a" }]);
  assert.deepEqual(parseCocoMemory(next.body).focus, ["- b", "- c"]);
});

test("merging an Open item with an existing id replaces every line of that id in place", () => {
  const start = formatCocoMemory({ ...emptyCocoMemory(), open_items: ["- [open] a: first", "- [decide] b: pick", "- [open] b: duplicate"] });
  const next = applyCocoMemoryUpdate(start, { section: "open_items", content: "- [done] b: picked C\n- [open] c: new", mode: "merge", stamp });
  assert.deepEqual(parseCocoMemory(next.body).open_items, ["- [open] a: first", "- [done] b: picked C", "- [open] c: new"]);
  assert.deepEqual(next.removed, [{ section: "open_items", text: "- [decide] b: pick" }, { section: "open_items", text: "- [open] b: duplicate" }]);
});

test("trim drops oldest work log, then closed items, never live items or projects", () => {
  const doc = emptyCocoMemory();
  doc.projects = ["- P — /p"];
  doc.open_items = ["- [done] d1: old", "- [open] o1: keep"];
  doc.work_log = Array.from({ length: 50 }, (_, i) => `- 2026-10-${String(i % 28 + 1).padStart(2, "0")} 10:00 · entry ${i} ${"x".repeat(200)}`);
  const body = formatCocoMemory(doc);
  const trimmed = trimCocoMemory(body, 1_000);
  const after = parseCocoMemory(trimmed.body);
  assert.ok(trimmed.body.length <= 1_000);
  assert.deepEqual(after.projects, doc.projects);
  assert.ok(after.open_items.includes("- [open] o1: keep"));
  assert.equal(trimmed.removed[0]!.text, doc.work_log[0]);
  assert.equal(trimmed.removed.length + after.work_log.length + after.open_items.length, doc.work_log.length + 2);
});

test("droppedEntries lists bullets missing after a rewrite", () => {
  const before = formatCocoMemory({ ...emptyCocoMemory(), work_log: ["- 1 · a", "- 2 · b"], focus: ["- f"] });
  const after = formatCocoMemory({ ...emptyCocoMemory(), work_log: ["- 2 · b"], focus: ["- f  "] });
  assert.deepEqual(droppedEntries(before, after), [{ section: "work_log", text: "- 1 · a" }]);
});

test("a consolidated body must keep headings, fit the cap and keep live open items", () => {
  const before = formatCocoMemory({ ...emptyCocoMemory(), open_items: ["- [open] o1: x", "- [done] d1: y"] });
  const good = formatCocoMemory({ ...emptyCocoMemory(), open_items: ["- [open] o1: x"] });
  assert.equal(acceptConsolidated(before, good, COCO_MEMORY_SOFT_CAP), true);
  assert.equal(acceptConsolidated(before, formatCocoMemory(emptyCocoMemory()), COCO_MEMORY_SOFT_CAP), false);
  assert.equal(acceptConsolidated(before, "# CoCo memory\n\n## Projects\n", COCO_MEMORY_SOFT_CAP), false);
  assert.equal(acceptConsolidated(before, good, 10), false);
});
