/**
 * DOM regression tests for the workspace row hover-action swap: a project
 * with no sessions left in the tree (empty, or fully archived) shows a
 * Delete button where Archive would be, and clicking it routes to the
 * delete handler (Archive keeps handling projects that own sessions).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";

const dom = parseHTML("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  document: dom.document,
  window: dom.window,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  Element: dom.Element,
  Node: dom.Node,
});

import type {
  SessionListItem,
  WorkspaceListItem,
} from "../navigation/types.js";
import { WorkspaceSectionView } from "./WorkspaceSectionView.js";

const emptyProject: WorkspaceListItem = {
  id: "w-empty",
  name: "Empty",
  path: "/tmp/Empty",
  updatedAt: 1,
};

const fullProject: WorkspaceListItem = {
  id: "w-full",
  name: "Full",
  path: "/tmp/Full",
  updatedAt: 2,
};

function session(
  id: string,
  workspaceId: string,
  extra: Partial<SessionListItem> = {},
): SessionListItem {
  return { id, title: id, updatedAt: 1, workspaceId, ...extra };
}

function renderView(
  view: WorkspaceSectionView,
  entries: ReadonlyArray<[string, readonly SessionListItem[]]>,
  cocoUnavailable = false,
): void {
  view.render({
    workspaces: entries.map(([id]) =>
      id === "w-empty" ? emptyProject : fullProject,
    ),
    sessionsByWorkspace: new Map(entries),
    focusedWorkspaceId: null,
    focusedSessionId: null,
    unreadSessionIds: new Set(),
    collapsedWorkspaceIds: new Set(),
    cocoUnavailable,
  });
}

function rowOf(view: WorkspaceSectionView, workspaceId: string): HTMLElement {
  const row = view.root.querySelector<HTMLElement>(
    `.workspace-group[data-workspace-id="${workspaceId}"] .workspace-row`,
  );
  assert.ok(row, `workspace row for ${workspaceId}`);
  return row;
}

test("Projects icon controls retain their original component paint", () => {
  const view = new WorkspaceSectionView();
  renderView(view, [["w-empty", []]]);

  const headerPlus = view.root.querySelector<HTMLButtonElement>(
    ".sidebar-section-add",
  );
  const workspacePlus = rowOf(view, "w-empty").querySelector<HTMLButtonElement>(
    ".workspace-row-add",
  );
  assert.ok(headerPlus);
  assert.ok(workspacePlus);
  const iconButtons = [...view.root.querySelectorAll<HTMLButtonElement>("button")]
    .filter((button) => button.querySelector("svg") && !button.textContent?.trim());
  for (const button of iconButtons) {
    for (const semanticClass of [
      "action-primary",
      "action-danger",
      "action-danger-list",
      "action-danger-icon",
    ]) {
      assert.equal(
        button.classList.contains(semanticClass),
        false,
        `${button.getAttribute("aria-label")} keeps original component classes`,
      );
    }
  }
  assert.equal(headerPlus.getAttribute("aria-label"), "New workspace");
  assert.equal(workspacePlus.getAttribute("aria-label"), "New session");
  assert.equal(workspacePlus.dataset.workspaceId, "w-empty");
});

test("empty project swaps the Archive hover action for Delete", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-empty", []]]);

  const row = rowOf(view, "w-empty");
  const deleteBtn = row.querySelector<HTMLButtonElement>(
    ".workspace-row-delete",
  );
  assert.ok(deleteBtn);
  assert.equal(deleteBtn.dataset.workspaceId, "w-empty");
  assert.equal(deleteBtn.title, "Delete workspace");
  assert.equal(deleteBtn.getAttribute("aria-label"), "Delete workspace");
  assert.equal(row.querySelector(".workspace-row-archive"), null);
  view.root.remove();
});

test("workspace disclosure keeps the original outline and session delete routes only deletion", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full")]]]);
  const arrow = view.root.querySelector(".workspace-row-icon-chevron svg");
  assert.equal(arrow?.getAttribute("fill"), "none");
  assert.equal(arrow?.getAttribute("stroke-width"), "1.75");
  assert.equal(arrow?.hasAttribute("data-functional-icon"), false);
  let deleted: string | undefined;
  let opened = false;
  view.onSessionDeleteClick(id => { deleted = id; });
  view.onSessionSelect(() => { opened = true; });
  const button = view.root.querySelector<HTMLButtonElement>(".session-row-delete");
  assert.ok(button);
  button.querySelector("path")!.dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(deleted, "s1");
  assert.equal(opened, false);
  view.root.remove();
});

test("project with sessions keeps the Archive action", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full")]]]);

  const row = rowOf(view, "w-full");
  const archiveBtn = row.querySelector<HTMLButtonElement>(
    ".workspace-row-archive",
  );
  assert.ok(archiveBtn);
  assert.equal(archiveBtn.dataset.workspaceId, "w-full");
  assert.equal(row.querySelector(".workspace-row-delete"), null);
  view.root.remove();
});

test("CoCo-created projects show the band provenance mark", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  view.render({
    workspaces: [
      { ...emptyProject, origin: "coco" },
      fullProject,
    ],
    sessionsByWorkspace: new Map([["w-empty", []], ["w-full", [session("s1", "w-full")]]]),
    focusedWorkspaceId: null,
    focusedSessionId: null,
    unreadSessionIds: new Set(),
    collapsedWorkspaceIds: new Set(),
    cocoUnavailable: false,
  });

  const mark = rowOf(view, "w-empty").querySelector<HTMLElement>(".workspace-row-coco-mark");
  assert.ok(mark, "coco-origin row carries the mark");
  assert.equal(mark.getAttribute("title"), "Created by CoCo");
  assert.ok(mark.querySelector("svg path"), "mark renders the band silhouette");
  assert.equal(rowOf(view, "w-full").querySelector(".workspace-row-coco-mark"), null, "user rows stay unmarked");
  view.root.remove();
});

test("row action flips Archive → Delete when the last session leaves", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full")]]]);
  assert.ok(rowOf(view, "w-full").querySelector(".workspace-row-archive"));

  // The project's only session got archived/deleted away: the patched-in
  // place row must now carry Delete (not a stale Archive button).
  renderView(view, [["w-full", []]]);
  const row = rowOf(view, "w-full");
  const deleteBtn = row.querySelector<HTMLButtonElement>(
    ".workspace-row-delete",
  );
  assert.ok(deleteBtn);
  assert.equal(deleteBtn.dataset.workspaceId, "w-full");
  assert.equal(row.querySelector(".workspace-row-archive"), null);

  // And back: a new session flips the row action to Archive again.
  renderView(view, [["w-full", [session("s2", "w-full")]]]);
  const archiveBtn = row.querySelector<HTMLButtonElement>(
    ".workspace-row-archive",
  );
  assert.ok(archiveBtn);
  assert.equal(archiveBtn.dataset.workspaceId, "w-full");
  assert.equal(row.querySelector(".workspace-row-delete"), null);
  view.root.remove();
});

test("delete button click routes to the delete handler with the id", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-empty", []]]);

  let deleted: string | undefined;
  let archived: string | undefined;
  view.onDeleteWorkspaceClick((id) => {
    deleted = id;
  });
  view.onArchiveWorkspaceClick((id) => {
    archived = id;
  });

  const deleteBtn = rowOf(view, "w-empty").querySelector<HTMLButtonElement>(
    ".workspace-row-delete",
  );
  assert.ok(deleteBtn);
  deleteBtn.click();
  assert.equal(deleted, "w-empty");
  assert.equal(archived, undefined);
  view.root.remove();
});

test("hand-over entry rides the session row and routes only the handover", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full")]]]);

  const row = view.root.querySelector<HTMLElement>(".session-row");
  assert.ok(row);
  assert.ok(row.classList.contains("has-coco-entry"));
  const handoverBtn = row.querySelector<HTMLButtonElement>(".session-row-coco");
  assert.ok(handoverBtn);
  assert.equal(handoverBtn.dataset.sessionId, "s1");
  assert.equal(handoverBtn.title, "Hand over to CoCo");
  assert.equal(handoverBtn.getAttribute("aria-label"), "Hand over to CoCo");
  assert.ok(handoverBtn.querySelector(".coco-mono-mark svg path"));

  let handed: string | undefined;
  let selected = false;
  view.onSessionCocoHandover((id) => {
    handed = id;
  });
  view.onSessionSelect(() => {
    selected = true;
  });
  handoverBtn
    .querySelector("svg path")!
    .dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(handed, "s1");
  assert.equal(selected, false);
  view.root.remove();
});

test("CoCo-managed rows switch to take-back; availability gates only hand-over", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [
    [
      "w-full",
      [
        session("s1", "w-full", { source: "coco" }),
        session("s2", "w-full"),
      ],
    ],
  ]);
  const rows = [...view.root.querySelectorAll<HTMLElement>(".session-row")];
  const cocoRow = rows.find((row) => row.dataset.sessionId === "s1");
  const plainRow = rows.find((row) => row.dataset.sessionId === "s2");
  assert.ok(cocoRow);
  assert.ok(plainRow);
  // Both modes ride the same slot (Delete keeps its shifted position).
  assert.equal(cocoRow.classList.contains("has-coco-entry"), true);
  assert.equal(plainRow.classList.contains("has-coco-entry"), true);
  const takeBackBtn = cocoRow.querySelector<HTMLButtonElement>(".session-row-coco");
  assert.ok(takeBackBtn);
  assert.equal(takeBackBtn.dataset.mode, "takeback");
  assert.equal(takeBackBtn.title, "Take back from CoCo");
  assert.ok(takeBackBtn.querySelector(".coco-takeback-mark svg path"), "return-arrow mark");
  const handoverBtn = plainRow.querySelector<HTMLButtonElement>(".session-row-coco");
  assert.ok(handoverBtn);
  assert.equal(handoverBtn.dataset.mode, "handover");
  assert.equal(handoverBtn.title, "Hand over to CoCo");
  assert.equal(handoverBtn.querySelector(".coco-takeback-mark"), null);

  // Engine unavailable: plain rows hide the hand-over entry, CoCo-managed
  // rows keep the take-back (reclaiming works with CoCo off).
  renderView(
    view,
    [["w-full", [session("s1", "w-full", { source: "coco" }), session("s2", "w-full")]]],
    true,
  );
  assert.equal(cocoRow.classList.contains("has-coco-entry"), true);
  assert.equal(plainRow.classList.contains("has-coco-entry"), false);

  // Source flips converge the patched-in-place rows between modes.
  renderView(view, [
    [
      "w-full",
      [
        session("s1", "w-full"),
        session("s2", "w-full", { source: "coco" }),
      ],
    ],
  ]);
  assert.equal(cocoRow.querySelector<HTMLButtonElement>(".session-row-coco")!.dataset.mode, "handover");
  assert.equal(cocoRow.querySelector(".coco-takeback-mark"), null);
  assert.equal(plainRow.querySelector<HTMLButtonElement>(".session-row-coco")!.dataset.mode, "takeback");
  view.root.remove();
});

test("take-back click routes only the take-back", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full", { source: "coco" })]]]);

  const takeBackBtn = view.root.querySelector<HTMLButtonElement>(".session-row-coco");
  assert.ok(takeBackBtn);
  let taken: string | undefined;
  let handed: string | undefined;
  let selected = false;
  view.onSessionCocoTakeBack((id) => {
    taken = id;
  });
  view.onSessionCocoHandover((id) => {
    handed = id;
  });
  view.onSessionSelect(() => {
    selected = true;
  });
  takeBackBtn
    .querySelector("svg path")!
    .dispatchEvent(new dom.window.Event("click", { bubbles: true }));
  assert.equal(taken, "s1");
  assert.equal(handed, undefined);
  assert.equal(selected, false);
  view.root.remove();
});

test("running rows keep the entry class for the spinner swap", () => {
  const view = new WorkspaceSectionView();
  dom.document.body.append(view.root);
  renderView(view, [["w-full", [session("s1", "w-full", { status: "running" })]]]);
  const row = view.root.querySelector<HTMLElement>(".session-row");
  assert.ok(row);
  assert.ok(row.classList.contains("is-running"));
  assert.ok(row.classList.contains("has-coco-entry"));
  assert.ok(row.querySelector(".session-running-spinner"));
  view.root.remove();
});
