import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitHeadFact } from "./gitFacts.js";
test("HEAD facts support ordinary repositories, packed refs and linked worktrees", () => {
  const root = mkdtempSync(join(tmpdir(),"coco-git-")), main=join(root,"main"), worktree=join(root,"worktree");
  const commit="a".repeat(40); mkdirSync(join(main,".git","refs","heads"),{recursive:true}); mkdirSync(worktree);
  try {
    writeFileSync(join(main,".git","HEAD"),"ref: refs/heads/main\n"); writeFileSync(join(main,".git","refs","heads","main"),commit);
    assert.deepEqual(gitHeadFact(main),{commit,ref:"refs/heads/main"});
    mkdirSync(join(main,".git","worktrees","linked"),{recursive:true}); writeFileSync(join(worktree,".git"),`gitdir: ${join(main,".git","worktrees","linked")}\n`);
    writeFileSync(join(main,".git","worktrees","linked","commondir"),"../..\n"); writeFileSync(join(main,".git","worktrees","linked","HEAD"),"ref: refs/heads/linked\n");
    writeFileSync(join(main,".git","packed-refs"),`${commit} refs/heads/linked\n`);
    assert.deepEqual(gitHeadFact(worktree),{commit,ref:"refs/heads/linked"});
    writeFileSync(join(main,".git","HEAD"),"ref: refs/../../secret\n"); assert.equal(gitHeadFact(main),null);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
