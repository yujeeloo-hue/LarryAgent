/**
 * DOM test: session list rows (web console) — div rows (role=button) with
 * an optional inline trash affordance for remote delete (devices ≥ 1.3.4).
 * Without onDelete no trash renders at all; with it, a trash click must not
 * bubble into the row's open handler, and the row itself still opens.
 */
import { parseHTML } from "linkedom";
import test from "node:test";
import assert from "node:assert/strict";

// renderSessionList touches document at render time — install linkedom first.
const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
});

const { renderSessionList } = await import("../src/render.js");
type Summary = Parameters<typeof renderSessionList>[0][number];

function session(id: string, title: string): Summary {
  return {
    id,
    title,
    updatedAt: Date.now(),
    status: "idle",
    progressText: "",
    type: "agent",
    messageCount: 2,
    workspaceId: "w1",
    archived: false,
    archivedAt: null,
  } as Summary;
}

const SESSIONS = [session("s1", "First"), session("s2", "Second")];

test("renders div rows with keyboard affordances; no trash without onDelete", () => {
  const opened: string[] = [];
  const list = renderSessionList(SESSIONS, "s1", (s) => opened.push(s.id));
  const rows = list.querySelectorAll(".session-row");
  assert.equal(rows.length, 2);
  const [r1, r2] = rows;
  // A div, not a button — the trash nests inside and HTML forbids
  // button-in-button; keyboard parity comes from role + tabindex.
  assert.equal(r1!.tagName, "DIV");
  assert.equal(r1!.getAttribute("role"), "button");
  assert.equal(r1!.getAttribute("tabindex"), "0");
  assert.ok(r1!.classList.contains("active"), "activeId marks the open row");
  assert.ok(!r2!.classList.contains("active"));
  assert.equal(
    list.querySelectorAll(".session-delete").length,
    0,
    "legacy devices (no onDelete) render no trash buttons",
  );
  // Row click still opens the session.
  (r2 as HTMLElement).click();
  assert.deepEqual(opened, ["s2"]);
});

test("every row keeps the plain status dot — CoCo-owned sessions never reach the ordinary list", () => {
  // CoCo chat / autonomous runs are filtered in the shell (ordinarySessions)
  // before renderSessionList; a stray one must still render as an ordinary
  // row rather than crashing or swapping in CoCo artwork.
  const stray = { ...session("c1", "Stray CoCo"), source: "coco" } as Summary;
  const list = renderSessionList([session("s1", "First"), stray], null, () => {});
  const rows = list.querySelectorAll(".session-row");
  assert.equal(rows.length, 2);
  assert.equal(list.querySelectorAll(".coco-session-mark").length, 0, "CoCo mark CSS class is retired");
  assert.equal(rows[0]!.querySelector(".session-light") !== null, true);
  assert.equal(rows[1]!.querySelector(".session-light") !== null, true);
});

test("trash click deletes without opening the row", () => {
  const opened: string[] = [];
  const deleted: string[] = [];
  const list = renderSessionList(
    SESSIONS,
    null,
    (s) => opened.push(s.id),
    (s) => deleted.push(s.id),
  );
  const trashes = list.querySelectorAll(".session-delete");
  assert.equal(trashes.length, 2, "one trash per row when onDelete is wired");
  const first = trashes[0] as HTMLElement;
  assert.equal(first.getAttribute("type"), "button");
  assert.match(first.getAttribute("aria-label") ?? "", /Delete session First/);
  assert.ok(first.querySelector("svg"), "lucide trash2 icon renders as svg");
  assert.equal(first.className, "session-delete", "square trash keeps its original component appearance");

  first.click();
  assert.deepEqual(deleted, ["s1"]);
  assert.deepEqual(opened, [], "stopPropagation keeps the row closed");

  // The row body itself still opens.
  (list.querySelectorAll(".session-row")[1] as HTMLElement).click();
  assert.deepEqual(opened, ["s2"]);
  assert.deepEqual(deleted, ["s1"], "row click does not delete");
});
