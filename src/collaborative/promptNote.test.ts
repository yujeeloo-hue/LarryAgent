import assert from "node:assert/strict";
import test from "node:test";
import { configureCollaborativePort } from "./port.js";
import { buildCollaborativeNote, COLLABORATIVE_NOTE_HEADER, loadCollaborativeNote } from "./promptNote.js";
import type { CollaborativeRepository } from "../shared/collaborative.js";

const bound: CollaborativeRepository = {
  id: "repo1", name: "Game", root: "E:/Work/Game", kind: "git", materialized: ["Source/a.ts"],
  binding: { branch: "origin/feature-x", directory: "D:/Collab/Game", revision: "abc123", localBranch: "larry/collaborative/repo1" },
};

test("the collaborative note lists bound repositories only and stays independent of revision and materialized files", () => {
  assert.equal(buildCollaborativeNote([{ ...bound, binding: undefined } as CollaborativeRepository]), null);
  const note = buildCollaborativeNote([bound, { ...bound, id: "repo2", name: "Unbound", binding: undefined } as CollaborativeRepository])!;
  assert(note.startsWith(COLLABORATIVE_NOTE_HEADER));
  assert.match(note, /Game \(git, repositoryId repo1\) local E:\/Work\/Game · branch origin\/feature-x → checkout D:\/Collab\/Game, local branch larry\/collaborative\/repo1/);
  assert.doesNotMatch(note, /Unbound/);
  const advanced = buildCollaborativeNote([{ ...bound, materialized: [], binding: { ...bound.binding!, revision: "def456" } }]);
  assert.equal(advanced, note);
});

test("loading the note asks for bindings only and fails quietly", async () => {
  configureCollaborativePort(async request => {
    assert.equal(request.op, "bindings");
    return { repositories: [bound] };
  });
  assert.match((await loadCollaborativeNote("E:/Work/Game"))!, /checkout D:\/Collab\/Game/);
  configureCollaborativePort(async () => { throw new Error("no desktop"); });
  assert.equal(await loadCollaborativeNote("E:/Work/Game"), null);
});
