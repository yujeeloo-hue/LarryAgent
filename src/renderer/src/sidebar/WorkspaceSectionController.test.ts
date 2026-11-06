/**
 * PROJECTS tree: loop/CoCo sessions are always listed.
 *
 * The header "Hide CoCo sessions" filter toggle was removed (user decision
 * 2026-10-30 — unnecessary feature). These tests pin that loop- and
 * coco-origin sessions stay in the tree with no filtering path left, and
 * that archived sessions still never appear.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  SessionListItem,
  WorkspaceListItem,
} from "../navigation/types.js";
import type { WorkspaceSectionRenderState } from "./WorkspaceSectionView.js";
import { WorkspaceSectionController } from "./WorkspaceSectionController.js";

class StubView {
  renderStates: WorkspaceSectionRenderState[] = [];

  onSessionSelect(): void {}
  onSessionArchiveClick(): void {}
  onSessionDeleteClick(): void {}
  onSessionCocoHandover(): void {}
  onSessionCocoTakeBack(): void {}
  onCreateWorkspaceClick(): void {}
  onArchivedProjectsClick(): void {}
  onSearchClick(): void {}
  onNewSessionClick(): void {}
  onRenameWorkspaceClick(): void {}
  onArchiveWorkspaceClick(): void {}
  onDeleteWorkspaceClick(): void {}
  onWorkspaceToggle(): void {}
  setArchivedCount(): void {}
  render(state: WorkspaceSectionRenderState): void {
    this.renderStates.push(state);
  }
}

const workspace: WorkspaceListItem = {
  id: "w1",
  name: "JellyBot",
  path: "/tmp/JellyBot",
  updatedAt: 1,
};

function session(
  id: string,
  updatedAt: number,
  extra?: Partial<SessionListItem>,
): SessionListItem {
  return { id, title: id, updatedAt, workspaceId: "w1", ...extra };
}

function visibleIds(view: StubView): string[] {
  const state = view.renderStates.at(-1);
  assert.ok(state);
  return (state.sessionsByWorkspace.get("w1") ?? []).map((s) => s.id);
}

test("loop and coco sessions always stay in the PROJECTS tree", () => {
  const view = new StubView();
  const controller = new WorkspaceSectionController(view as never);
  controller.setState({
    workspaces: [workspace],
    sessions: [
      session("app-1", 30),
      session("loop-1", 20, { source: "loop" }),
      session("coco-1", 15, { source: "coco" }),
      session("app-2", 10),
    ],
    focusedWorkspaceId: "w1",
    focusedSessionId: null,
  });
  assert.deepEqual(visibleIds(view), ["app-1", "loop-1", "coco-1", "app-2"]);

  // A later setState must keep them listed — no residual filter state.
  controller.setState({
    workspaces: [workspace],
    sessions: [
      session("loop-1", 21, { source: "loop" }),
      session("coco-1", 16, { source: "coco" }),
      session("app-1", 11),
    ],
    focusedWorkspaceId: "w1",
    focusedSessionId: null,
  });
  assert.deepEqual(visibleIds(view), ["loop-1", "coco-1", "app-1"]);
});

test("archived sessions still never appear in the PROJECTS tree", () => {
  const view = new StubView();
  const controller = new WorkspaceSectionController(view as never);
  controller.setState({
    workspaces: [workspace],
    sessions: [
      session("live-1", 30),
      session("arch-1", 25, { archived: true }),
      session("loop-arch-1", 20, { archived: true, source: "coco" }),
    ],
    focusedWorkspaceId: "w1",
    focusedSessionId: null,
  });
  assert.deepEqual(visibleIds(view), ["live-1"]);
});
