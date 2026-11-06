/**
 * Default project filter rule: running session wins; else most recent
 * activity (max updatedAt); else the first project.
 *
 * Regression: the old fallback was the alphabetically-first project, so a
 * device with no running sessions opened on an arbitrary project instead of
 * the one the user last worked in.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { pickDefaultProject, pickDefaultSession } from "../src/defaultProject.js";
import type { SessionSummary } from "../src/types.js";

function session(overrides: Partial<SessionSummary> & { id: string; workspaceId: string }): SessionSummary {
  return {
    title: overrides.id,
    updatedAt: 0,
    status: "idle",
    progressText: "",
    type: "agent",
    messageCount: 0,
    archived: false,
    archivedAt: null,
    ...overrides,
  };
}

const PROJECTS = ["alpha", "beta", "gamma"];

test("a project with a running session wins over a more-recent idle one", () => {
  const list = [
    session({ id: "s1", workspaceId: "beta", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "alpha", status: "running", updatedAt: 50 }),
  ];
  assert.equal(pickDefaultProject(PROJECTS, list), "alpha");
});

test("no running → the project with the most recent session activity wins", () => {
  const list = [
    session({ id: "s1", workspaceId: "alpha", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "gamma", updatedAt: 300 }),
    session({ id: "s3", workspaceId: "beta", updatedAt: 200 }),
  ];
  assert.equal(pickDefaultProject(PROJECTS, list), "gamma");
});

test("multiple sessions in one project → the max updatedAt represents it", () => {
  const list = [
    session({ id: "s1", workspaceId: "beta", updatedAt: 500 }),
    session({ id: "s2", workspaceId: "beta", updatedAt: 100 }),
    session({ id: "s3", workspaceId: "gamma", updatedAt: 300 }),
  ];
  assert.equal(pickDefaultProject(PROJECTS, list), "beta");
});

test("activity in a workspace outside the project aggregate is ignored", () => {
  const list = [session({ id: "s1", workspaceId: "orphan", updatedAt: 900 })];
  // No running match, orphan recency not selectable → first project.
  assert.equal(pickDefaultProject(PROJECTS, list), "alpha");
});

test("no sessions at all → first project", () => {
  assert.equal(pickDefaultProject(PROJECTS, []), "alpha");
});

test("empty projects → null", () => {
  assert.equal(pickDefaultProject([], [session({ id: "s1", workspaceId: "alpha", updatedAt: 1 })]), null);
});

// ── pickDefaultSession ───────────────────────────────────────
// Selecting a device auto-opens the most recently interacted session; its
// project is the filter. Any status counts (running streams stay fresh on
// their own), archived never opens.

test("the most recently updated session wins regardless of status", () => {
  const list = [
    session({ id: "s1", workspaceId: "alpha", status: "running", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "gamma", status: "completed", updatedAt: 400 }),
    session({ id: "s3", workspaceId: "beta", status: "idle", updatedAt: 250 }),
  ];
  assert.equal(pickDefaultSession(list)?.id, "s2");
});

test("archived sessions never open", () => {
  const list = [
    session({ id: "s1", workspaceId: "alpha", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "gamma", updatedAt: 900, archived: true }),
  ];
  assert.equal(pickDefaultSession(list)?.id, "s1");
});

test("ties keep the earlier entry (newest-first list order)", () => {
  const list = [
    session({ id: "s1", workspaceId: "alpha", updatedAt: 300 }),
    session({ id: "s2", workspaceId: "gamma", updatedAt: 300 }),
  ];
  assert.equal(pickDefaultSession(list)?.id, "s1");
});

test("its workspaceId is the project to filter on", () => {
  const list = [session({ id: "s1", workspaceId: "gamma", updatedAt: 100 })];
  assert.equal(pickDefaultSession(list)?.workspaceId, "gamma");
});

test("no sessions → null (nothing to auto-open)", () => {
  assert.equal(pickDefaultSession([]), null);
});

test("a session in a registered project outranks a newer orphan project", () => {
  const list = [
    session({ id: "s1", workspaceId: "known", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "ghost", updatedAt: 900 }),
  ];
  // knownProjects comes from the same aggregate the sidebar shows.
  assert.equal(pickDefaultSession(list, ["known"])?.id, "s1");
});

test("all-orphan sessions → the most recent one still opens", () => {
  const list = [
    session({ id: "s1", workspaceId: "ghost-a", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "ghost-b", updatedAt: 900 }),
  ];
  assert.equal(pickDefaultSession(list, [])?.id, "s2");
});

test("no knownProjects info → every project counts as known", () => {
  const list = [
    session({ id: "s1", workspaceId: "a", updatedAt: 100 }),
    session({ id: "s2", workspaceId: "b", updatedAt: 900 }),
  ];
  assert.equal(pickDefaultSession(list)?.id, "s2");
});
