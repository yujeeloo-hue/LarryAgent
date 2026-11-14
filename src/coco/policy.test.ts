import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCocoPolicy } from "./policy.js";
import { siblingWorkspacePaths } from "./scope.js";
import type { CocoRule } from "./types.js";

test("Full permissions permits ordinary paths outside the working project but denies excluded and sibling projects", () => {
  const temp = mkdtempSync(join(tmpdir(), "coco-policy-")), root = join(temp,"project"), excluded = join(temp,"excluded"), sibling = join(temp,"sibling"); mkdirSync(root); mkdirSync(excluded); mkdirSync(sibling);
  symlinkSync(excluded,join(root,"excluded-alias")); writeFileSync(join(root,".env"),"test fixture");
  try {
    let valid = true; const policy = createCocoPolicy(root,[excluded,{path:sibling,code:"other_project"}],true,()=>valid,{fullAccess:true});
    policy.assertTool("write_file",{path:join(temp,"ordinary.txt"),content:"ok"});
    policy.assertTool("read_file",{path:join(root,".env")});
    policy.assertTool("run_shell",{command:"git status"});
    policy.assertTool("patch",{mode:"patch",patch:"*** Begin Patch"});
    for (const path of [join(excluded,"secret"),join(root,"excluded-alias","secret")]) assert.throws(()=>policy.assertPath(path),/excluded project/);
    assert.throws(()=>policy.assertTool("mcp__server__read",{input:{path:join(excluded,"file")}}),/excluded project/);
    for (const path of [join(sibling,"file"),join(sibling,"nested","file")]) assert.throws(()=>policy.assertPath(path),/another project/);
    assert.throws(()=>policy.assertTool("write_file",{path:join(sibling,"file"),content:"x"}),/another project/);
    assert.throws(()=>policy.assertTool("read_file",{path:join(sibling,"file")}),/another project/);
    assert.throws(()=>policy.assertTool("mcp__server__read",{input:{path:join(sibling,"file")}}),/another project/);
    assert.doesNotThrow(()=>policy.assertTool("dispatch_subagent",{}));
    valid=false; assert.throws(()=>policy.assertTool("run_shell",{command:"pwd"}),/revoked/);
  } finally { rmSync(temp,{recursive:true,force:true}); }
});
test("canonical project paths work when the configured root is a symlink",()=>{
  const temp=mkdtempSync(join(tmpdir(),"coco-alias-")), real=join(temp,"real"), alias=join(temp,"alias"); mkdirSync(real);symlinkSync(real,alias);
  try { const policy=createCocoPolicy(alias,[],true,()=>true);policy.assertPath(join(real,"new.txt"));assert.throws(()=>policy.assertPath(join(temp,"outside")),/outside project/); }
  finally{rmSync(temp,{recursive:true,force:true});}
});
test("an explicitly read-only task still cannot modify files", () => {
  const policy=createCocoPolicy(tmpdir(),[],false,()=>true,{fullAccess:true});
  assert.throws(()=>policy.assertTool("write_file",{path:join(tmpdir(),"new.txt"),content:"x"}),/read-only/);
});
test("siblingWorkspacePaths lists only in-scope sibling projects", () => {
  const workspaces = [{ id: "a", path: "/a" }, { id: "b", path: "/b" }, { id: "c", path: "/c" }, { id: "d", path: "/d" }];
  const settings = { excludedWorkspaceIds: ["d"] };
  const rule = { scope: { all: false, workspaceIds: ["a", "b"], excludedWorkspaceIds: [] } } as unknown as CocoRule;
  assert.deepEqual(siblingWorkspacePaths(workspaces, "a", settings), ["/b", "/c"]);
  assert.deepEqual(siblingWorkspacePaths(workspaces, "a", settings, [rule]), ["/b"]);
  assert.deepEqual(siblingWorkspacePaths(workspaces, "b", settings, [rule]), ["/a"]);
  assert.deepEqual(siblingWorkspacePaths(workspaces, "a", settings, [undefined]), []);
});
